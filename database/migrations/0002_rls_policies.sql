-- ============================================================================
-- Fluxa — Row Level Security
--
-- The access problem this file solves is specific to invoicing: a merchant's
-- invoice list is private, but any individual invoice must be readable by
-- whoever holds its link, including someone with no account at all. Those two
-- requirements pull in opposite directions, so they are separated explicitly
-- rather than blurred into one permissive policy.
--
-- Roles, as Supabase defines them:
--   anon           an unauthenticated visitor (the person paying an invoice)
--   authenticated  a signed-in merchant
--   service_role   the backend. BYPASSES RLS entirely — never ship this key to
--                  the browser. Payment confirmation runs here, because a
--                  client must not be able to mark its own invoice PAID.
--
-- Identity: a merchant is a wallet address. After a wallet signs a login nonce,
-- the app links it to a Supabase Auth user, so auth.uid() is the handle RLS
-- uses. current_merchant_id() resolves it to a merchants.id once per query.
--
-- The rule that matters most: NOTHING here lets a client write a payment or a
-- status. Money-affecting transitions are service_role only, because the
-- authority for them is Coston2, not the browser.
-- ============================================================================

alter table merchants      enable row level security;
alter table invoices       enable row level security;
alter table payment_events enable row level security;

-- Deny by default: with RLS on and no matching policy, access is refused.
-- Every grant below is therefore additive and auditable in isolation.

-- ---------------------------------------------------------------------------
-- Helper: the merchant row belonging to the current session, or NULL.
--
-- SECURITY DEFINER so it can read merchants while merchants itself is under
-- RLS, avoiding the recursion of a policy that queries its own table.
-- search_path is pinned — a SECURITY DEFINER function with a mutable
-- search_path is a privilege-escalation vector.
-- ---------------------------------------------------------------------------
create or replace function current_merchant_id()
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select id from merchants where auth_user_id = auth.uid();
$$;

revoke all on function current_merchant_id() from public;
grant execute on function current_merchant_id() to authenticated;

-- ---------------------------------------------------------------------------
-- merchants
-- ---------------------------------------------------------------------------

-- A merchant reads and edits exactly their own row.
create policy merchants_select_own
  on merchants for select
  to authenticated
  using (auth_user_id = auth.uid());

create policy merchants_update_own
  on merchants for update
  to authenticated
  using (auth_user_id = auth.uid())
  with check (auth_user_id = auth.uid());

-- Self-registration: a signed-in user may create their own merchant row and
-- no one else's. The WITH CHECK is what prevents claiming another wallet.
create policy merchants_insert_self
  on merchants for insert
  to authenticated
  with check (auth_user_id = auth.uid());

-- No delete policy. Deleting a merchant cascades to invoices and their payment
-- evidence; that is a support operation, not a client one.

-- ---------------------------------------------------------------------------
-- invoices
-- ---------------------------------------------------------------------------

-- Merchant: full read of their own invoices, including drafts.
create policy invoices_select_own
  on invoices for select
  to authenticated
  using (merchant_id = current_merchant_id());

-- There is deliberately NO anon SELECT policy on invoices.
--
-- The obvious way to make payment links work is a policy like
--   using (status in ('OPEN', 'PENDING', 'PAID', ...))
-- and it is wrong. A USING clause is a row filter, not a required predicate:
-- it cannot compel the client to name an id. With that policy in place,
-- `select * from invoices` as anon returns every open invoice in the system —
-- every merchant's amounts, customers and titles. RLS has no way to say "you
-- may read this row, but only if you asked for it specifically".
--
-- So public access goes through get_public_invoice() below, which takes an id
-- and returns at most one row. See the bottom of this file.

-- Merchant creates their own invoices. Cannot insert on another merchant's
-- behalf, and cannot create one that is already paid.
create policy invoices_insert_own
  on invoices for insert
  to authenticated
  with check (
    merchant_id = current_merchant_id()
    and status in ('DRAFT', 'OPEN')
    and paid_at is null
    and settled_at is null
    and payment_tx_hash is null
  );

-- Merchant edits their own invoice only while it is still editable, and may
-- only move it between the states a merchant legitimately controls. Everything
-- money-related is absent from this list on purpose: a client cannot set
-- status to PAID, cannot write payment_tx_hash, and cannot backdate paid_at.
-- Those transitions belong to service_role, which acts on chain evidence.
create policy invoices_update_own_editable
  on invoices for update
  to authenticated
  using (
    merchant_id = current_merchant_id()
    and status in ('DRAFT', 'OPEN')
  )
  with check (
    merchant_id = current_merchant_id()
    and status in ('DRAFT', 'OPEN', 'CANCELLED')
  );

-- Merchant deletes only a draft. Once an invoice has been sent it is a record.
create policy invoices_delete_draft
  on invoices for delete
  to authenticated
  using (
    merchant_id = current_merchant_id()
    and status = 'DRAFT'
  );

-- ---------------------------------------------------------------------------
-- Column-level grants on invoices
--
-- RLS filters rows, not columns. The UPDATE policy above restricts *which*
-- invoices a merchant may touch, but on a row it does allow, RLS alone would
-- happily let the client rewrite payment_tx_hash, paid_at, or token_amount.
-- WITH CHECK cannot express "this column may not change" — it only sees the
-- resulting row, and a merchant writing payment_tx_hash on their own OPEN
-- invoice produces a row that satisfies every predicate above.
--
-- Column privileges are the mechanism that actually closes this. UPDATE is
-- revoked wholesale and re-granted only on the fields a merchant owns.
-- Anything settlement- or evidence-related is absent, so a forged payment is
-- rejected by the grant system before RLS is consulted.
-- ---------------------------------------------------------------------------

revoke update on invoices from authenticated;

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
  total_with_discount
) on invoices to authenticated;

-- Deliberately NOT granted: token_amount, price_usd, price_decimals,
-- price_timestamp (FTSO snapshot — set server-side from a live oracle read),
-- paid_at, settled_at, invoice_reference, onchain_invoice_id, payment_tx_hash
-- (chain evidence), merchant_id (reassignment), id, created_at, updated_at.

-- INSERT is likewise narrowed: a client supplies the invoice's terms, never
-- its outcome. Columns omitted here fall back to their defaults.
revoke insert on invoices from authenticated;

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
  total_with_discount
) on invoices to authenticated;

-- ---------------------------------------------------------------------------
-- payment_events
--
-- Read-only to every client. There is no INSERT, UPDATE or DELETE policy for
-- anon or authenticated, and that is the point: a payment record is created
-- only by the backend after it has verified the payment against Coston2 —
-- by observing the ERC-20 transfer (Rail A) or by verifying an FDC Merkle
-- proof (Rail B). service_role bypasses RLS, so it needs no policy here.
--
-- If a client could insert into this table, it could manufacture proof of a
-- payment that never happened, which is the one failure this whole design is
-- arranged to prevent.
-- ---------------------------------------------------------------------------

create policy payment_events_select_own_merchant
  on payment_events for select
  to authenticated
  using (
    invoice_id in (
      select id from invoices where merchant_id = current_merchant_id()
    )
  );

-- The payer needs to see their own payment land, but the same enumeration
-- problem applies here as on invoices: a status-based USING clause would let
-- anon read every payment event in the system. Public access to payment
-- history goes through get_public_invoice_events() below.

revoke insert, update, delete on payment_events from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Public payment-link access
--
-- A payment link must work for someone with no account. The id in the URL is
-- the credential — a v4 UUID, unguessable, exactly the model every payment
-- link uses. What must NOT happen is that holding one id grants a listing of
-- all the others, which is what a permissive anon SELECT policy would allow.
--
-- These functions take an id and return at most one invoice. There is no
-- variant that returns a set, so there is nothing to enumerate. SECURITY
-- DEFINER lets them read past RLS; the narrow signature is the control.
--
-- The column list is explicit and deliberately partial: a payer needs to know
-- what to pay, to whom, and whether it landed. They do not need the merchant's
-- email or internal ids.
-- ---------------------------------------------------------------------------

create or replace function get_public_invoice(p_invoice_id uuid)
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
  invoice_reference   text,
  onchain_invoice_id  text,
  payment_tx_hash     text,
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
    i.due_at, i.paid_at,
    i.invoice_reference, i.onchain_invoice_id, i.payment_tx_hash,
    i.discount_percent, i.total_with_discount,
    m.display_name,
    coalesce(m.settlement_address, m.wallet_address),
    m.settlement_asset,
    i.created_at
  from invoices i
  join merchants m on m.id = i.merchant_id
  where i.id = p_invoice_id
    -- Drafts and cancelled invoices are not payable and stay private.
    and i.status in ('OPEN', 'PENDING', 'PAID', 'SETTLED', 'EXPIRED');
$$;

revoke all on function get_public_invoice(uuid) from public;
grant execute on function get_public_invoice(uuid) to anon, authenticated;

-- Payment evidence for one invoice, same access model.
create or replace function get_public_invoice_events(p_invoice_id uuid)
returns table (
  rail               payment_rail,
  tx_hash            text,
  block_number       bigint,
  amount_units       numeric,
  token_symbol       asset_symbol,
  payer_address      text,
  attestation_status attestation_status,
  voting_round_id    bigint,
  created_at         timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    e.rail, e.tx_hash, e.block_number,
    e.amount_units, e.token_symbol, e.payer_address,
    e.attestation_status, e.voting_round_id, e.created_at
  from payment_events e
  join invoices i on i.id = e.invoice_id
  where e.invoice_id = p_invoice_id
    and i.status in ('OPEN', 'PENDING', 'PAID', 'SETTLED', 'EXPIRED')
  order by e.created_at desc;
$$;

revoke all on function get_public_invoice_events(uuid) from public;
grant execute on function get_public_invoice_events(uuid) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- What this file intentionally does not do
--
-- 1. It does not authenticate wallets. Linking a signature to auth.users is
--    application work; RLS only consumes the result via auth.uid().
--
-- 2. It does not give anon a SELECT policy on any table. Public payment links
--    work through get_public_invoice(id), which returns at most one row, so
--    holding one invoice id never yields a listing of the others. A
--    status-based USING clause would have — that is the trap this avoids.
--
-- 3. It does not let any client role write payment evidence or a paid status.
--    Every such transition is service_role, driven by chain state.
-- ---------------------------------------------------------------------------

