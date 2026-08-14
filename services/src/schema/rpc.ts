/**
 * The database's own vocabulary, as TypeScript.
 *
 * These names are not decoration — every one of them is a Postgres enum, and
 * writing a string Postgres does not recognise fails at the database rather
 * than at the type checker unless the union is spelled out here.
 *
 * Kept deliberately narrow: the indexer writes through two `service_role`
 * functions and one table, so it needs the *write* surface and nothing else.
 * The frontend's read surface lives in `frontend/src/types/database.ts`, which
 * is where the full `Database` type belongs — duplicating it here would give
 * two places for the schema to drift from itself.
 */

/** `invoice_status` in 0001. Note DRAFT and OPEN have no on-chain twin. */
export type InvoiceStatus =
  | "DRAFT"
  | "OPEN"
  | "PENDING"
  | "PAID"
  | "SETTLED"
  | "EXPIRED"
  | "CANCELLED";

/** `payment_rail` in 0001. */
export type PaymentRail = "FLARE_ERC20" | "XRPL_NATIVE";

/** `asset_symbol` in 0001. XRP is XRPL-native; FXRP and USDT0 are Coston2 ERC-20s. */
export type AssetSymbol = "FXRP" | "USDT0" | "XRP";

/** `attestation_status` in 0001. */
export type AttestationStatus =
  | "NOT_REQUIRED"
  | "PREPARING"
  | "SUBMITTED"
  | "FINALIZED"
  | "VERIFIED"
  | "FAILED";

/**
 * Arguments to `record_payment_event`, the atomic payment writer from 0003.
 *
 * Numeric columns are typed `string`, not `number`. `amount_units` is
 * NUMERIC(78, 0) and a uint256 does not survive an IEEE double — 2^53 is where
 * silent rounding starts, and FXRP has six decimals, so a wallet holding more
 * than about 9 billion tokens would be misreported. Strings go through
 * PostgREST into NUMERIC unchanged.
 */
export type RecordPaymentArgs = {
  p_invoice_id: string;
  p_rail: PaymentRail;
  p_tx_hash: string;
  p_log_index: number;
  p_block_number: number;
  p_amount_units: string;
  p_token_symbol: AssetSymbol;
  p_payer_address: string;
  p_paid_at: string;
  p_attestation_status: AttestationStatus;
  p_attestation_type: string | null;
  p_voting_round_id: number | null;
};

/** Arguments to `record_settlement` from 0003. */
export type RecordSettlementArgs = {
  p_invoice_id: string;
  p_tx_hash: string;
  p_token_symbol: AssetSymbol;
  p_amount_units: string;
  p_to_address: string;
  p_settled_at: string;
};

/** A row of `sync_state` from 0003. */
export type SyncStateRow = {
  id: string;
  chain_id: number;
  last_processed_block: number;
  deployed_at_block: number;
  contract_fingerprint: string;
  contracts: Record<string, string>;
  last_run_at: string | null;
  last_error: string | null;
  events_applied: number;
};
