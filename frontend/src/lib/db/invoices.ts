/**
 * Invoices: the merchant's own list, one invoice, and the write path.
 *
 * This is the module that has to respect the schema's division of authority. A
 * merchant owns an invoice's *terms* — title, amount, customer, due date — and
 * owns none of its *outcome*. So there is no function here that writes
 * `paid_at`, `payment_tx_hash` or any settlement column: those are written by the
 * indexer with the service role, from chain evidence, and 0002 excludes them from
 * the `authenticated` grant so an attempt would fail anyway.
 *
 * The one apparent exception is `prepareInvoiceForChain`, which writes
 * `token_amount` and the FTSO snapshot — columns the grant also withholds. It
 * does that through the SECURITY DEFINER function in 0004, which checks ownership
 * and DRAFT status itself and generates the payment reference rather than
 * accepting one. The narrow function is what makes the narrow grant survivable.
 *
 * ## The publish flow, since it is not obvious from the function names
 *
 *   createInvoiceDraft      DRAFT, no reference, no quote
 *   prepareInvoiceForChain  stamps the reference and the FTSO quote, returns the
 *                           reference to publish
 *   (merchant signs FluxaInvoice.createInvoice with that reference)
 *   indexer sees InvoiceCreated, links the on-chain id and moves it to OPEN
 *
 * Nothing here sets OPEN. The invoice becomes payable when the chain says it
 * exists, not when the browser thinks it should.
 */
import type { FluxaClient } from '@/lib/supabase';
import type {
  AssetSymbol,
  InvoiceInsert,
  InvoiceRow,
  InvoiceStatus,
  InvoiceUpdate,
  PaymentRail,
} from '@/types/database';

import { dbError, unwrap } from './errors';
import { assertUuid, toStoredAddressOrNull, toStoredHash } from './identifiers';
import { fromBigInt } from './numeric';
import { toInvoice, type Invoice } from './model';

/** Exact decimal text for a NUMERIC column, validated before it is sent. */
function decimalForWrite(
  value: string | number,
  label: string,
  { positive = false }: { positive?: boolean } = {},
): string {
  const text = typeof value === 'number' ? String(value) : value.trim();
  if (!/^\d+(\.\d+)?$/.test(text)) {
    throw new Error(`${label} must be a non-negative decimal number, got ${JSON.stringify(value)}`);
  }
  if (positive && Number(text) <= 0) {
    throw new Error(`${label} must be greater than zero`);
  }
  return text;
}

function timestampForWrite(value: Date | string, label: string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${label} is not a valid date: ${JSON.stringify(value)}`);
  }
  return date.toISOString();
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export type InvoiceListFilter = {
  /** Restrict to these statuses. Omit for all, including drafts. */
  status?: readonly InvoiceStatus[];
  /** Substring match on title and description. */
  search?: string;
  limit?: number;
  offset?: number;
};

export type InvoiceList = {
  invoices: Invoice[];
  /** Total matching rows, ignoring the page window. */
  total: number;
};

/**
 * PostgREST `or=` filters are a comma-separated expression language, so a search
 * term containing `,` `(` `)` would be parsed as filter syntax rather than as
 * text. Stripped rather than escaped because PostgREST has no escape for them,
 * and a search box is not worth a query the server may misread.
 */
function sanitizeSearch(term: string): string {
  return term.trim().replace(/[,()*\\]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * The merchant's invoices, newest first.
 *
 * No `merchant_id` filter: `invoices_select_own` scopes the table to the caller's
 * own rows, drafts included. Adding the filter would imply the policy might not.
 */
export async function listInvoices(
  db: FluxaClient,
  filter: InvoiceListFilter = {},
): Promise<InvoiceList> {
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
  const offset = Math.max(filter.offset ?? 0, 0);

  let query = db
    .from('invoices')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (filter.status !== undefined && filter.status.length > 0) {
    query = query.in('status', filter.status);
  }

  if (filter.search !== undefined) {
    const term = sanitizeSearch(filter.search);
    if (term !== '') {
      query = query.or(`title.ilike.%${term}%,description.ilike.%${term}%`);
    }
  }

  const { data, error, count } = await query;
  if (error !== null) throw dbError('listing invoices', error);

  return {
    invoices: (data as InvoiceRow[]).map(toInvoice),
    total: count ?? data.length,
  };
}

/**
 * One invoice by id.
 *
 * Null means "no such invoice, or not yours" — RLS filters rows rather than
 * refusing the query, so those two cases are indistinguishable from here. That
 * ambiguity is the design working: distinguishing them would confirm the
 * existence of another merchant's invoice.
 */
export async function getInvoice(db: FluxaClient, invoiceId: string): Promise<Invoice | null> {
  const id = assertUuid(invoiceId, 'invoiceId');

  const { data, error } = await db.from('invoices').select('*').eq('id', id).maybeSingle();

  if (error !== null) throw dbError(`reading invoice ${id}`, error);
  return data === null ? null : toInvoice(data as InvoiceRow);
}

/**
 * One invoice by its payment reference.
 *
 * The merchant's browser holds the reference after publishing — it is the value
 * it just signed a transaction with — and needs the row to watch for the
 * indexer's link. 0004 notes deliberately that this needs no function: a plain
 * select under `invoices_select_own` already scopes it correctly.
 */
export async function getInvoiceByReference(
  db: FluxaClient,
  reference: string,
): Promise<Invoice | null> {
  const stored = toStoredHash(reference, 'reference');

  const { data, error } = await db
    .from('invoices')
    .select('*')
    .eq('invoice_reference', stored)
    .maybeSingle();

  if (error !== null) throw dbError(`reading invoice by reference ${stored}`, error);
  return data === null ? null : toInvoice(data as InvoiceRow);
}

export type InvoiceSummary = {
  total: number;
  byStatus: Record<InvoiceStatus, number>;
  /** Exact decimal text, summed in integer cents to avoid float drift. */
  outstandingUsd: string;
  paidUsd: string;
};

const ZERO_BY_STATUS: Record<InvoiceStatus, number> = {
  DRAFT: 0,
  OPEN: 0,
  PENDING: 0,
  PAID: 0,
  SETTLED: 0,
  EXPIRED: 0,
  CANCELLED: 0,
};

/**
 * Dashboard totals.
 *
 * Aggregated in TypeScript over a projection of two columns, not in SQL. That is
 * a deliberate trade at this scale: a testnet merchant has tens of invoices, and
 * a `count`/`sum` view would need a fifth migration plus a grant to be readable
 * under RLS. If a merchant ever has thousands, this becomes a view with
 * `security_invoker = true` — the query stays the same shape, so the change is
 * local to this function.
 *
 * The sums are accumulated as integer micro-dollars rather than floats. Adding
 * 0.1 to 0.2 in binary floating point is famously not 0.3, and a dashboard that
 * disagrees with the invoice list by a cent is a support ticket.
 */
export async function getInvoiceSummary(db: FluxaClient): Promise<InvoiceSummary> {
  const { data, error } = await db.from('invoices').select('status, usd_amount');
  if (error !== null) throw dbError('summarising invoices', error);

  const rows = data as Pick<InvoiceRow, 'status' | 'usd_amount'>[];
  const byStatus = { ...ZERO_BY_STATUS };

  let outstandingMicros = 0n;
  let paidMicros = 0n;

  for (const row of rows) {
    byStatus[row.status] += 1;

    const text = typeof row.usd_amount === 'string' ? row.usd_amount : String(row.usd_amount);
    const [whole = '0', fraction = ''] = text.split('.');
    const micros = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0').slice(0, 6));

    if (row.status === 'OPEN' || row.status === 'PENDING') outstandingMicros += micros;
    if (row.status === 'PAID' || row.status === 'SETTLED') paidMicros += micros;
  }

  const asDecimal = (micros: bigint): string => {
    const whole = micros / 1_000_000n;
    const fraction = (micros % 1_000_000n).toString().padStart(6, '0');
    return `${whole}.${fraction}`;
  };

  return {
    total: rows.length,
    byStatus,
    outstandingUsd: asDecimal(outstandingMicros),
    paidUsd: asDecimal(paidMicros),
  };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export type CreateInvoiceInput = {
  merchantId: string;
  title: string;
  /** USD, as typed. Exact decimal text — not a float. */
  usdAmount: string | number;
  /** Legacy compatibility field; V2 mirrors the settlement asset here. */
  tokenSymbol: AssetSymbol;
  dueAt: Date | string;
  customerAddress?: string | null;
  description?: string | null;
  rail?: PaymentRail;
  discountPercent?: string | number;
  totalWithDiscount?: string | number | null;
  acceptedPaymentAssets?: readonly AssetSymbol[];
  settlementTokenSymbol?: AssetSymbol;
};

/**
 * Create a DRAFT invoice.
 *
 * DRAFT, always — the status column is left to its default rather than offered as
 * a parameter. An invoice with no payment reference and no quote is not payable
 * whatever its status says, and `get_public_invoice` withholds drafts, so
 * creating one as OPEN would only produce a link that renders nothing.
 */
export async function createInvoiceDraft(
  db: FluxaClient,
  input: CreateInvoiceInput,
): Promise<Invoice> {
  const acceptedPaymentAssets = [...(input.acceptedPaymentAssets ?? [input.tokenSymbol])];
  const settlementTokenSymbol = input.settlementTokenSymbol ?? input.tokenSymbol;
  const erc20Assets: readonly AssetSymbol[] = ['FXRP', 'USDT0'];
  if (
    acceptedPaymentAssets.length < 1 ||
    acceptedPaymentAssets.length > 2 ||
    new Set(acceptedPaymentAssets).size !== acceptedPaymentAssets.length ||
    acceptedPaymentAssets.some((symbol) => !erc20Assets.includes(symbol))
  ) {
    throw new Error('acceptedPaymentAssets must contain FXRP, USDT0, or both exactly once');
  }
  if (!erc20Assets.includes(settlementTokenSymbol)) {
    throw new Error('settlementTokenSymbol must be FXRP or USDT0');
  }

  const insert: InvoiceInsert = {
    merchant_id: input.merchantId,
    title: input.title.trim(),
    usd_amount: decimalForWrite(input.usdAmount, 'usdAmount', { positive: true }),
    // V2 prices dynamically, so the legacy single-token column mirrors the
    // merchant's settlement choice while accepted_payment_assets is payer truth.
    token_symbol: settlementTokenSymbol,
    due_at: timestampForWrite(input.dueAt, 'dueAt'),
    customer_address: toStoredAddressOrNull(input.customerAddress, 'customerAddress'),
    description: input.description ?? null,
    accepted_payment_assets: acceptedPaymentAssets,
    settlement_token_symbol: settlementTokenSymbol,
  };

  if (input.rail !== undefined) insert.rail = input.rail;
  if (input.discountPercent !== undefined) {
    insert.discount_percent = decimalForWrite(input.discountPercent, 'discountPercent');
  }
  if (input.totalWithDiscount !== undefined && input.totalWithDiscount !== null) {
    insert.total_with_discount = decimalForWrite(input.totalWithDiscount, 'totalWithDiscount', {
      positive: true,
    });
  }

  if (insert.title === '') throw new Error('An invoice needs a title');

  const data = unwrap(
    'creating an invoice',
    await db.from('invoices').insert(insert).select('*').single(),
  );

  return toInvoice(data as InvoiceRow);
}

export type EditInvoiceInput = {
  title?: string;
  description?: string | null;
  usdAmount?: string | number;
  tokenSymbol?: AssetSymbol;
  dueAt?: Date | string;
  customerAddress?: string | null;
  rail?: PaymentRail;
  discountPercent?: string | number;
  totalWithDiscount?: string | number | null;
  acceptedPaymentAssets?: readonly AssetSymbol[];
  settlementTokenSymbol?: AssetSymbol;
};

/**
 * Edit an invoice's terms.
 *
 * `invoices_update_own_editable` allows this only while the invoice is DRAFT or
 * OPEN, so editing a paid invoice updates zero rows. That surfaces as a null row
 * from `maybeSingle`, which is reported rather than swallowed — silently
 * accepting an edit that did not happen is how a merchant comes to believe an
 * amount changed when it did not.
 */
export async function updateInvoice(
  db: FluxaClient,
  invoiceId: string,
  edit: EditInvoiceInput,
): Promise<Invoice> {
  const id = assertUuid(invoiceId, 'invoiceId');
  const patch: InvoiceUpdate = {};

  if (edit.title !== undefined) patch.title = edit.title.trim();
  if (edit.description !== undefined) patch.description = edit.description;
  if (edit.usdAmount !== undefined) {
    patch.usd_amount = decimalForWrite(edit.usdAmount, 'usdAmount', { positive: true });
  }
  if (edit.tokenSymbol !== undefined) patch.token_symbol = edit.tokenSymbol;
  if (edit.dueAt !== undefined) patch.due_at = timestampForWrite(edit.dueAt, 'dueAt');
  if (edit.customerAddress !== undefined) {
    patch.customer_address = toStoredAddressOrNull(edit.customerAddress, 'customerAddress');
  }
  if (edit.rail !== undefined) patch.rail = edit.rail;
  if (edit.discountPercent !== undefined) {
    patch.discount_percent = decimalForWrite(edit.discountPercent, 'discountPercent');
  }
  if (edit.totalWithDiscount !== undefined) {
    patch.total_with_discount =
      edit.totalWithDiscount === null
        ? null
        : decimalForWrite(edit.totalWithDiscount, 'totalWithDiscount', { positive: true });
  }
  if (edit.acceptedPaymentAssets !== undefined) {
    patch.accepted_payment_assets = [...edit.acceptedPaymentAssets];
  }
  if (edit.settlementTokenSymbol !== undefined) {
    patch.settlement_token_symbol = edit.settlementTokenSymbol;
  }

  if (Object.keys(patch).length === 0) {
    const current = await getInvoice(db, id);
    if (current === null) throw new Error(`Invoice ${id} not found, or not yours`);
    return current;
  }

  const { data, error } = await db
    .from('invoices')
    .update(patch)
    .eq('id', id)
    .select('*')
    .maybeSingle();

  if (error !== null) throw dbError(`updating invoice ${id}`, error);
  if (data === null) {
    throw new Error(
      `Invoice ${id} was not updated. It is either not yours, or no longer DRAFT or ` +
        `OPEN — a paid or settled invoice is a record and its terms are fixed.`,
    );
  }

  return toInvoice(data as InvoiceRow);
}

/**
 * Withdraw an invoice.
 *
 * CANCELLED is in the update policy's WITH CHECK but not its USING clause, which
 * is exactly right: a merchant may move an OPEN invoice to CANCELLED, and may not
 * then move it back out, because a CANCELLED row no longer satisfies USING.
 */
export async function cancelInvoice(db: FluxaClient, invoiceId: string): Promise<Invoice> {
  const id = assertUuid(invoiceId, 'invoiceId');

  const { data, error } = await db
    .from('invoices')
    .update({ status: 'CANCELLED' })
    .eq('id', id)
    .select('*')
    .maybeSingle();

  if (error !== null) throw dbError(`cancelling invoice ${id}`, error);
  if (data === null) {
    throw new Error(
      `Invoice ${id} was not cancelled. Only a DRAFT or OPEN invoice can be ` +
        `withdrawn; one that has been paid is a record.`,
    );
  }

  return toInvoice(data as InvoiceRow);
}

/**
 * Delete a draft.
 *
 * `invoices_delete_draft` restricts this to DRAFT rows, so the returned row list
 * is how the caller learns whether anything was deleted. A delete that matches
 * nothing is not an error in PostgREST — it is a successful request affecting
 * zero rows, which is indistinguishable from success unless it is checked.
 */
export async function deleteDraft(db: FluxaClient, invoiceId: string): Promise<void> {
  const id = assertUuid(invoiceId, 'invoiceId');

  const data = unwrap(
    `deleting draft ${id}`,
    await db.from('invoices').delete().eq('id', id).select('id'),
  );

  if ((data as { id: string }[]).length === 0) {
    throw new Error(
      `Draft ${id} was not deleted. Only a DRAFT can be deleted — once an invoice ` +
        `has been sent it is a record. Cancel it instead.`,
    );
  }
}

export type PrepareInvoiceInput = {
  invoiceId: string;
  /** Base units of `tokenSymbol` the customer must pay. */
  tokenAmount: bigint;
  tokenSymbol: AssetSymbol;
  /** The FTSOv2 read this quote came from. */
  price: {
    /** The raw oracle value — not divided by anything. */
    raw: bigint | string;
    /** That feed's own exponent, as FTSO reported it. */
    decimals: number;
    at: Date | string;
  };
};

/**
 * Stamp a DRAFT with its payment reference and FTSO quote, and return the
 * reference to publish on-chain.
 *
 * Idempotent by design in 0004: called twice, it returns the reference it
 * generated the first time. That matters because the next step is signing a
 * transaction against the reference — a retry after a dropped response must not
 * hand back a different one, or the merchant publishes an invoice the database
 * cannot recognise.
 *
 * The price is passed whole. A raw value with the wrong exponent is off by orders
 * of magnitude and the database cannot detect it, so the two always travel
 * together, from `useFtsoPrices` through to the column.
 */
export async function prepareInvoiceForChain(
  db: FluxaClient,
  input: PrepareInvoiceInput,
): Promise<string> {
  const id = assertUuid(input.invoiceId, 'invoiceId');

  if (input.tokenAmount <= 0n) {
    throw new Error('tokenAmount must be a positive number of base units');
  }
  if (!Number.isInteger(input.price.decimals) || input.price.decimals < 0) {
    throw new Error(
      `price.decimals must be the exponent FTSO reported, got ${input.price.decimals}`,
    );
  }

  const raw =
    typeof input.price.raw === 'bigint'
      ? fromBigInt(input.price.raw)
      : decimalForWrite(input.price.raw, 'price.raw', { positive: true });

  const { data, error } = await db.rpc('prepare_invoice_for_chain', {
    p_invoice_id: id,
    p_token_amount: fromBigInt(input.tokenAmount),
    p_token_symbol: input.tokenSymbol,
    p_price_usd: raw,
    p_price_decimals: input.price.decimals,
    p_price_timestamp: timestampForWrite(input.price.at, 'price.at'),
  });

  if (error !== null) throw dbError(`preparing invoice ${id} for the chain`, error);
  if (typeof data !== 'string' || data === '') {
    throw new Error(`prepare_invoice_for_chain returned no reference for invoice ${id}`);
  }

  // Checked rather than trusted: this value is about to be signed into a
  // transaction, and the contract's reference is a bytes32.
  return toStoredHash(data, 'invoice reference');
}

export async function prepareInvoiceV2(db: FluxaClient, invoiceId: string): Promise<string> {
  const id = assertUuid(invoiceId, 'invoiceId');
  const { data, error } = await db.rpc('prepare_invoice_v2', { p_invoice_id: id });
  if (error !== null) throw dbError(`preparing V2 invoice ${id} for the chain`, error);
  if (typeof data !== 'string' || data === '') {
    throw new Error(`prepare_invoice_v2 returned no reference for invoice ${id}`);
  }
  return toStoredHash(data, 'invoice reference');
}
