/// <reference types="vite/client" />

/**
 * The environment variables this app reads, declared so they are typed as
 * `string | undefined` instead of `any`. Vite's own `ImportMetaEnv` carries an
 * index signature, so a typo in a variable name would type-check silently and
 * arrive as `undefined` at runtime.
 *
 * There are no secrets here. The only server-side value Fluxa has is the
 * GenLayer deployer key, which stays in the terminal that deploys the contract
 * and is never exposed to the bundle.
 */
interface ImportMetaEnv {
  /** The deployed FluxaObligation address on GenLayer Studionet. */
  readonly VITE_GENLAYER_OBLIGATION_CONTRACT?: string;
  /** Base URL of the optional SQLite projection API. */
  readonly VITE_FLUXA_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
