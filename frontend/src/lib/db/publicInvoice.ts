/**
 * The payer's view of an invoice — the only path that works without an account.
 *
 * 0002 gives `anon` no SELECT policy on any table, deliberately: a policy like
 * `using (status = 'OPEN')` would let anyone page through every open invoice in
 * the system, which is a customer list. So public access is two SECURITY DEFINER
 * functions that take the invoice id and return a fixed, narrow projection.
 *
 * The id in the URL is the credential. It is a v4 UUID — unguessable, and the same
 * model every payment link on the internet uses — which is why this module never
 * exposes a way to list, search or enumerate. You can only ask about an id you
 * already have.
 *
 * `get_public_invoice` withholds DRAFT and CANCELLED rows itself, so a link shared
 * before publishing renders "not found" rather than a payable page with no
 * reference on it. That check lives in SQL and not here, because a check in the
 * browser is a suggestion.
 */
import type { FluxaClient } from '@/lib/supabase';
import type { PublicInvoice, PublicInvoiceEvent } from '@/types/database';

import { dbError } from './errors';
import { isUuid } from './identifiers';
import {
  isPayable,
  toPublicInvoiceView,
  toPublicPayment,
  type PublicInvoiceView,
  type PublicPayment,
} from './model';

/**
 * One invoice by id, as a payer sees it. Null when there is nothing to show.
 *
 * Null covers four cases on purpose: no such invoice, a DRAFT, a CANCELLED one,
 * and a malformed id. The page renders the same thing for all four, and telling
 * them apart would be telling a stranger which ids exist.
 *
 * A malformed id returns null rather than throwing, because this id came out of a
 * URL bar. Everywhere else in this layer a bad id is a bug and throws; here it is
 * a bad link, and a bad link deserves a page, not a stack trace.
 */
export async function getPublicInvoice(
  db: FluxaClient,
  invoiceId: string,
): Promise<PublicInvoiceView | null> {
  if (!isUuid(invoiceId)) return null;
  const id = invoiceId.trim().toLowerCase();

  const { data, error } = await db.rpc('get_public_invoice', { p_invoice_id: id });
  if (error !== null) throw dbError(`reading public invoice ${id}`, error);

  // `returns table` gives a set, so zero rows for an unknown or withheld id.
  const rows = (data ?? []) as PublicInvoice[];
  const row = rows[0];
  return row === undefined ? null : toPublicInvoiceView(row);
}

/**
 * Public payment evidence for one invoice, newest first.
 *
 * Empty for an unknown or withheld invoice — the function joins to `invoices` and
 * applies the same status filter, so it cannot leak the payments of a draft.
 */
export async function getPublicInvoiceEvents(
  db: FluxaClient,
  invoiceId: string,
): Promise<PublicPayment[]> {
  if (!isUuid(invoiceId)) return [];
  const id = invoiceId.trim().toLowerCase();

  const { data, error } = await db.rpc('get_public_invoice_events', { p_invoice_id: id });
  if (error !== null) throw dbError(`reading public payments for invoice ${id}`, error);

  return ((data ?? []) as PublicInvoiceEvent[]).map(toPublicPayment);
}

export type PublicInvoicePage = {
  invoice: PublicInvoiceView;
  payments: PublicPayment[];
  /**
   * Whether the pay button should do anything.
   *
   * Not `status === 'OPEN'`. `FluxaInvoice.payInvoice` takes an on-chain invoice
   * id, so an invoice that exists only in Postgres cannot be paid however open it
   * looks, and without `tokenAmount` there is no figure to quote. Computed here so
   * the page cannot forget — see `isPayable` in `model.ts`.
   */
  payable: boolean;
};

/**
 * Everything the pay page needs, in one call.
 *
 * The two requests go out together rather than in sequence: the events query is
 * independent of the invoice one, and a payment link opened on a phone should not
 * wait out two serial round-trips to a Supabase region.
 */
export async function getPublicInvoicePage(
  db: FluxaClient,
  invoiceId: string,
): Promise<PublicInvoicePage | null> {
  const [invoice, payments] = await Promise.all([
    getPublicInvoice(db, invoiceId),
    getPublicInvoiceEvents(db, invoiceId),
  ]);

  if (invoice === null) return null;

  return { invoice, payments, payable: isPayable(invoice) };
}
