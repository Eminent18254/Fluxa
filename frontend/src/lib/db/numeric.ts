/**
 * Getting numbers out of Postgres without losing any of them.
 *
 * `token_amount` and `amount_units` are NUMERIC(78, 0) — uint256 base units.
 * PostgREST serialises NUMERIC and `bigint` through Postgres `to_json`, which
 * emits an unquoted JSON literal, and `JSON.parse` turns an unquoted literal into
 * an IEEE double. Above 2^53 that is lossy, and lossy in the worst way: no error,
 * just a payment amount that is quietly off by a few base units.
 *
 * So nothing in this app reads an amount column directly. Every read comes
 * through here, where a `string` is exact and a `number` is checked before it is
 * trusted. Amounts then travel as `bigint` and are formatted only at render, by
 * `lib/format.ts`.
 *
 * The write direction is simpler and has one rule: send strings. A string goes
 * into NUMERIC unchanged, so `fromBigInt` is the only way this app writes an
 * amount.
 */
import type { Int8, Numeric } from '@/types/database';

/**
 * An exact integer from a NUMERIC(78, 0) or `bigint` column.
 *
 * A `number` that is not a safe integer has already lost precision before this
 * function saw it — the true value is unrecoverable, so it throws rather than
 * return an amount that is nearly right. `label` names the column, because "an
 * amount was imprecise" is not actionable and "invoices.token_amount was" is.
 */
export function toBigInt(value: Numeric | Int8, label: string): bigint {
  if (typeof value === 'bigint') return value;

  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new Error(
        `${label} arrived from PostgREST as the JSON number ${value}, which is ` +
          `outside the safe integer range. The exact value is already lost — it ` +
          `cannot be recovered here. Have the query select this column with a cast ` +
          `to text (\`${label}::text\`) so it arrives as a string.`,
      );
    }
    return BigInt(value);
  }

  const trimmed = value.trim();
  // NUMERIC(78, 0) holds no fraction, but a NUMERIC read through a view or a
  // function's looser `numeric` return type can arrive as "495483667.000000".
  // A zero fraction is exact and safe to drop; a non-zero one is not an integer
  // amount and is a bug worth naming.
  const [whole = '', fraction] = trimmed.split('.');
  if (fraction !== undefined && /[1-9]/.test(fraction)) {
    throw new Error(`${label} is ${trimmed}, which is not a whole number of base units`);
  }
  if (!/^-?\d+$/.test(whole)) {
    throw new Error(`${label} is ${JSON.stringify(value)}, which is not a number`);
  }
  return BigInt(whole);
}

export function toBigIntOrNull(
  value: Numeric | Int8 | null | undefined,
  label: string,
): bigint | null {
  if (value === null || value === undefined) return null;
  return toBigInt(value, label);
}

/**
 * A `bigint` column that is genuinely small — a block number, a voting round, a
 * log index. Checked rather than assumed, so a chain that outgrows a double says
 * so instead of drifting.
 */
export function toNumberOrNull(value: Int8 | null | undefined, label: string): number | null {
  if (value === null || value === undefined) return null;
  const asBigInt = toBigInt(value, label);
  if (asBigInt > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${label} is ${asBigInt}, too large to hold as a number`);
  }
  return Number(asBigInt);
}

/**
 * Exact decimal text from a scaled NUMERIC — `usd_amount` at NUMERIC(20, 6),
 * `discount_percent` at NUMERIC(5, 2).
 *
 * Kept as a string because that is what the column holds and what a later write
 * must send back. Converting to a double here and stringifying on the way out
 * would be a round-trip through binary floating point for no reason.
 */
export function toDecimalString(value: Numeric, label: string): string {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
      throw new Error(`${label} is ${JSON.stringify(value)}, which is not a number`);
    }
    return trimmed;
  }
  if (!Number.isFinite(value)) {
    throw new Error(`${label} is ${value}, which is not a finite number`);
  }
  // NUMERIC(20, 6) tops out around 1e14, so a double represents every legal
  // value of these columns exactly. The guard is for a column that is later
  // widened without this assumption being revisited.
  if (Math.abs(value) > Number.MAX_SAFE_INTEGER / 1e6) {
    throw new Error(
      `${label} is ${value}, large enough that its six decimal places no longer ` +
        `survive a JSON number. Select it as text.`,
    );
  }
  return String(value);
}

export function toDecimalStringOrNull(
  value: Numeric | null | undefined,
  label: string,
): string | null {
  if (value === null || value === undefined) return null;
  return toDecimalString(value, label);
}

/** A USD figure as a number, for `formatUsd`. Display only — never for arithmetic on amounts. */
export function toUsdNumber(value: Numeric, label: string): number {
  return Number(toDecimalString(value, label));
}

/**
 * An FTSOv2 price from its raw value and that feed's own exponent.
 *
 * The exponent is not a constant: XRP/USD reports 6 decimals and FLR/USD reports
 * 8, confirmed on-chain in Phase 0. Dividing by a hardcoded power of ten works
 * until it misprices by 100×, which is why `price_decimals` is stored beside
 * every price and required here.
 */
export function priceToNumber(
  raw: Numeric,
  decimals: number | null,
  label: string,
): number | null {
  if (decimals === null) {
    // 0001's trigger makes this unreachable for a priced invoice; if it happens,
    // the honest answer is "no price", not a number computed from a guess.
    return null;
  }
  return Number(toDecimalString(raw, label)) / 10 ** decimals;
}

/** The only way this app writes an amount: base units as exact decimal text. */
export function fromBigInt(value: bigint): string {
  return value.toString(10);
}
