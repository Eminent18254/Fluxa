/**
 * The frontend's data layer.
 *
 * Everything the app knows about Postgres is behind this module. Components import
 * from `@/lib/db`; nothing outside this directory imports `@supabase/supabase-js`
 * or touches a snake_case row type.
 *
 * The shape is deliberate:
 *
 *   numeric.ts       NUMERIC/bigint in and out without losing digits
 *   identifiers.ts   the lowercase-hex and UUID invariants the CHECKs require
 *   errors.ts        SQLSTATE codes translated into what they mean in this schema
 *   model.ts         wire rows → domain types (bigint amounts, priced snapshots)
 *   merchants.ts     the caller's own merchant row
 *   invoices.ts      the merchant's invoices, and the publish flow
 *   payments.ts      payment evidence and transaction history (read-only)
 *   publicInvoice.ts the payer's view, via the SECURITY DEFINER functions
 *   keys.ts          React Query keys and poll intervals
 *
 * Every function takes the client as its first argument rather than reaching for
 * the module-level singleton. That is what makes the layer testable without a
 * network: a test passes a stub that satisfies `FluxaClient`, and there is no
 * global to reset between cases.
 *
 * ## Two things this layer will not do
 *
 * It never writes payment or settlement evidence. Those columns are outside the
 * 0002 grant lists and belong to the indexer, which writes them from chain facts
 * with the service role. The types make the attempt a compile error and the grant
 * makes it a 42501; both are on purpose.
 *
 * It never sets an invoice to OPEN. An invoice becomes payable when Coston2 says it
 * exists — `prepareInvoiceForChain` stamps the reference, the merchant signs, and
 * the indexer moves the row. A browser that could publish an invoice by itself
 * could publish one the contract has never heard of.
 */

export {
  FluxaDbError,
  dbError,
  unwrap,
} from './errors';

export {
  assertUuid,
  isUuid,
  toStoredAddress,
  toStoredAddressOrNull,
  toStoredHash,
} from './identifiers';

export {
  fromBigInt,
  priceToNumber,
  toBigInt,
  toBigIntOrNull,
  toDecimalString,
  toDecimalStringOrNull,
  toNumberOrNull,
  toUsdNumber,
} from './numeric';

export {
  isOverdue,
  isPayable,
  isTerminal,
  toInvoice,
  toMerchant,
  toPaymentRecord,
  toPublicInvoiceView,
  toPublicPayment,
} from './model';
export type {
  Invoice,
  Merchant,
  PaymentRecord,
  PaymentWithInvoice,
  PriceSnapshot,
  PublicInvoiceView,
  PublicPayment,
  Settlement,
} from './model';

export { ensureMerchant, getCurrentMerchant, updateMerchant } from './merchants';
export type { EnsureMerchantInput, MerchantSettings } from './merchants';

export {
  cancelInvoice,
  createInvoiceDraft,
  deleteDraft,
  getInvoice,
  getInvoiceByReference,
  getInvoiceSummary,
  listInvoices,
  prepareInvoiceForChain,
  prepareInvoiceV2,
  updateInvoice,
} from './invoices';
export type {
  CreateInvoiceInput,
  EditInvoiceInput,
  InvoiceList,
  InvoiceListFilter,
  InvoiceSummary,
  PrepareInvoiceInput,
} from './invoices';

export {
  countInvoicePayments,
  listInvoicePayments,
  listPaymentHistory,
  listPaymentsByTx,
} from './payments';
export type { PaymentHistory, PaymentHistoryFilter } from './payments';

export {
  getPublicInvoice,
  getPublicInvoiceEvents,
  getPublicInvoicePage,
} from './publicInvoice';
export type { PublicInvoicePage } from './publicInvoice';

export { POLL, keys } from './keys';
