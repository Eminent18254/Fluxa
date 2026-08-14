/**
 * React Query keys, and the one piece of policy that goes with them.
 *
 * A key factory rather than inline arrays, because the interesting operation is
 * invalidation and inline keys make it guesswork. After the indexer links an
 * invoice, three things are stale — the invoice, the merchant's list, the payment
 * history — and `keys.invoices.all` has to be a prefix of the first two for one
 * `invalidateQueries` call to reach them. Hand-written keys drift out of that
 * relationship silently.
 *
 * ## How the UI learns the chain moved
 *
 * Spec 7.5's synchronization flow ends "invoice available in UI", and the step
 * before it is the indexer writing to Supabase. Nothing pushes that write to the
 * browser. The frontend closes the gap by polling while it is waiting for
 * something and not otherwise, which is what `POLL` below is for:
 *
 *   createInvoice signed  → poll the invoice until onchainInvoiceId is set
 *   payInvoice signed     → poll payments until the tx hash appears
 *   Rail B attestation    → poll until attestation_status reaches VERIFIED
 *
 * Realtime would be the obvious alternative and is deliberately not used yet: it
 * needs the table added to a publication and its own RLS pass, neither of which
 * can be verified without a live project. Polling a row every few seconds while a
 * user watches a spinner is a known quantity. The keys are the same either way, so
 * swapping the transport later does not touch call sites.
 */
import type { InvoiceListFilter } from './invoices';
import type { PaymentHistoryFilter } from './payments';

export const keys = {
  merchant: {
    all: ['merchant'] as const,
    current: () => ['merchant', 'current'] as const,
  },

  invoices: {
    all: ['invoices'] as const,
    list: (filter: InvoiceListFilter = {}) => ['invoices', 'list', filter] as const,
    detail: (invoiceId: string) => ['invoices', 'detail', invoiceId] as const,
    byReference: (reference: string) => ['invoices', 'reference', reference] as const,
    summary: () => ['invoices', 'summary'] as const,
  },

  payments: {
    all: ['payments'] as const,
    forInvoice: (invoiceId: string) => ['payments', 'invoice', invoiceId] as const,
    byTx: (txHash: string) => ['payments', 'tx', txHash] as const,
    history: (filter: PaymentHistoryFilter = {}) => ['payments', 'history', filter] as const,
  },

  /**
   * The public payment link. Separate root from `invoices`, because it is a
   * different projection read through a different function under a different role
   * — invalidating a merchant's list must not touch a payer's page, and vice
   * versa.
   */
  publicInvoice: {
    all: ['public-invoice'] as const,
    detail: (invoiceId: string) => ['public-invoice', 'detail', invoiceId] as const,
    events: (invoiceId: string) => ['public-invoice', 'events', invoiceId] as const,
    page: (invoiceId: string) => ['public-invoice', 'page', invoiceId] as const,
  },
} as const;

/**
 * Poll intervals, in milliseconds.
 *
 * Set against how fast the thing being waited on can actually change. Coston2
 * targets roughly 1.8-second blocks and the indexer polls in its own loop, so a
 * chain write shows up in Postgres within a few seconds — 3s is responsive without
 * being a busy-wait. An FDC attestation cannot resolve faster than a 90-second
 * voting round, so polling it at 3s would be 30 wasted requests per round.
 */
export const POLL = {
  /** Waiting on the indexer to link a published invoice, or record a payment. */
  chain: 3_000,
  /** Waiting on an FDC voting round to finalize. */
  attestation: 15_000,
  /** A dashboard left open. Slow enough to be free, fast enough to notice. */
  background: 30_000,
} as const;
