/**
 * Turning a Postgres error into something a developer can act on.
 *
 * The database refuses things for good reasons, and it says so in SQLSTATE codes
 * that mean nothing on their own. Three of them are routine in this schema and
 * each has a specific cause here:
 *
 *   42501  the 0002 column grant refused a write. Not an RLS failure — a grant
 *          failure, which happens before RLS is consulted. Means the code tried
 *          to write an evidence column (`payment_tx_hash`, `paid_at`,
 *          `token_amount`) that no client role may write.
 *   23514  a CHECK failed. Almost always the lowercase-hex invariant on an
 *          address or hash: wagmi hands out EIP-55 checksummed addresses and this
 *          schema stores them lowercase.
 *   42883  the function does not exist, i.e. the migrations have not been applied.
 *
 * The failure this module cannot translate is the quiet one: a `select` that
 * returns zero rows because RLS filtered them is indistinguishable from one that
 * matched nothing. That is why the read helpers say "not found, or not yours"
 * rather than "not found" — the distinction is deliberately unavailable, and
 * claiming otherwise would be a guess.
 */
import type { PostgrestError } from '@supabase/supabase-js';

export class FluxaDbError extends Error {
  readonly code: string | undefined;
  readonly details: string | null;
  readonly hint: string | null;

  constructor(message: string, source?: PostgrestError) {
    super(message);
    this.name = 'FluxaDbError';
    this.code = source?.code;
    this.details = source?.details ?? null;
    this.hint = source?.hint ?? null;
  }
}

const EXPLANATIONS: Record<string, string> = {
  '42501':
    'the column grant refused this write. 0002 revokes UPDATE and INSERT on invoices ' +
    'and re-grants them on a narrow column list; payment and settlement evidence is ' +
    'not on it, because only the indexer writes those.',
  '23514':
    'a CHECK constraint rejected the value. Addresses, hashes and references are ' +
    'stored lowercase in this schema — pass an address through toStoredAddress() ' +
    'before writing it.',
  '23505':
    'a unique constraint rejected the value. invoice_reference and ' +
    'merchants.wallet_address are both unique.',
  '23503':
    'a foreign key had no match. An invoice needs an existing merchant row; call ' +
    'ensureMerchant() before creating one.',
  '42883':
    'the function does not exist. Apply database/migrations/0001..0004 in order, in ' +
    'the Supabase SQL editor.',
  '42P01':
    'the table does not exist. Apply database/migrations/0001..0004 in order, in the ' +
    'Supabase SQL editor.',
  PGRST116:
    'the query expected exactly one row and got none or many. Under RLS, filtered ' +
    'rows are simply absent, so this can also mean the row exists but belongs to ' +
    'another merchant.',
  PGRST301: 'the session is missing or expired. The merchant needs to sign in again.',
  // Every `raise exception` in the migrations lands here, and those messages were
  // written to be read, so they are passed through unembellished.
  P0001: '',
};

/** Wrap a PostgREST failure with what it means in this schema. */
export function dbError(context: string, error: PostgrestError): FluxaDbError {
  const explanation = EXPLANATIONS[error.code ?? ''];
  const suffix =
    explanation === undefined || explanation === ''
      ? ''
      : `\n\n${error.code}: ${explanation}`;

  return new FluxaDbError(`${context}: ${error.message}${suffix}`, error);
}

/**
 * Unwrap a PostgREST result, or throw with context.
 *
 * Every query in this layer ends here, so no call site has to remember that
 * supabase-js reports failure in a field rather than by rejecting.
 */
export function unwrap<T>(
  context: string,
  result: { data: T; error: PostgrestError | null },
): T {
  if (result.error !== null) throw dbError(context, result.error);
  return result.data;
}
