-- ==========================================================================
-- 0007 — Fluxa V2 multi-asset invoices
--
-- Existing rows remain V1. New rows default to V2 and name both the payment
-- assets a customer may choose and the token the merchant wants to receive.
-- C2FLR is intentionally absent: it is Coston2 gas, not an ERC-20 invoice asset.
-- ==========================================================================

alter table invoices
  add column contract_version smallint not null default 1
    check (contract_version in (1, 2)),
  add column accepted_payment_assets asset_symbol[],
  add column settlement_token_symbol asset_symbol;

alter table invoices
  drop constraint if exists invoices_onchain_invoice_id_key;

-- Earlier installs may not have made this column unique, while later ones may
-- have done so manually during rollout. Drop either possible single-column
-- index shape before adding the version-aware identity below.
drop index if exists invoices_onchain_invoice_id_key;
drop index if exists invoices_onchain_invoice_id_idx;

update invoices
   set accepted_payment_assets = array[token_symbol]::asset_symbol[],
       settlement_token_symbol = coalesce(settled_token_symbol, token_symbol)
 where accepted_payment_assets is null
    or settlement_token_symbol is null;

alter table invoices
  alter column accepted_payment_assets set not null,
  alter column settlement_token_symbol set not null,
  alter column contract_version set default 2,
  add constraint invoices_v2_payment_assets_check check (
    contract_version = 1
    or (
      cardinality(accepted_payment_assets) between 1 and 2
      and accepted_payment_assets <@ array['FXRP', 'USDT0']::asset_symbol[]
      and not (
        cardinality(accepted_payment_assets) = 2
        and accepted_payment_assets[1] = accepted_payment_assets[2]
      )
    )
  ),
  add constraint invoices_v2_settlement_asset_check check (
    contract_version = 1
    or settlement_token_symbol in ('FXRP', 'USDT0')
  );

-- V1 and V2 registries each start their own numeric invoice sequence at 1.
-- The pair is the identity; an id by itself becomes ambiguous as soon as V2 is
-- deployed. The indexer uses this same pair for every post-creation event.
create unique index invoices_contract_onchain_unique
  on invoices (contract_version, onchain_invoice_id)
  where onchain_invoice_id is not null;

comment on column invoices.contract_version is
  '1 = original single-token registry; 2 = multi-asset USD invoice registry.';
comment on column invoices.accepted_payment_assets is
  'ERC-20 assets the payer may choose. C2FLR is gas-only and never appears here.';
comment on column invoices.settlement_token_symbol is
  'Token the merchant requests at settlement; may differ from the selected payment token.';

-- Merchants own these invoice terms, under the existing own-row RLS policies.
-- Keep the original narrowed grant intact while allowing the two new term
-- columns to participate in an authenticated insert. PostgreSQL checks the
-- full inserted column set against one applicable privilege grant.
grant insert (
  merchant_id,
  customer_address,
  title,
  description,
  currency_code,
  usd_amount,
  token_symbol,
  status,
  due_at,
  rail,
  discount_percent,
  total_with_discount,
  accepted_payment_assets,
  settlement_token_symbol
) on invoices to authenticated;

grant update (
  customer_address,
  title,
  description,
  usd_amount,
  token_symbol,
  status,
  due_at,
  rail,
  discount_percent,
  total_with_discount,
  accepted_payment_assets,
  settlement_token_symbol
) on invoices to authenticated;

-- A V2 invoice is dynamically priced when the customer pays. Preparation only
-- creates the immutable reference that binds its database row to the chain.
create or replace function prepare_invoice_v2(p_invoice_id uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_merchant_id uuid;
  v_status invoice_status;
  v_version smallint;
  v_reference text;
begin
  v_merchant_id := current_merchant_id();
  if v_merchant_id is null then
    raise exception 'no merchant record for the current user';
  end if;

  select status, contract_version, invoice_reference
    into v_status, v_version, v_reference
    from invoices
   where id = p_invoice_id
     and merchant_id = v_merchant_id
   for update;

  if not found then raise exception 'invoice % not found', p_invoice_id; end if;
  if v_version <> 2 then raise exception 'invoice % is contract version %, not V2', p_invoice_id, v_version; end if;
  if v_status <> 'DRAFT' then raise exception 'invoice % is %, not DRAFT', p_invoice_id, v_status; end if;

  if v_reference is null then
    v_reference := '0x'
      || replace(gen_random_uuid()::text, '-', '')
      || replace(gen_random_uuid()::text, '-', '');
    update invoices set invoice_reference = v_reference where id = p_invoice_id;
  end if;
  return v_reference;
end;
$$;

revoke all on function prepare_invoice_v2(uuid) from public;
grant execute on function prepare_invoice_v2(uuid) to authenticated;

-- Recreate the public projection with V2 configuration included. The UUID in
-- the payment link remains the unguessable capability; there is still no list
-- function and anon still has no SELECT policy on invoices.
drop function if exists get_public_invoice(uuid);
create function get_public_invoice(p_invoice_id uuid)
returns table (
  id                         uuid,
  title                      text,
  description                text,
  usd_amount                 numeric,
  token_amount               numeric,
  token_symbol               asset_symbol,
  price_usd                  numeric,
  price_decimals             smallint,
  price_timestamp            timestamptz,
  contract_version           smallint,
  accepted_payment_assets    asset_symbol[],
  settlement_token_symbol    asset_symbol,
  status                     invoice_status,
  rail                       payment_rail,
  due_at                     timestamptz,
  paid_at                    timestamptz,
  settled_at                 timestamptz,
  invoice_reference          text,
  onchain_invoice_id         text,
  payment_tx_hash            text,
  settlement_tx_hash         text,
  discount_percent           numeric,
  total_with_discount        numeric,
  merchant_name              text,
  merchant_address           text,
  settlement_asset           asset_symbol,
  created_at                 timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    i.id, i.title, i.description,
    i.usd_amount, i.token_amount, i.token_symbol,
    i.price_usd, i.price_decimals, i.price_timestamp,
    i.contract_version, i.accepted_payment_assets, i.settlement_token_symbol,
    i.status, i.rail,
    i.due_at, i.paid_at, i.settled_at,
    i.invoice_reference, i.onchain_invoice_id,
    i.payment_tx_hash, i.settlement_tx_hash,
    i.discount_percent, i.total_with_discount,
    m.display_name,
    -- This is the wallet that created the on-chain invoice. It is intentionally
    -- not the optional payout address: the payer flow uses it to block the
    -- contract-forbidden merchant-pays-own-invoice case.
    m.wallet_address,
    i.settlement_token_symbol,
    i.created_at
  from invoices i
  join merchants m on m.id = i.merchant_id
  where i.id = p_invoice_id
    and i.status in ('OPEN', 'PENDING', 'PAID', 'SETTLED', 'EXPIRED');
$$;

revoke all on function get_public_invoice(uuid) from public;
grant execute on function get_public_invoice(uuid) to anon, authenticated;
