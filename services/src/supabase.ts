import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { supabaseConfig } from "./config.js";

/**
 * The indexer's connection to Supabase.
 *
 * Built with the service-role key, which bypasses Row Level Security entirely.
 * That is not a shortcut around the policies — it is what the indexer needs and
 * what no client may have. Every write it makes is payment evidence:
 * `payment_events`, `invoices.paid_at`, the settlement columns. 0002 withholds
 * all of it from `anon` and `authenticated` precisely so that the only thing
 * that can assert "this invoice was paid" is something that watched the chain.
 *
 * The consequences, stated so they are not discovered later:
 *
 *   - RLS does not apply. A missing `where` clause is a whole-table update. Every
 *     write below names an id.
 *   - This module must never be imported by anything under `frontend/`. It reads
 *     `SUPABASE_SERVICE_ROLE_KEY`, which has no `VITE_` prefix, so Vite would
 *     refuse to inline it — but the import would still fail at runtime in a way
 *     that invites someone to "fix" it by renaming the variable.
 */

let cached: SupabaseClient | null = null;

export function serviceClient(): SupabaseClient {
  if (cached !== null) return cached;

  const { url, serviceRoleKey } = supabaseConfig();

  cached = createClient(url, serviceRoleKey, {
    auth: {
      // No user session to keep. Persisting or refreshing one would only give
      // the process a token file to leak.
      persistSession: false,
      autoRefreshToken: false,
    },
    global: {
      headers: { "x-fluxa-client": "indexer" },
    },
  });

  return cached;
}

/** True if the environment carries Supabase credentials at all. */
export function hasSupabaseCredentials(): boolean {
  return (
    (process.env.SUPABASE_URL ?? "").trim() !== "" &&
    (process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim() !== ""
  );
}
