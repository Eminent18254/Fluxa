/**
 * The merchant's own row.
 *
 * Identity in Fluxa is a wallet address, but RLS keys off `auth.uid()`, so a
 * merchant row is reachable only after the wallet has been linked to a Supabase
 * Auth user. Every function here relies on that link: `current_merchant_id()`
 * resolves `auth.uid()` to a `merchants.id`, and the policies in 0002 use it to
 * scope every invoice query. No session means no merchant row, which is why
 * `getCurrentMerchant` returns null rather than throwing — a signed-out visitor
 * is a normal state, not an error.
 */
import type { FluxaClient } from '@/lib/supabase';
import type { MerchantRow, MerchantUpdate } from '@/types/database';

import { dbError, unwrap } from './errors';
import { toStoredAddress, toStoredAddressOrNull } from './identifiers';
import { toMerchant, type Merchant } from './model';

/**
 * The signed-in merchant, or null.
 *
 * No `where` clause: `merchants_select_own` already restricts the table to the
 * row whose `auth_user_id` matches the session, so selecting the whole table
 * returns at most one row. Filtering again would be redundant and would suggest
 * the policy is not doing its job.
 */
export async function getCurrentMerchant(db: FluxaClient): Promise<Merchant | null> {
  const { data, error } = await db.from('merchants').select('*').maybeSingle();

  if (error !== null) throw dbError('reading the current merchant', error);
  return data === null ? null : toMerchant(data as MerchantRow);
}

export type EnsureMerchantInput = {
  /** From the wallet connection. Checksummed is fine; it is lowercased here. */
  walletAddress: string;
  /** The Supabase Auth user the wallet has been linked to. */
  authUserId: string;
  displayName?: string | null;
};

/**
 * Fetch the merchant row, creating it on first sign-in.
 *
 * `merchants_insert_self` allows the insert only when `auth_user_id` equals
 * `auth.uid()`, so this cannot claim another wallet's row even with a forged
 * address.
 *
 * The unique-violation branch is not defensive padding: `wallet_address` is
 * unique, and two tabs signing in together will both find no row and both
 * insert. The loser re-reads instead of failing, because the row it wanted now
 * exists.
 */
export async function ensureMerchant(
  db: FluxaClient,
  input: EnsureMerchantInput,
): Promise<Merchant> {
  const existing = await getCurrentMerchant(db);
  if (existing !== null) return existing;

  const { data, error } = await db
    .from('merchants')
    .insert({
      wallet_address: toStoredAddress(input.walletAddress, 'walletAddress'),
      auth_user_id: input.authUserId,
      display_name: input.displayName ?? null,
    })
    .select('*')
    .single();

  if (error !== null) {
    if (error.code === '23505') {
      const raced = await getCurrentMerchant(db);
      if (raced !== null) return raced;
      // Unique violation with still no readable row means the address belongs to
      // a different auth user. Worth saying plainly: retrying will not fix it.
      throw dbError(
        `wallet ${input.walletAddress} is already registered to another account`,
        error,
      );
    }
    throw dbError('creating the merchant row', error);
  }

  return toMerchant(data as MerchantRow);
}

export type MerchantSettings = {
  displayName?: string | null;
  email?: string | null;
  settlementAsset?: MerchantUpdate['settlement_asset'];
  /** Where payouts go. Null falls back to the merchant's wallet address. */
  settlementAddress?: string | null;
};

/** Update the merchant's own row. RLS restricts this to the caller's row. */
export async function updateMerchant(
  db: FluxaClient,
  merchantId: string,
  settings: MerchantSettings,
): Promise<Merchant> {
  const patch: MerchantUpdate = {};

  if (settings.displayName !== undefined) patch.display_name = settings.displayName;
  if (settings.email !== undefined) patch.email = settings.email;
  if (settings.settlementAsset !== undefined) {
    patch.settlement_asset = settings.settlementAsset;
  }
  if (settings.settlementAddress !== undefined) {
    patch.settlement_address = toStoredAddressOrNull(
      settings.settlementAddress,
      'settlementAddress',
    );
  }

  const data = unwrap(
    `updating merchant ${merchantId}`,
    await db.from('merchants').update(patch).eq('id', merchantId).select('*').single(),
  );

  return toMerchant(data as MerchantRow);
}
