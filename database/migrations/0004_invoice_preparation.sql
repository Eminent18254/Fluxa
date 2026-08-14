-- ===========================================================================
-- 0004 — Preparing an invoice for the chain
--
-- 0002 grants `authenticated` a deliberately narrow column list on `invoices`,
-- and two columns it withholds turn out to be needed before an invoice can be
-- published:
--
--   invoice_reference  the bytes32 the contract emits in InvoiceCreated, and
--                      the only link between an off-chain draft and its
--                      on-chain twin
--   token_amount       plus the price snapshot that 0001 requires alongside it
--
-- Both were withheld for good reasons. A blanket `grant update
-- (invoice_reference)` would let a merchant re-point a draft at a reference
-- another merchant is waiting on; a blanket grant on `token_amount` would let
-- one rewrite the amount of an invoice that has already been paid, which is the
-- number a dispute turns on.
--
-- A scoped function has neither problem. This one writes those columns only for
-- an invoice the caller owns, only while it is still a DRAFT, and generates the
-- reference itself rather than accepting one. The grant stays narrow and the
-- flow works.
--
-- Idempotent by design: called twice, it returns the reference it generated the
-- first time. A retry after a dropped response must not change the reference
-- once a transaction has been signed against it.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- prepare_invoice_for_chain
--
-- The merchant reads FTSO in the browser to quote the invoice, so the price and
-- the token amount arrive from the client. That is not a trust problem: the
-- chain is the authority on the amount, this copy is for display, and the
-- indexer compares the two on link and complains loudly if they disagree. What
-- the client cannot do through this function is touch a published invoice, an
-- invoice it does not own, or the reference of either.
--
-- SECURITY DEFINER, because it writes columns `authenticated` has no grant on.
-- The ownership and status checks below are what make that safe, so neither can
-- be removed without removing the DEFINER too.
-- ---------------------------------------------------------------------------

create or replace function prepare_invoice_for_chain(
  p_invoice_id      uuid,
  p_token_amount    numeric,
  p_token_symbol    asset_symbol,
  p_price_usd       numeric,
  p_price_decimals  smallint,
  p_price_timestamp timestamptz
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_merchant_id uuid;
  v_status      invoice_status;
  v_reference   text;
begin
  v_merchant_id := current_merchant_id();
  if v_merchant_id is null then
    raise exception 'no merchant record for the current user';
  end if;

  select status, invoice_reference
    into v_status, v_reference
    from invoices
   where id = p_invoice_id
     and merchant_id = v_merchant_id
     for update;

  -- Not found and not-yours are the same message on purpose. Distinguishing
  -- them tells a caller whether an id exists, which is the one fact the
  -- unguessable-id model depends on withholding.
  if not found then
    raise exception 'invoice % not found', p_invoice_id;
  end if;

  if v_status <> 'DRAFT' then
    raise exception
      'invoice % is %, not DRAFT. Its quote and reference are fixed once it is published.',
      p_invoice_id, v_status;
  end if;

  if p_token_amount is null or p_token_amount <= 0 then
    raise exception 'token_amount must be a positive integer count of base units';
  end if;

  -- 0001 refuses a token_amount without a complete snapshot, since a price
  -- without its per-feed exponent is not a price. Checked here so the caller
  -- gets a message naming the missing field rather than a trigger exception.
  if p_price_usd is null or p_price_decimals is null or p_price_timestamp is null then
    raise exception
      'a token_amount needs its FTSO snapshot: price_usd=%, price_decimals=%, price_timestamp=%',
      p_price_usd, p_price_decimals, p_price_timestamp;
  end if;

  -- Generated here, never accepted from the caller. Two v4 UUIDs are 256 bits
  -- from the server CSPRNG, which is the width of a bytes32 and the format the
  -- CHECK on this column wants: lowercase hex, 64 digits.
  if v_reference is null then
    v_reference := '0x'
      || replace(gen_random_uuid()::text, '-', '')
      || replace(gen_random_uuid()::text, '-', '');
  end if;

  update invoices
     set invoice_reference = v_reference,
         token_amount      = p_token_amount,
         token_symbol      = coalesce(p_token_symbol, token_symbol),
         price_usd         = p_price_usd,
         price_decimals    = p_price_decimals,
         price_timestamp   = p_price_timestamp
   where id = p_invoice_id;

  return v_reference;
end;
$$;

revoke all on function prepare_invoice_for_chain(
  uuid, numeric, asset_symbol, numeric, smallint, timestamptz
) from public;

grant execute on function prepare_invoice_for_chain(
  uuid, numeric, asset_symbol, numeric, smallint, timestamptz
) to authenticated;

comment on function prepare_invoice_for_chain(
  uuid, numeric, asset_symbol, numeric, smallint, timestamptz
) is
  'Stamps a DRAFT invoice with its payment reference and FTSO quote, and returns '
  'the reference to publish on-chain. Own invoices only, DRAFT only, idempotent.';

-- ---------------------------------------------------------------------------
-- invoice_by_reference
--
-- The indexer resolves an on-chain event to a row by its payment reference, and
-- does that with the service role, which needs no help. This function is for
-- the merchant side: after publishing, the browser holds a reference and wants
-- the row, and `select ... where invoice_reference = $1` under RLS already
-- works. So there is deliberately no function for that.
--
-- What does need saying is why `invoice_reference` is not in 0002 GRANT UPDATE
-- even now: the column is set once, by the function above, and never again.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- The price the payout was made at
--
-- FluxaSettlement emits SettlementPriceSnapshot alongside InvoiceSettled: the
-- FTSO read the payout was computed from. That is not the same number as
-- invoices.price_usd, which is the quote the merchant issued the invoice at,
-- possibly days earlier at a different price.
--
-- Writing the settlement price over the quote would destroy the one comparison
-- anybody wants to make, so it gets its own three columns. Value and exponent
-- together, as everywhere else — XRP/USD is 6 decimals and FLR/USD is 8, so a
-- bare integer is not a price.
--
-- Service-role only, by omission from the 0002 grant lists: this is payment
-- evidence and no client writes payment evidence.
-- ---------------------------------------------------------------------------

alter table invoices
  add column settlement_price_usd numeric(30, 0),
  add column settlement_price_decimals smallint
    check (settlement_price_decimals is null or settlement_price_decimals between 0 and 30),
  add column settlement_price_timestamp timestamptz;

comment on column invoices.settlement_price_usd is
  'FTSO price the payout was computed at, raw. Pair with settlement_price_decimals.';

-- ---------------------------------------------------------------------------
-- Settlement evidence on the public payment page
--
-- 0003 added settlement columns to `invoices`. `get_public_invoice` in 0002 has
-- an explicit column list, so those columns are invisible to a payer holding a
-- link. Two of them belong there: someone who paid an invoice should be able to
-- see that the merchant was paid out, and follow the transaction.
--
-- The return type changes, and Postgres will not let CREATE OR REPLACE alter a
-- function signature, so this drops and recreates. 0002 stays untouched on
-- disk; the migration order is what applies the newer definition.
-- ---------------------------------------------------------------------------

drop function if exists get_public_invoice(uuid);
create function get_public_invoice(p_invoice_id uuid)
returns table (
  id                  uuid,
  title               text,
  description         text,
  usd_amount          numeric,
  token_amount        numeric,
  token_symbol        asset_symbol,
  price_usd           numeric,
  price_decimals      smallint,
  price_timestamp     timestamptz,
  status              invoice_status,
  rail                payment_rail,
  due_at              timestamptz,
  paid_at             timestamptz,
  settled_at          timestamptz,
  invoice_reference   text,
  onchain_invoice_id  text,
  payment_tx_hash     text,
  settlement_tx_hash  text,
  discount_percent    numeric,
  total_with_discount numeric,
  merchant_name       text,
  merchant_address    text,
  settlement_asset    asset_symbol,
  created_at          timestamptz
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
    i.status, i.rail,
    i.due_at, i.paid_at, i.settled_at,
    i.invoice_reference, i.onchain_invoice_id,
    i.payment_tx_hash, i.settlement_tx_hash,
    i.discount_percent, i.total_with_discount,
    m.display_name,
    coalesce(m.settlement_address, m.wallet_address),
    m.settlement_asset,
    i.created_at
  from invoices i
  join merchants m on m.id = i.merchant_id
  where i.id = p_invoice_id
    -- Unchanged from 0002: drafts and cancelled invoices are not payable and
    -- stay private. The merchant email and internal ids stay out of the list.
    and i.status in ('OPEN', 'PENDING', 'PAID', 'SETTLED', 'EXPIRED');
$$;

revoke all on function get_public_invoice(uuid) from public;
grant execute on function get_public_invoice(uuid) to anon, authenticated;

comment on function get_public_invoice(uuid) is
  'One invoice by id for a payer holding a link. Returns at most one row and has '
  'no set-returning variant, so a link grants no listing of other invoices.';

-- ---------------------------------------------------------------------------
-- advance_sync_cursor
--
-- The indexer moves its cursor after a batch of writes has landed, and wants to
-- add that batch count to a running total in the same statement. PostgREST
-- cannot express `events_applied = events_applied + $1` — an update body is
-- values, not expressions — so the increment needs a function.
--
-- It is also the one place the monotonicity of the cursor can be enforced. The
-- greatest() below means a stale or out-of-order call cannot walk the cursor
-- backwards and cause the same range to be re-scanned forever.
--
-- SECURITY INVOKER, and revoked from every client role: only the service role
-- reaches it, because only something that watched the chain may claim to have
-- processed a block.
-- ---------------------------------------------------------------------------

create or replace function advance_sync_cursor(
  p_id             text,
  p_block          bigint,
  p_events_applied integer default 0,
  p_error          text default null
)
returns bigint
language plpgsql
as $$
declare
  v_block bigint;
begin
  update sync_state
     set last_processed_block = greatest(last_processed_block, p_block),
         events_applied       = events_applied + greatest(p_events_applied, 0),
         last_run_at          = now(),
         last_error           = p_error
   where id = p_id
  returning last_processed_block into v_block;

  if not found then
    raise exception 'no sync_state row with id %', p_id;
  end if;

  return v_block;
end;
$$;

revoke all on function advance_sync_cursor(text, bigint, integer, text)
  from public, anon, authenticated;

comment on function advance_sync_cursor(text, bigint, integer, text) is
  'Moves an indexer cursor forward and adds to its applied-event total. Never '
  'moves backwards. Service role only.';
