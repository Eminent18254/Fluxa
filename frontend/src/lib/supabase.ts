/**
 * The browser's connection to Supabase.
 *
 * This client carries the **anon** key and nothing else. Its reach is exactly
 * what 0002 grants: `anon` may call `get_public_invoice(id)` and its events
 * function; `authenticated` may read and write its own merchant row and its own
 * invoices, within the granted column list. No client role can write payment
 * evidence — that authority belongs to the indexer, which runs elsewhere with
 * the service-role key and never ships to a browser.
 *
 * Constructed lazily so the app boots without Supabase configured. Sprint 3's
 * wallet connection and live FTSO reads need no database at all, and a module
 * that threw at import time would take those down too.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import type { Database } from '@/types/database';

export type FluxaClient = SupabaseClient<Database>;

const url = import.meta.env.VITE_SUPABASE_URL?.trim() ?? '';
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim() ?? '';

let cached: FluxaClient | null = null;

/** True if the build carries Supabase configuration at all. */
export function hasSupabaseConfig(): boolean {
  return url !== '' && anonKey !== '';
}

/**
 * Refuse a service-role key in the browser bundle.
 *
 * The two keys are adjacent in the Supabase dashboard, both are long opaque
 * strings, and pasting the wrong one into `VITE_SUPABASE_ANON_KEY` produces an
 * app that works *better* — every RLS policy stops applying, so the bugs the
 * policies would have surfaced disappear. It would ship to production as a
 * public key that can read every merchant's invoices and mark any of them paid.
 *
 * Both key formats are checkable. The legacy keys are JWTs whose payload carries
 * a `role` claim; the newer ones are prefixed `sb_publishable_` / `sb_secret_`.
 * Neither check needs a network call, so this runs at construction.
 */
function assertNotServiceRole(key: string): void {
  const fail = (): never => {
    throw new Error(
      'VITE_SUPABASE_ANON_KEY looks like a service-role key. That key bypasses ' +
        'Row Level Security and must never reach the browser — anyone could read ' +
        'every merchant\'s invoices and mark them paid. Use the anon / publishable ' +
        'key from Supabase project settings → API.',
    );
  };

  if (key.startsWith('sb_secret_')) fail();

  const segments = key.split('.');
  if (segments.length === 3 && segments[1] !== undefined) {
    try {
      // Base64url, and JWT payloads are unpadded.
      const json = atob(segments[1].replace(/-/g, '+').replace(/_/g, '/'));
      const role: unknown = (JSON.parse(json) as { role?: unknown }).role;
      if (role === 'service_role') fail();
    } catch (error) {
      // A key that does not decode is not evidence of a service-role key, and
      // this function's job is only to catch that one mistake. An unusable key
      // fails at the first request with Supabase's own message, which is clearer
      // than anything invented here.
      if (error instanceof Error && error.message.includes('service-role')) throw error;
    }
  }
}

/**
 * The shared client.
 *
 * Throws when unconfigured rather than returning a broken client, because the
 * alternative is a page that renders empty and blames the database. Call
 * `hasSupabaseConfig()` first anywhere the UI should degrade instead.
 */
export function supabase(): FluxaClient {
  if (cached !== null) return cached;

  if (!hasSupabaseConfig()) {
    throw new Error(
      'Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY ' +
        'in frontend/.env.local (see .env.example at the repository root), then ' +
        'restart Vite — it reads env only at startup.',
    );
  }

  assertNotServiceRole(anonKey);

  cached = createClient<Database>(url, anonKey, {
    auth: {
      // A merchant session should survive a reload; the pay page has no session
      // at all and is unaffected by this.
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  });

  return cached;
}
