/**
 * Display formatting.
 *
 * Amounts move through the app as integer minor units, exactly as the contract
 * stores them, and are only converted to a locale string at render. Nothing here
 * does floating-point arithmetic on money.
 */

/** 0x1234...abcd - never show a truncated address without the leading 0x. */
export function shortenAddress(address: string, chars = 4): string {
  if (!address || address.length < 2 + chars * 2) return address;
  return `${address.slice(0, 2 + chars)}...${address.slice(-chars)}`;
}

export function shortenHash(hash: string): string {
  return shortenAddress(hash, 6);
}

/** "12s ago" / "4m ago" / "3d ago" */
export function formatAge(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return 'just now';
  if (seconds < 60) return `${Math.floor(seconds)}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export function errorMessage(error: unknown, fallback = 'Something went wrong.'): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return fallback;
}
