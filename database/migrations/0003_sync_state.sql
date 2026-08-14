-- ============================================================================
-- Fluxa — sync state and settlement evidence
--
-- Sprint 4 §7.5 "Synchronization". 0001 and 0002 describe what an invoice is
-- and who may read it; neither has anywhere to record *how far the indexer has
-- got*, and without that the sync mechanism can only stream live events and
-- loses every event that fires while it is down.
--
-- Four things are added, each for a failure this file is meant to prevent:
--
--   1. `sync_state` — a resumable cursor, fingerprinted against the contract
--      set it was built from. A cursor from a previous deployment is worse than
--      no cursor: it silently skips every event before its block.
--
--   2. Settlement evidence on `invoices`. `InvoiceSettled(invoiceId, merchant,
--      recipient, token, amountOut)` reports which asset the merchant actually
--      received and how much. 0001 has `settled_at` and the merchant's
--      *preferred* settlement_asset, but nowhere to put what was really paid
--      out — so a cross-asset settlement (the core product claim) could be
--      synced with its result discarded.
--
--   3. `log_index` on `payment_events`, and the uniqueness key widened to
--      (tx_hash, log_index). 0001 made tx_hash alone unique, which reads as
--      "one payment per transaction". That holds for a direct `payInvoice`
--      call and stops holding the moment anything batches two payments into
--      one transaction, where the second insert would be rejected as a
--      duplicate and the payment would be lost.
--
--   4. Two `service_role` functions that write a payment or a settlement as a
--      single transaction. The indexer must insert evidence *and* advance the
--      invoice; as two client round trips, a crash in between leaves either an
--      invoice marked PAID with no evidence, or evidence for an invoice that
--      still shows as unpaid. Both are visible in the UI as wrong money.
--
-- Run order: 0001, 0002, then this file.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Sync cursor
-- ---------------------------------------------------------------------------

create table sync_state (
  -- One row per (chain, contract set). Text rather than uuid so the key is
  -- legible in logs: 'coston2', 'localhost'.
  id                    text primary key check (char_length(id) between 1 and 64),
  chain_id              bigint not null check (chain_id > 0),

  -- Highest block whose events have all been applied. The next scan starts at
  -- last_processed_block + 1. Advanced only after a batch's writes succeed, so
  -- a crash re-scans a range rather than skipping one; every write the indexer
  -- makes is idempotent precisely so that re-scan is harmless.
  last_processed_block  bigint not null check (last_processed_block >= 0),

  -- Block the contracts were deployed at. A cursor may never be set below this:
  -- there is nothing to find, and starting lower means scanning the whole chain.
  deployed_at_block     bigint not null check (deployed_at_block >= 0),

  -- keccak256 of the lowercase contract addresses, sorted and joined by ','.
  -- If the contract set changes, this changes, and the indexer refuses to reuse
  -- the cursor. Redeploying and resuming from the old cursor would silently
  -- skip every event the new contracts emitted below that block.
  contract_fingerprint  text not null check (contract_fingerprint ~ '^0x[0-9a-f]{64}$'),

  -- Kept for operators: which addresses the fingerprint was computed from.
  contracts             jsonb not null,

  -- Observability. A cursor that has stopped advancing is the failure mode that
  -- otherwise looks exactly like "no payments today".
  last_run_at           timestamptz,
  last_error            text,
  events_applied        bigint not null default 0 check (events_applied >= 0),

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create trigger sync_state_updated_at
  before update on sync_state
  for each row execute function set_updated_at();

comment on table sync_state is
  'Indexer cursor. One row per chain + contract set; fingerprinted so a cursor from a previous deployment cannot be reused.';
comment on column sync_state.contract_fingerprint is
  'keccak256 of sorted lowercase contract addresses joined by ",". Guards against resuming a cursor that belongs to a different deployment.';

-- No client may read or write the cursor: it is operational state, not
-- customer data, and a client that could move it backwards would force a
-- full re-scan. service_role bypasses RLS and needs no policy.
alter table sync_state enable row level security;
revoke all on sync_state from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Settlement evidence on invoices
-- ---------------------------------------------------------------------------

alter table invoices
  add column settlement_tx_hash text check (
    settlement_tx_hash is null or settlement_tx_hash ~ '^0x[0-9a-f]{64}$'
  ),
  -- What the merchant actually received. May differ from token_symbol: the
  -- customer pays FXRP and the merchant takes USDT0, which is §3.10's claim.
  add column settled_token_symbol asset_symbol,
  add column settled_amount_units numeric(78, 0)
    check (settled_amount_units is null or settled_amount_units > 0),
  -- Where it went. FluxaSettlement lets a merchant nominate a payout address,
  -- so the recipient is not necessarily the merchant's own wallet.
  add column settled_to_address text check (
    settled_to_address is null or settled_to_address ~ '^0x[0-9a-f]{40}$'
  );

comment on column invoices.settled_amount_units is
  'Base units of settled_token_symbol delivered to the merchant, from InvoiceSettled.amountOut. Chain-reported; never client-writable.';

-- Deliberately NOT added to the authenticated GRANT lists in 0002. These are
-- chain evidence, so they stay service_role-only by omission — same reasoning
-- as payment_tx_hash.

-- ---------------------------------------------------------------------------
-- 3. Widen the payment_events uniqueness key
-- ---------------------------------------------------------------------------

alter table payment_events
  add column log_index integer not null default 0 check (log_index >= 0);

comment on column payment_events.log_index is
  'Position of the source log within its transaction. Part of the idempotency key: one transaction can carry more than one payment.';

-- (tx_hash) was the idempotency key; (tx_hash, log_index) is the correct one.
-- Dropped and replaced rather than left in place, because the narrower index
-- would keep rejecting the second payment in a batched transaction.
drop index if exists payment_events_tx_unique;

create unique index payment_events_tx_log_unique
  on payment_events (tx_hash, log_index)
  where tx_hash is not null;

-- ---------------------------------------------------------------------------
-- 4. Atomic writers
--
-- Both are SECURITY INVOKER on purpose. They exist for atomicity, not for
-- privilege: the caller must already be service_role. A SECURITY DEFINER
-- function here would hand any authenticated client the power to mark its own
-- invoice PAID, which is the one thing 0002 is arranged to prevent.
-- ---------------------------------------------------------------------------

-- Record one confirmed payment and advance its invoice, in a single statement.
--
-- Idempotent by (tx_hash, log_index): re-applying a block range — which the
-- cursor design makes routine — updates the existing evidence row instead of
-- inserting a second one.
--
-- The invoice update is guarded by status: an invoice already SETTLED is not
-- dragged back to PAID by a replayed event. That is the §5.12 rule expressed in
-- SQL — the chain is authoritative, and progress along the lifecycle is
-- monotonic.
create or replace function record_payment_event(
  p_invoice_id          uuid,
  p_rail                payment_rail,
  p_tx_hash             text,
  p_log_index           integer,
  p_block_number        bigint,
  p_amount_units        numeric,
  p_token_symbol        asset_symbol,
  p_payer_address       text,
  p_paid_at             timestamptz default now(),
  p_attestation_status  attestation_status default 'NOT_REQUIRED',
  p_attestation_type    text default null,
  p_voting_round_id     bigint default null
)
returns bigint
language plpgsql
as $$
declare
  v_event_id bigint;
begin
  insert into payment_events (
    invoice_id, rail, tx_hash, log_index, block_number,
    amount_units, token_symbol, payer_address,
    attestation_status, attestation_type, voting_round_id
  )
  values (
    p_invoice_id, p_rail, p_tx_hash, p_log_index, p_block_number,
    p_amount_units, p_token_symbol, p_payer_address,
    p_attestation_status, p_attestation_type, p_voting_round_id
  )
  on conflict (tx_hash, log_index) where tx_hash is not null
  do update set
    amount_units       = excluded.amount_units,
    payer_address      = excluded.payer_address,
    attestation_status = excluded.attestation_status,
    voting_round_id    = excluded.voting_round_id
  returning id into v_event_id;

  update invoices
     set status          = 'PAID',
         paid_at         = coalesce(paid_at, p_paid_at),
         payment_tx_hash = p_tx_hash
   where id = p_invoice_id
     -- Never walk the lifecycle backwards. SETTLED is downstream of PAID, and
     -- a replayed InvoicePaid must not undo a settlement.
     and status in ('DRAFT', 'OPEN', 'PENDING');

  return v_event_id;
end;
$$;

revoke all on function record_payment_event(
  uuid, payment_rail, text, integer, bigint, numeric, asset_symbol, text,
  timestamptz, attestation_status, text, bigint
) from public, anon, authenticated;

-- Record a settlement. Separate from the payment writer because settlement is
-- a distinct on-chain event on a *different contract* (FluxaSettlement), and
-- it carries the one figure the payment event cannot: what asset the merchant
-- actually ended up holding.
create or replace function record_settlement(
  p_invoice_id     uuid,
  p_tx_hash        text,
  p_token_symbol   asset_symbol,
  p_amount_units   numeric,
  p_to_address     text,
  p_settled_at     timestamptz default now()
)
returns void
language plpgsql
as $$
begin
  update invoices
     set status               = 'SETTLED',
         settled_at           = coalesce(settled_at, p_settled_at),
         settlement_tx_hash   = p_tx_hash,
         settled_token_symbol = p_token_symbol,
         settled_amount_units = p_amount_units,
         settled_to_address   = lower(p_to_address)
   where id = p_invoice_id
     -- CANCELLED and EXPIRED are terminal and cannot settle; reaching here with
     -- one of those means the off-chain record disagrees with the chain, and the
     -- chain wins — but it is worth not writing silently, so the caller checks
     -- the row count.
     and status in ('DRAFT', 'OPEN', 'PENDING', 'PAID', 'SETTLED');
end;
$$;

revoke all on function record_settlement(
  uuid, text, asset_symbol, numeric, text, timestamptz
) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- What this file intentionally does not do
--
-- 1. It does not give any client role access to sync_state or to the two
--    writers above. Everything here is service_role, driven by chain state.
--
-- 2. It does not add a settlement status distinct from invoice_status. The
--    lifecycle already ends at SETTLED and a second state machine would be a
--    second thing to keep in step with the contract's own enum.
--
-- 3. It does not store an XRPL sender address in a shaped column.
--    FluxaFdcPaymentRail reports `sourceAddressHash` — keccak of the r-address,
--    not the address — so payment_events.payer_address stays unconstrained and
--    holds the hash for Rail B. Recovering the r-address from a hash is not
--    possible, and pretending otherwise in a CHECK would be a lie about what
--    the chain told us.
-- ---------------------------------------------------------------------------
