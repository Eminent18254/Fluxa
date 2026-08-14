/**
 * Rows shaped the way PostgREST actually delivers them.
 *
 * Two details matter more than they look:
 *
 * Amounts default to **strings**, because that is what a NUMERIC column returns
 * once it is wide enough to matter, and because a fixture full of JSON numbers
 * would quietly prove the layer works only in the range where the bug cannot
 * happen. The `number` case is exercised explicitly where it belongs, in
 * `values.test.ts`.
 *
 * Addresses and hashes are lowercase, because 0001 CHECK-constrains them that way.
 * A fixture with a checksummed address in it would be a row the database could not
 * hold, and a test built on one proves nothing about production.
 */
import type {
  InvoiceRow,
  MerchantRow,
  PaymentEventRow,
  PublicInvoice,
  PublicInvoiceEvent,
} from '@/types/database';

export const MERCHANT_ID = '11111111-1111-4111-8111-111111111111';
export const INVOICE_ID = '22222222-2222-4222-8222-222222222222';
export const WALLET = '0x1111111111111111111111111111111111111111';
export const CUSTOMER = '0x2222222222222222222222222222222222222222';
export const REFERENCE = `0x${'ab'.repeat(32)}`;
export const TX_HASH = `0x${'cd'.repeat(32)}`;

/**
 * 1,000,000 FXRP in base units — 1e12, comfortably past 2^53 when multiplied out
 * in a settlement, and exactly the kind of value a JSON number starts losing.
 */
export const BIG_UNITS = '123456789012345678901234567890';

export function merchantRow(overrides: Partial<MerchantRow> = {}): MerchantRow {
  return {
    id: MERCHANT_ID,
    wallet_address: WALLET,
    auth_user_id: '33333333-3333-4333-8333-333333333333',
    display_name: 'Acme Coffee',
    email: null,
    settlement_asset: 'FXRP',
    settlement_address: null,
    created_at: '2026-08-01T10:00:00.000Z',
    updated_at: '2026-08-01T10:00:00.000Z',
    ...overrides,
  };
}

export function invoiceRow(overrides: Partial<InvoiceRow> = {}): InvoiceRow {
  return {
    id: INVOICE_ID,
    merchant_id: MERCHANT_ID,
    customer_address: CUSTOMER,

    title: 'Consulting, August',
    description: null,
    currency_code: 'USD',

    usd_amount: '250.000000',
    token_amount: '104500000',
    token_symbol: 'FXRP',

    // XRP/USD at 6 decimals: 2392537 / 1e6 = $2.392537. The exponent is a
    // per-feed fact, which is why it is stored beside the value.
    price_usd: '2392537',
    price_decimals: 6,
    price_timestamp: '2026-08-01T10:00:05.000Z',
    contract_version: 1,
    accepted_payment_assets: ['FXRP'],
    settlement_token_symbol: 'FXRP',

    status: 'OPEN',
    due_at: '2026-09-01T00:00:00.000Z',
    paid_at: null,
    settled_at: null,
    expires_at: null,

    invoice_reference: REFERENCE,
    onchain_invoice_id: '7',
    payment_tx_hash: null,
    rail: 'FLARE_ERC20',

    discount_percent: '0.00',
    total_with_discount: null,

    settlement_tx_hash: null,
    settled_token_symbol: null,
    settled_amount_units: null,
    settled_to_address: null,

    settlement_price_usd: null,
    settlement_price_decimals: null,
    settlement_price_timestamp: null,

    created_at: '2026-08-01T10:00:00.000Z',
    updated_at: '2026-08-01T10:00:00.000Z',
    ...overrides,
  };
}

export function paymentEventRow(overrides: Partial<PaymentEventRow> = {}): PaymentEventRow {
  return {
    id: '1',
    invoice_id: INVOICE_ID,

    rail: 'FLARE_ERC20',
    tx_hash: TX_HASH,
    block_number: '20481933',
    log_index: 2,

    amount_units: '104500000',
    token_symbol: 'FXRP',
    payer_address: CUSTOMER,

    attestation_status: 'NOT_REQUIRED',
    attestation_type: null,
    voting_round_id: null,
    attestation_request_id: null,

    created_at: '2026-08-02T09:15:00.000Z',
    ...overrides,
  };
}

export function publicInvoice(overrides: Partial<PublicInvoice> = {}): PublicInvoice {
  return {
    id: INVOICE_ID,
    title: 'Consulting, August',
    description: null,
    usd_amount: '250.000000',
    token_amount: '104500000',
    token_symbol: 'FXRP',
    price_usd: '2392537',
    price_decimals: 6,
    price_timestamp: '2026-08-01T10:00:05.000Z',
    contract_version: 1,
    accepted_payment_assets: ['FXRP'],
    settlement_token_symbol: 'FXRP',
    status: 'OPEN',
    rail: 'FLARE_ERC20',
    due_at: '2026-09-01T00:00:00.000Z',
    paid_at: null,
    settled_at: null,
    invoice_reference: REFERENCE,
    onchain_invoice_id: '7',
    payment_tx_hash: null,
    settlement_tx_hash: null,
    discount_percent: '0.00',
    total_with_discount: null,
    merchant_name: 'Acme Coffee',
    merchant_address: WALLET,
    settlement_asset: 'FXRP',
    created_at: '2026-08-01T10:00:00.000Z',
    ...overrides,
  };
}

export function publicInvoiceEvent(
  overrides: Partial<PublicInvoiceEvent> = {},
): PublicInvoiceEvent {
  return {
    rail: 'FLARE_ERC20',
    tx_hash: TX_HASH,
    block_number: '20481933',
    amount_units: '104500000',
    token_symbol: 'FXRP',
    payer_address: CUSTOMER,
    attestation_status: 'NOT_REQUIRED',
    voting_round_id: null,
    created_at: '2026-08-02T09:15:00.000Z',
    ...overrides,
  };
}
