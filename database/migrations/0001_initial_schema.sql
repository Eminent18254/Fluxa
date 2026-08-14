-- ============================================================================
-- Fluxa — initial schema
--
-- Design rules this file follows, and why:
--
-- 1. The chain is the source of truth for money. This database is an index and
--    a convenience layer: it stores what an invoice *asks for* and what the
--    chain *reported*, never an independent opinion about a balance. Anything
--    reconcilable from Coston2 is stored with the tx hash that proves it.
--
-- 2. Token amounts are NUMERIC(78, 0) — integer base units, never float.
--    FXRP and USDT0 are 6-decimal (verified on-chain, see
--    docs/PHASE-0-FLARE-VALIDATION.md §2.1). A float would silently round a
--    payment; 78 digits covers uint256 in full so a value that fits on-chain
--    also fits here.
--
-- 3. USD figures are NUMERIC(20, 6) — a fixed 6dp scale, not money-typed and
--    not float. The invoice's USD amount is what the merchant typed; the token
--    amount is derived from it at payment time using FTSOv2.
--
-- 4. Every FTSO-derived price is stored with the feed's own decimal exponent
--    and the oracle timestamp. Exponents differ per feed (§2.2), so a price
--    without its exponent is not a price.
--
-- 5. Addresses and hashes are stored lowercase and CHECK-constrained on shape.
--    Mixed-case comparison bugs are a whole class of failure that a lowercase
--    invariant removes. EIP-55 checksums are a display concern.
--
-- Run order: 0001 (this file) then 0002_rls_policies.sql.
-- ============================================================================

-- gen_random_uuid(). Present by default on Supabase; declared for portability.
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

-- Invoice lifecycle. Terminal states: PAID, SETTLED, EXPIRED, CANCELLED.
--   DRAFT      merchant is still editing; not payable
--   OPEN       payable, awaiting funds
--   PENDING    funds observed but not yet final (Rail B: FDC round in flight)
--   PAID       payment confirmed against the chain
--   SETTLED    merchant received their chosen settlement asset
--   EXPIRED    due_at passed with no payment
--   CANCELLED  merchant withdrew it
create type invoice_status as enum (
  'DRAFT', 'OPEN', 'PENDING', 'PAID', 'SETTLED', 'EXPIRED', 'CANCELLED'
);

-- The two payment rails from §2.3 of the validation doc.
--   FLARE_ERC20  customer pays FXRP/USDT0 on Coston2; the contract observes
--                the transfer directly. No FDC — the transfer is already in
--                the verifying contract's own state.
--   XRPL_NATIVE  customer pays native XRP on the XRP Ledger; FDC attests it
--                and the Merkle proof is verified on Coston2.
create type payment_rail as enum ('FLARE_ERC20', 'XRPL_NATIVE');

-- Assets Fluxa accepts or settles in. XRP is XRPL-native (Rail B); FXRP and
-- USDT0 are Coston2 ERC-20s. All three are 6-decimal.
create type asset_symbol as enum ('FXRP', 'USDT0', 'XRP');

-- FDC attestation progress for Rail B. Mirrors the five-stage flow in §6.
create type attestation_status as enum (
  'NOT_REQUIRED', 'PREPARING', 'SUBMITTED', 'FINALIZED', 'VERIFIED', 'FAILED'
);

-- ---------------------------------------------------------------------------
-- merchants
--
-- Identity is a wallet address, not an email. auth_user_id links to Supabase
-- Auth once a wallet has proved ownership by signing a nonce; it is nullable so
-- a merchant row can exist before that link is made.
-- ---------------------------------------------------------------------------
create table merchants (
  id              uuid primary key default gen_random_uuid(),
  wallet_address  text not null unique
                  check (wallet_address ~ '^0x[0-9a-f]{40}$'),
  auth_user_id    uuid unique references auth.users (id) on delete set null,

  display_name    text check (char_length(display_name) between 1 and 120),
  email           text check (email is null or email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),

  -- Asset the merchant wants to be paid out in, regardless of what the
  -- customer paid. Drives the FTSO-priced conversion in §6.18.
  settlement_asset  asset_symbol not null default 'USDT0',
  -- Payout destination on Coston2. Defaults to wallet_address when null.
  settlement_address text check (
    settlement_address is null or settlement_address ~ '^0x[0-9a-f]{40}$'
  ),

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on table merchants is
  'Invoice issuers. Identified by Coston2 wallet address, lowercase.';
comment on column merchants.settlement_asset is
  'Payout asset. Conversion from the paid asset is priced by FTSOv2 on-chain.';

-- ---------------------------------------------------------------------------
-- invoices
--
-- Money on this table:
--   usd_amount        the merchant's price, what the customer sees (NUMERIC)
--   token_amount      base units, NOT a float; derived from usd via FTSOv2
--   price_usd         the live FTSOv2 rate used for the derivation
--   price_decimals    that feed's exponent — differs per feed, must be stored
--
-- Payable by any wallet (we are an invoicing app, not a marketplace where a
-- specific wallet pays). The contract is the authority on whether a payment
-- satisfies the amount, so `paid_amount_units` is informational: the truth
-- lives in the on-chain invoice registry, of which payment_tx_hash is proof.
--
-- Rail B needs the XRPL destination tag at creation time, which is derived
-- from the invoice id. invoice_reference is the on-chain standard payment
-- reference (32 bytes) binding the two rails together.
-- ---------------------------------------------------------------------------
create table invoices (
  id                    uuid primary key default gen_random_uuid(),
  merchant_id           uuid not null references merchants (id) on delete cascade,

  -- The merchant's customer: any wallet on Coston2.
  customer_address      text check (
    customer_address is null or customer_address ~ '^0x[0-9a-f]{40}$'
  ),

  -- Human facts
  title                 text not null check (char_length(title) between 1 and 200),
  description           text check (description is null or char_length(description) <= 5000),
  currency_code         text not null default 'USD' check (currency_code = upper(currency_code)),

  -- Money. usd_amount is NUMERIC(20,6), token_amount is base units.
  usd_amount            numeric(20, 6) not null check (usd_amount > 0),
  -- NULL until first payment attempt: set from usd_amount * (1 / FTSO price)
  -- at the first price snapshot, then frozen. All derived amounts are
  -- computed from this snapshot, so what the customer quotes at payment time
  -- is what the merchant quoted.
  token_amount          numeric(78, 0),
  token_symbol          asset_symbol not null,

  -- The FTSO snapshot that produced token_amount. Required once token_amount
  -- is set; price_usd is the raw oracle value, NOT already divided, and
  -- price_decimals is that feed's exponent (§2.2: 6 for XRP/USD, 8 for FLR/USD).
  price_usd             numeric(30, 0),
  price_decimals        smallint check (price_decimals between 0 and 30),
  price_timestamp       timestamptz,

  -- Lifecycle
  status                invoice_status not null default 'DRAFT',
  due_at                timestamptz not null,
  paid_at               timestamptz,
  settled_at            timestamptz,
  expires_at            timestamptz,     -- when status flips to EXPIRED

  -- Proof from the chain. The contract is the source of truth; these columns
  -- let the app and the customer verify without re-reading every block.
  invoice_reference     text unique check (
    invoice_reference is null or invoice_reference ~ '^0x[0-9a-f]{64}$'
  ),
  onchain_invoice_id    text check (
    onchain_invoice_id is null or onchain_invoice_id ~ '^[0-9]+$'
  ),
  payment_tx_hash       text check (
    payment_tx_hash is null or payment_tx_hash ~ '^0x[0-9a-f]{64}$'
  ),
  rail                  payment_rail not null default 'FLARE_ERC20',

  -- Billing
  discount_percent      numeric(5, 2) not null default 0
                        check (discount_percent between 0 and 100),
  total_with_discount   numeric(20, 6)
                        check (total_with_discount is null or total_with_discount > 0),

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index invoices_merchant_status_idx
  on invoices (merchant_id, status);
create index invoices_customer_idx
  on invoices (customer_address);
create index invoices_due_at_idx
  on invoices (due_at);

comment on column invoices.usd_amount is
  'The merchant''s price in USD. NUMERIC, not float.';
comment on column invoices.token_amount is
  'Base units of token_symbol the customer must pay. Frozen at first FTSO snapshot.';
comment on column invoices.price_usd is
  'Raw FTSOv2 value (value field, e.g. 1005087 for XRP/USD at 6dp) — divide by 10^price_decimals to get the price in USD.';
comment on column invoices.invoice_reference is
  '32-byte standard payment reference on the Flare contract, also carried as the XRPL memo in Rail B.';

-- ---------------------------------------------------------------------------
-- payment_events — everything the chain told us about one payment.
--
-- Append-only: each FDC round, transfer, or confirmation appends a row. The
-- invoice's own status is the summary; this table is the evidence trail.
-- ---------------------------------------------------------------------------
create table payment_events (
  id               bigint generated always as identity primary key,
  invoice_id       uuid not null references invoices (id) on delete cascade,

  rail             payment_rail not null,
  tx_hash          text check (tx_hash is null or tx_hash ~ '^0x[0-9a-f]{64}$'),
  block_number     bigint check (block_number is null or block_number > 0),

  -- What arrived, in base units. Not a float.
  amount_units     numeric(78, 0) not null check (amount_units > 0),
  token_symbol     asset_symbol not null,

  -- Payer identity. Coston2 addresses are 0x-hex; XRPL accounts are base58.
  -- The rails disagree on shape, so this is deliberately unconstrained.
  payer_address    text not null,

  -- FDC fields, Rail B only. NOT_REQUIRED for FLARE_ERC20 — Rail A needs no
  -- attestation because the transfer is already in the verifier's own state.
  attestation_status attestation_status not null default 'NOT_REQUIRED',
  attestation_type   text,
  voting_round_id    bigint check (voting_round_id is null or voting_round_id > 0),
  attestation_request_id text check (
    attestation_request_id is null or attestation_request_id ~ '^0x[0-9a-f]+$'
  ),

  created_at       timestamptz not null default now()
);

-- One on-chain transaction must never become two rows. Partial, so rows
-- recorded before a hash is known do not collide with each other.
create unique index payment_events_tx_unique
  on payment_events (tx_hash)
  where tx_hash is not null;

create index payment_events_invoice_idx
  on payment_events (invoice_id, created_at desc);

comment on table payment_events is
  'Append-only evidence trail of payments as reported by Coston2 and FDC. The chain remains the source of truth; this is a queryable projection of it.';

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------

create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger merchants_updated_at
  before update on merchants
  for each row execute function set_updated_at();

create trigger invoices_updated_at
  before update on invoices
  for each row execute function set_updated_at();

-- A priced invoice must carry the full FTSO snapshot. Enforced as a trigger
-- rather than a CHECK so the message names the missing piece.
create or replace function invoices_require_price_snapshot()
returns trigger
language plpgsql
as $$
begin
  if new.token_amount is not null and (
       new.price_usd is null
    or new.price_decimals is null
    or new.price_timestamp is null
  ) then
    raise exception
      'invoice %: token_amount is set but the FTSO snapshot is incomplete '
      '(price_usd=%, price_decimals=%, price_timestamp=%). A price without '
      'its per-feed exponent is not a price.',
      new.id, new.price_usd, new.price_decimals, new.price_timestamp;
  end if;
  return new;
end;
$$;

create trigger invoices_price_snapshot_complete
  before insert or update on invoices
  for each row execute function invoices_require_price_snapshot();


