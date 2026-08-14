/// <reference types="vite/client" />

/**
 * The environment variables this app reads, declared so they are typed as
 * `string | undefined` instead of `any`.
 *
 * Vite's own `ImportMetaEnv` carries an index signature, so a typo in a variable
 * name type-checks silently and arrives as `undefined` at runtime. Naming them
 * here turns that into a compile error.
 *
 * Only `VITE_`-prefixed variables are exposed to the client. That prefix is the
 * mechanism keeping `SUPABASE_SERVICE_ROLE_KEY` out of the bundle: Vite will not
 * inline a variable without it, so the indexer's key cannot be reached from here
 * even by accident.
 */
interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  /** The anon / publishable key. Never the service-role key — see lib/supabase.ts. */
  readonly VITE_SUPABASE_ANON_KEY?: string;
  readonly VITE_COSTON2_RPC_URL?: string;
  readonly VITE_INVOICE_REGISTRY_ADDRESS?: string;
  readonly VITE_SETTLEMENT_VAULT_ADDRESS?: string;
  readonly VITE_INVOICE_REGISTRY_V2_ADDRESS?: string;
  readonly VITE_SETTLEMENT_VAULT_V2_ADDRESS?: string;
  readonly VITE_FDC_PAYMENT_RAIL_ADDRESS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
