/**
 * What the rest of the app sees.
 *
 * The row types in `types/database.ts` are the wire format: amounts as
 * `string | number`, prices split across three loosely-related columns. The types
 * here are the domain — amounts as `bigint`, a price as a value *with* its
 * exponent, settlement as one object that is either present or absent.
 *
 * Mapping between the two is not ceremony. It is the only place a NUMERIC can be
 * misread, so it happens once, per column, with the column named in the error
 * (see `numeric.ts`), instead of at every component that touches an amount.
 *
 * Nothing here formats anything. `lib/format.ts` renders; this decides what the
 * values are.
 */
import type {
  AssetSymbol,
  AttestationStatus,
  InvoiceRow,
  InvoiceStatus,
  MerchantRow,
  PaymentEventRow,
  PaymentRail,
  PublicInvoice,
  PublicInvoiceEvent,
} from '@/types/database';

import {
  priceToNumber,
  toBigInt,
  toBigIntOrNull,
  toDecimalString,
  toDecimalStringOrNull,
  toNumberOrNull,
  toUsdNumber,
} from './numeric';

/**
 * An oracle price and the exponent it was reported at.
 *
 * The two travel together because they are one fact. FTSOv2 reports XRP/USD at 6
 * decimals and FLR/USD at 8, so a raw value without its exponent is not a price —
 * it is a number that looks like one and is wrong by a factor of 100.
 */
export type PriceSnapshot = {
  /** The raw oracle value, exact. Not divided. */
  raw: string;
  /** That feed's own exponent. */
  decimals: number;
  /** raw / 10^decimals, for display. */
  usd: number;
  at: string;
};

/** What the merchant actually received, once the chain has reported it. */
export type Settlement = {
  txHash: string | null;
  /** May differ from the invoice's `tokenSymbol` — pay FXRP, settle USDT0. */
  tokenSymbol: AssetSymbol | null;
  amountUnits: bigint | null;
  toAddress: string | null;
  settledAt: string | null;
  /** The price the payout was computed at, which is not the invoice's quote. */
  price: PriceSnapshot | null;
};

export type Merchant = {
  id: string;
  walletAddress: string;
  authUserId: string | null;
  displayName: string | null;
  email: string | null;
  settlementAsset: AssetSymbol;
  /** Where payouts go. Already resolved: falls back to the wallet address. */
  settlementAddress: string;
  createdAt: string;
  updatedAt: string;
};

export type Invoice = {
  id: string;
  merchantId: string;
  customerAddress: string | null;

  title: string;
  description: string | null;
  currencyCode: string;

  /** Exact decimal text, as stored. */
  usdAmount: string;
  /** The same figure as a number, for display only. */
  usdAmountNumber: number;
  /** Base units of `tokenSymbol`. Null until the invoice has been quoted. */
  tokenAmount: bigint | null;
  tokenSymbol: AssetSymbol;
  /** The quote this invoice was issued at. */
  price: PriceSnapshot | null;
  contractVersion: number;
  acceptedPaymentAssets: AssetSymbol[];
  settlementTokenSymbol: AssetSymbol;

  status: InvoiceStatus;
  dueAt: string;
  paidAt: string | null;
  expiresAt: string | null;

  /** The bytes32 the contract emits, and the XRPL memo for Rail B. */
  reference: string | null;
  onchainInvoiceId: string | null;
  paymentTxHash: string | null;
  rail: PaymentRail;

  discountPercent: string;
  totalWithDiscount: string | null;

  /** Present once the chain has reported a payout. */
  settlement: Settlement | null;

  createdAt: string;
  updatedAt: string;
};

/** One row of payment evidence, as reported by the chain. */
export type PaymentRecord = {
  id: string;
  invoiceId: string;
  rail: PaymentRail;
  txHash: string | null;
  blockNumber: number | null;
  logIndex: number;
  amountUnits: bigint;
  tokenSymbol: AssetSymbol;
  /** 0x-hex for Rail A, an XRPL base58 account for Rail B. */
  payerAddress: string;
  attestationStatus: AttestationStatus;
  attestationType: string | null;
  votingRoundId: number | null;
  attestationRequestId: string | null;
  createdAt: string;
};

/** A payment record with the invoice it belongs to, for a history list. */
export type PaymentWithInvoice = PaymentRecord & {
  invoiceTitle: string;
  invoiceStatus: InvoiceStatus;
  invoiceUsdAmount: string;
};

/**
 * The payer's view of an invoice, from `get_public_invoice`.
 *
 * Deliberately not `Invoice`: it has no `merchantId`, and it carries the
 * merchant's display name and payout address instead. Keeping them as separate
 * types means a component written for the public page cannot accidentally be
 * handed a full row with a merchant's private fields on it.
 */
export type PublicInvoiceView = {
  id: string;
  title: string;
  description: string | null;
  usdAmount: string;
  usdAmountNumber: number;
  tokenAmount: bigint | null;
  tokenSymbol: AssetSymbol;
  price: PriceSnapshot | null;
  contractVersion: number;
  acceptedPaymentAssets: AssetSymbol[];
  settlementTokenSymbol: AssetSymbol;
  status: InvoiceStatus;
  rail: PaymentRail;
  dueAt: string;
  paidAt: string | null;
  settledAt: string | null;
  reference: string | null;
  onchainInvoiceId: string | null;
  paymentTxHash: string | null;
  settlementTxHash: string | null;
  discountPercent: string;
  totalWithDiscount: string | null;
  merchantName: string | null;
  /** Wallet that created the on-chain invoice; used to prevent self-payment. */
  merchantAddress: string;
  settlementAsset: AssetSymbol;
  createdAt: string;
};

/** Public payment evidence, from `get_public_invoice_events`. */
export type PublicPayment = {
  rail: PaymentRail;
  txHash: string | null;
  blockNumber: number | null;
  amountUnits: bigint;
  tokenSymbol: AssetSymbol;
  payerAddress: string;
  attestationStatus: AttestationStatus;
  votingRoundId: number | null;
  createdAt: string;
};

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

function priceOf(
  raw: string | number | null,
  decimals: number | null,
  at: string | null,
  label: string,
): PriceSnapshot | null {
  // 0001's trigger guarantees these three arrive together or not at all, so a
  // partial snapshot means something wrote past the trigger. Treated as absent
  // rather than half-built: a price missing its exponent is not a price.
  if (raw === null || decimals === null || at === null) return null;

  const usd = priceToNumber(raw, decimals, label);
  if (usd === null) return null;

  return { raw: toDecimalString(raw, label), decimals, usd, at };
}

function settlementOf(row: InvoiceRow): Settlement | null {
  const hasEvidence =
    row.settlement_tx_hash !== null ||
    row.settled_amount_units !== null ||
    row.settled_at !== null;
  if (!hasEvidence) return null;

  return {
    txHash: row.settlement_tx_hash,
    tokenSymbol: row.settled_token_symbol,
    amountUnits: toBigIntOrNull(row.settled_amount_units, 'invoices.settled_amount_units'),
    toAddress: row.settled_to_address,
    settledAt: row.settled_at,
    price: priceOf(
      row.settlement_price_usd,
      row.settlement_price_decimals,
      row.settlement_price_timestamp,
      'invoices.settlement_price_usd',
    ),
  };
}

export function toMerchant(row: MerchantRow): Merchant {
  return {
    id: row.id,
    walletAddress: row.wallet_address,
    authUserId: row.auth_user_id,
    displayName: row.display_name,
    email: row.email,
    settlementAsset: row.settlement_asset,
    // The same coalesce `get_public_invoice` applies, so both paths agree on
    // where a payout goes.
    settlementAddress: row.settlement_address ?? row.wallet_address,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toInvoice(row: InvoiceRow): Invoice {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    customerAddress: row.customer_address,

    title: row.title,
    description: row.description,
    currencyCode: row.currency_code,

    usdAmount: toDecimalString(row.usd_amount, 'invoices.usd_amount'),
    usdAmountNumber: toUsdNumber(row.usd_amount, 'invoices.usd_amount'),
    tokenAmount: toBigIntOrNull(row.token_amount, 'invoices.token_amount'),
    tokenSymbol: row.token_symbol,
    price: priceOf(
      row.price_usd,
      row.price_decimals,
      row.price_timestamp,
      'invoices.price_usd',
    ),
    contractVersion: row.contract_version,
    acceptedPaymentAssets: row.accepted_payment_assets,
    settlementTokenSymbol: row.settlement_token_symbol,

    status: row.status,
    dueAt: row.due_at,
    paidAt: row.paid_at,
    expiresAt: row.expires_at,

    reference: row.invoice_reference,
    onchainInvoiceId: row.onchain_invoice_id,
    paymentTxHash: row.payment_tx_hash,
    rail: row.rail,

    discountPercent: toDecimalString(row.discount_percent, 'invoices.discount_percent'),
    totalWithDiscount: toDecimalStringOrNull(
      row.total_with_discount,
      'invoices.total_with_discount',
    ),

    settlement: settlementOf(row),

    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toPaymentRecord(row: PaymentEventRow): PaymentRecord {
  return {
    // Stringified rather than coerced to a number: it is an identity column used
    // as a React key, and a key does not need to be arithmetic.
    id: String(row.id),
    invoiceId: row.invoice_id,
    rail: row.rail,
    txHash: row.tx_hash,
    blockNumber: toNumberOrNull(row.block_number, 'payment_events.block_number'),
    logIndex: row.log_index,
    amountUnits: toBigInt(row.amount_units, 'payment_events.amount_units'),
    tokenSymbol: row.token_symbol,
    payerAddress: row.payer_address,
    attestationStatus: row.attestation_status,
    attestationType: row.attestation_type,
    votingRoundId: toNumberOrNull(row.voting_round_id, 'payment_events.voting_round_id'),
    attestationRequestId: row.attestation_request_id,
    createdAt: row.created_at,
  };
}

export function toPublicInvoiceView(row: PublicInvoice): PublicInvoiceView {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    usdAmount: toDecimalString(row.usd_amount, 'usd_amount'),
    usdAmountNumber: toUsdNumber(row.usd_amount, 'usd_amount'),
    tokenAmount: toBigIntOrNull(row.token_amount, 'token_amount'),
    tokenSymbol: row.token_symbol,
    price: priceOf(row.price_usd, row.price_decimals, row.price_timestamp, 'price_usd'),
    contractVersion: row.contract_version,
    acceptedPaymentAssets: row.accepted_payment_assets,
    settlementTokenSymbol: row.settlement_token_symbol,
    status: row.status,
    rail: row.rail,
    dueAt: row.due_at,
    paidAt: row.paid_at,
    settledAt: row.settled_at,
    reference: row.invoice_reference,
    onchainInvoiceId: row.onchain_invoice_id,
    paymentTxHash: row.payment_tx_hash,
    settlementTxHash: row.settlement_tx_hash,
    discountPercent: toDecimalString(row.discount_percent, 'discount_percent'),
    totalWithDiscount: toDecimalStringOrNull(row.total_with_discount, 'total_with_discount'),
    merchantName: row.merchant_name,
    merchantAddress: row.merchant_address,
    settlementAsset: row.settlement_asset,
    createdAt: row.created_at,
  };
}

export function toPublicPayment(row: PublicInvoiceEvent): PublicPayment {
  return {
    rail: row.rail,
    txHash: row.tx_hash,
    blockNumber: toNumberOrNull(row.block_number, 'block_number'),
    amountUnits: toBigInt(row.amount_units, 'amount_units'),
    tokenSymbol: row.token_symbol,
    payerAddress: row.payer_address,
    attestationStatus: row.attestation_status,
    votingRoundId: toNumberOrNull(row.voting_round_id, 'voting_round_id'),
    createdAt: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// Derived state
// ---------------------------------------------------------------------------

const TERMINAL: ReadonlySet<InvoiceStatus> = new Set<InvoiceStatus>([
  'PAID',
  'SETTLED',
  'EXPIRED',
  'CANCELLED',
]);

/** No further payment can change this invoice. */
export function isTerminal(status: InvoiceStatus): boolean {
  return TERMINAL.has(status);
}

/**
 * Whether a customer can actually pay this right now.
 *
 * Status alone is not enough. `FluxaInvoice.payInvoice` takes an on-chain invoice
 * id, so an invoice that exists only in Postgres cannot be paid however OPEN it
 * looks — and without `tokenAmount` the pay page has no figure to quote. Both are
 * required, which is why this is a function and not a status comparison.
 */
export function isPayable(invoice: {
  status: InvoiceStatus;
  tokenAmount: bigint | null;
  onchainInvoiceId: string | null;
  contractVersion?: number;
  acceptedPaymentAssets?: AssetSymbol[];
}): boolean {
  if (invoice.status !== 'OPEN' && invoice.status !== 'PENDING') return false;
  if (invoice.onchainInvoiceId === null) return false;
  return invoice.contractVersion === 2
    ? (invoice.acceptedPaymentAssets?.length ?? 0) > 0
    : invoice.tokenAmount !== null;
}

/**
 * Past its due date and still unpaid.
 *
 * Derived rather than read from `status`, because nothing sweeps EXPIRED onto
 * invoices as the clock passes — the column changes when something writes it, and
 * a merchant looking at a list wants the truth now.
 */
export function isOverdue(
  invoice: { status: InvoiceStatus; dueAt: string },
  now = new Date(),
): boolean {
  if (invoice.status !== 'OPEN' && invoice.status !== 'PENDING') return false;
  return new Date(invoice.dueAt).getTime() < now.getTime();
}
