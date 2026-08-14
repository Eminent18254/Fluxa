# Database

Postgres schema for Fluxa, written for Supabase.

```
migrations/
  0001_initial_schema.sql       tables, enums, triggers
  0002_rls_policies.sql         row level security, column grants, access functions
  0003_sync_state.sql           indexer cursor, settlement evidence, atomic writers
  0004_invoice_preparation.sql  prepare-for-chain, settlement price, public-page fields
scripts/
  checkSchema.mjs               structural consistency check
```

Apply in order: each builds on what came before. `0002` needs `0001`'s tables;
`0003` widens them for the indexer; `0004` recreates a function `0002` first
defined. On Supabase, paste each into the SQL editor or run through the CLI.

```bash
node database/scripts/checkSchema.mjs
```

## What the chain owns and what this owns

Coston2 is the source of truth for money. This database stores what an invoice
*asks for* and what the chain *reported* — never an independent opinion about a
balance. Every payment row carries the transaction hash that proves it, so any
figure here is reconcilable against the explorer.

## Three decisions worth knowing

**Amounts are integers, never floats.** Token amounts are `NUMERIC(78, 0)` —
base units, with 78 digits covering uint256 in full. FXRP and USDT0 are
6-decimal, confirmed on-chain in [Phase 0](../docs/PHASE-0-FLARE-VALIDATION.md).
A `float` would silently round a payment. `checkSchema.mjs` fails the build if a
column matching `*amount*` or `*units*` is anything but `NUMERIC`.

**A price is stored with its exponent.** FTSOv2 returns `(value, decimals,
timestamp)` and the decimals differ per feed — XRP/USD reports 6, FLR/USD
reports 8. So `price_usd` holds the raw oracle value and `price_decimals` holds
that feed's exponent; a trigger rejects any invoice with a `token_amount` but an
incomplete snapshot. A price without its exponent is not a price.

**No client role can write payment evidence.** A merchant may edit their
invoice's terms. They cannot set `status` to `PAID`, write `payment_tx_hash`, or
touch the FTSO snapshot — those columns are excluded from the `GRANT UPDATE`
column list, so the grant system rejects the write before RLS is consulted.
Payment confirmation runs as `service_role`, acting on chain evidence: an
observed ERC-20 transfer (Rail A) or a verified FDC Merkle proof (Rail B). The
settlement columns `0003` and `0004` added — what asset the merchant actually
received, and the price the payout was computed at — are withheld the same way, by
omission from the grant list.

RLS alone would not have been enough for that last one. `WITH CHECK` only sees
the resulting row, and a merchant writing `payment_tx_hash` on their own `OPEN`
invoice produces a row that satisfies every predicate. Column privileges are
what actually close it.

## Publishing an invoice

Two withheld columns are needed before an invoice can go on-chain: its
`invoice_reference` (the `bytes32` the contract emits in `InvoiceCreated`, and the
only link between an off-chain draft and its on-chain twin) and `token_amount`
with its price snapshot. Granting them outright would let a merchant re-point a
draft at a reference another merchant is waiting on, or rewrite the amount of an
invoice already paid — the number a dispute turns on.

`prepare_invoice_for_chain` (`0004`) is the scoped alternative. It is `SECURITY
DEFINER`, so it writes columns `authenticated` has no grant on — but only for an
invoice the caller owns, only while it is still `DRAFT`, and it generates the
reference itself rather than accepting one. Called twice it returns the reference
from the first call, so a retry after a dropped response never changes a reference
a transaction was already signed against. It is the one client-callable function
that writes those columns; the ownership and status checks are what make the
`DEFINER` safe, so neither can be removed without removing it too.

## The indexer's side

Everything above is what a client sees. The other writer is the indexer under
`services/`, which follows the chain as `service_role` and records what it finds.
`0003` and `0004` give it three things.

**A cursor it can resume from.** `sync_state` holds one row per chain and contract
set: the highest block whose events have all been applied, advanced only *after* a
batch's writes land. A crash re-scans a range rather than stepping over it — safe
only because every write is idempotent. The row is fingerprinted (`keccak256` of
the sorted, lowercased contract addresses), so a cursor from a previous deployment
is refused rather than used to skip history, and `advance_sync_cursor` moves it
with `greatest()` so a stale or out-of-order call can never walk it backwards. No
client role can read or write it — it is operational state, not customer data.

**Idempotent payment evidence.** `payment_events` is append-only, keyed on
`(tx_hash, log_index)`. `0001` keyed on `tx_hash` alone, which quietly means "one
payment per transaction" and rejects the second the moment a transaction carries
two. `record_payment_event` inserts the evidence and advances the invoice to
`PAID` in a single statement; re-applying a block range — routine, given the
cursor design — updates the existing row through `ON CONFLICT` instead of
inserting a duplicate, and the invoice update is status-guarded so a replayed
event never drags a `SETTLED` invoice back to `PAID`.

**Atomic settlement.** `record_settlement` writes the settlement evidence and
moves the invoice to `SETTLED` together, off a different contract's event
(`FluxaSettlement`). Both writers are `SECURITY INVOKER` on purpose: they exist
for atomicity, not privilege, and the caller must already be `service_role`. A
`SECURITY DEFINER` function here would hand any authenticated client the power to
mark its own invoice `PAID` — the one thing the column grants are arranged to
prevent.

## Public payment links

An invoice link has to work for someone with no account, which is the awkward
requirement in the whole design. The tempting policy is:

```sql
create policy invoices_select_public on invoices for select to anon
  using (status in ('OPEN', 'PAID', ...));   -- do not do this
```

That is an enumeration hole. `USING` is a row *filter*, not a required
predicate — it cannot compel the client to name an id. With that policy, `select
* from invoices` as `anon` returns every open invoice in the system: every
merchant's amounts, customers and titles.

So there is no `anon` SELECT policy on any table. Public access goes through
`get_public_invoice(uuid)` and `get_public_invoice_events(uuid)`, which take an
id and return at most one invoice. There is no variant returning a set, so there
is nothing to enumerate. The UUID in the URL is the credential — the same model
as any payment link — but holding one never yields the others.

`0004` widened `get_public_invoice` to carry settlement evidence, so a payer can
see the merchant was paid out and follow that transaction too. The shape is
unchanged: one id in, at most one row out. (Widening the return type is why `0004`
drops and recreates the function — Postgres will not let `CREATE OR REPLACE` alter
a signature. `0002` stays untouched on disk; the run order applies the newer one.)

## Roles

| Role | Can do |
| --- | --- |
| `anon` | call `get_public_invoice(id)` and its events function; nothing else |
| `authenticated` | read/write own merchant row and own invoices within the granted columns; call `prepare_invoice_for_chain` to stamp a draft's reference and quote |
| `service_role` | everything — **bypasses RLS**. Runs the indexer: the `sync_state` cursor and the `record_payment_event` / `record_settlement` / `advance_sync_cursor` writers. Backend only; never ship this key to the browser |

## Limits of the check script

`checkSchema.mjs` is not a Postgres parser. It catches unbalanced delimiters,
dangling foreign keys, enum literals that are not members of their type,
policies on tables without RLS, and grants naming columns that do not exist.

It reads each statement, not the resulting state, so it does not follow a `DROP`:
`0003` replaces the `payment_events` uniqueness index and `0004` recreates
`get_public_invoice`, and the script still lists the superseded definitions
alongside their replacements. Harmless, but a reminder of what "consistent" means
here.

A pass means the migrations are internally consistent. It does not mean Postgres
will accept them — that requires running them against a real database, which
has not been done yet.
