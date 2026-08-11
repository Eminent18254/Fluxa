/**
 * Amount formatting.
 *
 * FXRP and USDT0 are 6-decimal tokens, not 18. parseEther/formatEther are
 * therefore *wrong* for every token amount in this app — they would be off by
 * 10^12. Everything here takes explicit decimals, and all amounts move through
 * the app as bigint base units, converting to a display string only at render.
 */
import { formatUnits, parseUnits } from 'viem';

/** Base units -> human string, e.g. 497572345n @ 6dp -> "497.5723" */
export function formatAmount(
  units: bigint,
  decimals: number,
  maxFractionDigits = 4,
): string {
  const exact = formatUnits(units, decimals);
  const [whole, fraction = ''] = exact.split('.');
  const grouped = BigInt(whole).toLocaleString('en-US');
  const trimmed = fraction.slice(0, maxFractionDigits).replace(/0+$/, '');
  return trimmed ? `${grouped}.${trimmed}` : grouped;
}

/** Human string -> base units. Throws on input the token cannot represent. */
export function parseAmount(value: string, decimals: number): bigint {
  const cleaned = value.trim().replace(/,/g, '');
  if (!/^\d*\.?\d*$/.test(cleaned) || cleaned === '' || cleaned === '.') {
    throw new Error(`Not a valid amount: "${value}"`);
  }
  const [, fraction = ''] = cleaned.split('.');
  if (fraction.length > decimals) {
    throw new Error(
      `Too many decimal places: this token supports ${decimals}, got ${fraction.length}`,
    );
  }
  return parseUnits(cleaned, decimals);
}

/** USD amounts always show cents. */
export function formatUsd(value: number): string {
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * An FTSO price with more precision than a currency format allows —
 * FLR/USD is ~$0.0061, which `formatUsd` would flatten to "$0.01".
 */
export function formatPrice(value: number): string {
  const digits = value < 0.01 ? 6 : value < 1 ? 5 : 4;
  return `$${value.toFixed(digits)}`;
}

/** 0x1234…abcd — never show a truncated address without the leading 0x. */
export function shortenAddress(address: string, chars = 4): string {
  if (address.length < 2 + chars * 2) return address;
  return `${address.slice(0, 2 + chars)}…${address.slice(-chars)}`;
}

export function shortenHash(hash: string): string {
  return shortenAddress(hash, 6);
}

/** "12s ago" / "4m ago" — FTSO feeds update often; staleness must be visible. */
export function formatAge(seconds: number): string {
  if (seconds < 0) return 'just now';
  if (seconds < 60) return `${Math.floor(seconds)}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
