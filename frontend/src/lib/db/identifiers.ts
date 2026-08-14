/**
 * The shapes the schema's CHECK constraints require.
 *
 * 0001 stores addresses, hashes and references as **lowercase** hex and
 * CHECK-constrains every one of them:
 *
 *   wallet_address      ^0x[0-9a-f]{40}$
 *   invoice_reference   ^0x[0-9a-f]{64}$
 *
 * That invariant removes a whole class of mixed-case comparison bug — the
 * indexer lowercases every address it reads from a log, so a lookup by address
 * matches without either side having to remember to normalise. The cost is that
 * wagmi and viem hand out EIP-55 *checksummed* addresses, so writing one
 * straight from a wallet connection fails the CHECK with SQLSTATE 23514.
 *
 * Everything that reaches the database goes through this module, and the
 * conversion is deliberately not silent about malformed input: an address that is
 * the wrong length is a bug upstream, and lowercasing it would only move the
 * failure further from its cause.
 */

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH_OR_REFERENCE = /^0x[0-9a-fA-F]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An EIP-55 or lowercase address, as the database stores it. */
export function toStoredAddress(address: string, label = 'address'): string {
  const trimmed = address.trim();
  if (!ADDRESS.test(trimmed)) {
    throw new Error(
      `${label} ${JSON.stringify(address)} is not a 20-byte hex address. ` +
        `Expected 0x followed by 40 hex digits.`,
    );
  }
  return trimmed.toLowerCase();
}

export function toStoredAddressOrNull(
  address: string | null | undefined,
  label = 'address',
): string | null {
  if (address === null || address === undefined || address.trim() === '') return null;
  return toStoredAddress(address, label);
}

/** A 32-byte transaction hash or payment reference, lowercased. */
export function toStoredHash(hash: string, label = 'hash'): string {
  const trimmed = hash.trim();
  if (!HASH_OR_REFERENCE.test(trimmed)) {
    throw new Error(
      `${label} ${JSON.stringify(hash)} is not a 32-byte hex value. ` +
        `Expected 0x followed by 64 hex digits.`,
    );
  }
  return trimmed.toLowerCase();
}

/**
 * A v4 UUID, checked before it is sent.
 *
 * The invoice id in a payment link is the credential for that invoice, so a
 * malformed one is a bad link rather than a database problem. Rejecting it here
 * means the pay page can say so, instead of showing a PostgREST 400 about invalid
 * input syntax for type uuid.
 */
export function isUuid(value: string): boolean {
  return UUID.test(value.trim());
}

export function assertUuid(value: string, label = 'id'): string {
  const trimmed = value.trim();
  if (!isUuid(trimmed)) {
    throw new Error(`${label} ${JSON.stringify(value)} is not a valid invoice id`);
  }
  return trimmed.toLowerCase();
}
