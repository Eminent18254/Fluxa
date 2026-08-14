/**
 * Payment records: the evidence rows, and the merchant's transaction history.
 *
 * Read-only, all of it. 0002 revokes insert, update and delete on
 * `payment_events` from both client roles, and the comment there explains why in
 * one line: "if a client could insert into this table, it could manufacture proof
 * of a payment that never happened, which is the one failure this whole design is
 * arranged to prevent." So there is no write function in this module and no
 * argument for adding one — a row appears here when the indexer has seen the
 * transfer on Coston2 (Rail A) or verified an FDC Merkle proof (Rail B).
 *
 * ## Why the history is two queries and not an embed
 *
 * A merchant-wide feed wants each payment's invoice title beside it, which
 * PostgREST would happily do as `invoices!inner(title, status, usd_amount)`. It is
 * done as two round-trips instead:
 *
 *   1. a page of `payment_events`, scoped by `payment_events_select_own_merchant`
 *   2. the invoices those rows point at, scoped by `invoices_select_own`
 *
 * Both queries are then a plain select against a policy that is easy to read, and
 * the join happens in TypeScript where it is visible. An embed would put the same
 * join behind PostgREST's resource-embedding rules *and* the schema type's
 * `Relationships` inference, which is two mechanisms to be wrong about at once for
 * a page that shows a few dozen rows.
 *
 * ## Ordering
 *
 * Newest-first everywhere, matching `get_public_invoice_events` in 0002. The
 * merchant's timeline for one invoice and the payer's public timeline are the same
 * list of facts, and a component that renders one should be able to render the
 * other without reversing it.
 */
import type { FluxaClient } from '@/lib/supabase';
import type {
  AttestationStatus,
  InvoiceRow,
  PaymentEventRow,
  PaymentRail,
} from '@/types/database';

import { dbError } from './errors';
import { assertUuid, toStoredHash } from './identifiers';
import { toDecimalString } from './numeric';
import { toPaymentRecord, type PaymentRecord, type PaymentWithInvoice } from './model';

/** Every column of `payment_events`. Listed for the same reason `select('*')` is avoided elsewhere: nothing. */
const EVENT_COLUMNS = '*';

/**
 * Payment evidence for one invoice, newest first.
 *
 * No `merchant_id` filter and no join: `payment_events_select_own_merchant`
 * already restricts the table to rows whose invoice belongs to the caller. An
 * empty array therefore means "no payments, or not your invoice", and those two
 * are deliberately indistinguishable — see the note in `errors.ts`.
 *
 * The secondary sort is `log_index`, which exists for exactly this: two transfers
 * in the same transaction share a `created_at` down to the microsecond the indexer
 * wrote them, and `(tx_hash, log_index)` is the idempotency key 0003 made unique.
 */
export async function listInvoicePayments(
  db: FluxaClient,
  invoiceId: string,
): Promise<PaymentRecord[]> {
  const id = assertUuid(invoiceId, 'invoiceId');

  const { data, error } = await db
    .from('payment_events')
    .select(EVENT_COLUMNS)
    .eq('invoice_id', id)
    .order('created_at', { ascending: false })
    .order('log_index', { ascending: false });

  if (error !== null) throw dbError(`reading payments for invoice ${id}`, error);
  return (data as PaymentEventRow[]).map(toPaymentRecord);
}

/**
 * Payment evidence for one transaction hash.
 *
 * This is the function the pay page polls. The wallet returns a hash immediately;
 * the row appears when the indexer has read the log and written it. Until then the
 * array is empty, and an empty array is the honest answer — the payment is not
 * confirmed until Fluxa has seen it on-chain, whatever the wallet said.
 *
 * Plural because one transaction can carry several transfers, and `(tx_hash,
 * log_index)` — not `tx_hash` alone — is what 0003 made unique.
 */
export async function listPaymentsByTx(
  db: FluxaClient,
  txHash: string,
): Promise<PaymentRecord[]> {
  const stored = toStoredHash(txHash, 'txHash');

  const { data, error } = await db
    .from('payment_events')
    .select(EVENT_COLUMNS)
    .eq('tx_hash', stored)
    .order('log_index', { ascending: true });

  if (error !== null) throw dbError(`reading payments for transaction ${stored}`, error);
  return (data as PaymentEventRow[]).map(toPaymentRecord);
}

export type PaymentHistoryFilter = {
  /** Restrict to one invoice. Omit for the whole merchant. */
  invoiceId?: string;
  rail?: PaymentRail;
  /** Rail B moves through PREPARING → SUBMITTED → FINALIZED → VERIFIED. */
  attestationStatus?: readonly AttestationStatus[];
  /** Inclusive lower bound on `created_at`. */
  since?: Date | string;
  limit?: number;
  offset?: number;
};

export type PaymentHistory = {
  payments: PaymentWithInvoice[];
  /** Total matching rows, ignoring the page window. */
  total: number;
};

/**
 * The merchant's transaction history: every payment across every invoice.
 *
 * Each row carries its invoice's title, status and USD amount, because a feed of
 * bare amounts and hashes is not a history a human can read.
 */
export async function listPaymentHistory(
  db: FluxaClient,
  filter: PaymentHistoryFilter = {},
): Promise<PaymentHistory> {
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
  const offset = Math.max(filter.offset ?? 0, 0);

  let query = db
    .from('payment_events')
    .select(EVENT_COLUMNS, { count: 'exact' })
    .order('created_at', { ascending: false })
    .order('log_index', { ascending: false })
    .range(offset, offset + limit - 1);

  if (filter.invoiceId !== undefined) {
    query = query.eq('invoice_id', assertUuid(filter.invoiceId, 'invoiceId'));
  }
  if (filter.rail !== undefined) {
    query = query.eq('rail', filter.rail);
  }
  if (filter.attestationStatus !== undefined && filter.attestationStatus.length > 0) {
    query = query.in('attestation_status', filter.attestationStatus);
  }
  if (filter.since !== undefined) {
    const since = filter.since instanceof Date ? filter.since : new Date(filter.since);
    if (Number.isNaN(since.getTime())) {
      throw new Error(`since is not a valid date: ${JSON.stringify(filter.since)}`);
    }
    query = query.gte('created_at', since.toISOString());
  }

  const { data, error, count } = await query;
  if (error !== null) throw dbError('reading payment history', error);

  const rows = data as PaymentEventRow[];
  if (rows.length === 0) {
    return { payments: [], total: count ?? 0 };
  }

  const invoices = await fetchInvoiceLabels(db, rows);

  const payments = rows.map((row) => {
    const invoice = invoices.get(row.invoice_id);
    if (invoice === undefined) {
      // Unreachable while the 0002 policies hold: payment_events is scoped to
      // `invoice_id in (select id from invoices where merchant_id =
      // current_merchant_id())`, and invoices_select_own returns every one of
      // those rows. Reported rather than skipped, because dropping payment
      // evidence from a payment history is the worse of the two failures.
      throw new Error(
        `payment ${row.id} references invoice ${row.invoice_id}, which is not ` +
          `readable. That should be impossible under the 0002 policies — check ` +
          `whether payment_events_select_own_merchant and invoices_select_own ` +
          `still agree on scope.`,
      );
    }

    return {
      ...toPaymentRecord(row),
      invoiceTitle: invoice.title,
      invoiceStatus: invoice.status,
      invoiceUsdAmount: toDecimalString(invoice.usd_amount, 'invoices.usd_amount'),
    };
  });

  return { payments, total: count ?? payments.length };
}

type InvoiceLabel = Pick<InvoiceRow, 'id' | 'title' | 'status' | 'usd_amount'>;

/** The second half of the join: the invoices this page of payments points at. */
async function fetchInvoiceLabels(
  db: FluxaClient,
  rows: readonly PaymentEventRow[],
): Promise<Map<string, InvoiceLabel>> {
  const ids = [...new Set(rows.map((row) => row.invoice_id))];

  const { data, error } = await db
    .from('invoices')
    .select('id, title, status, usd_amount')
    .in('id', ids);

  if (error !== null) throw dbError('reading the invoices for a payment history', error);

  return new Map((data as InvoiceLabel[]).map((row) => [row.id, row]));
}

/**
 * Whether an invoice has payment evidence the merchant can see.
 *
 * A cheaper question than fetching the rows, and a different one from
 * `invoice.status === 'PAID'`: PENDING with one FDC attestation still in
 * SUBMITTED has evidence and no payment. The pay page uses this to decide whether
 * to show a timeline at all.
 */
export async function countInvoicePayments(
  db: FluxaClient,
  invoiceId: string,
): Promise<number> {
  const id = assertUuid(invoiceId, 'invoiceId');

  const { count, error } = await db
    .from('payment_events')
    .select('id', { count: 'exact', head: true })
    .eq('invoice_id', id);

  if (error !== null) throw dbError(`counting payments for invoice ${id}`, error);
  return count ?? 0;
}
