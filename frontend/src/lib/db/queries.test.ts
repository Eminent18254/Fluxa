/**
 * The query layer: what request each function actually sends.
 *
 * These do not talk to Postgres. They prove the half of correctness a live
 * database would hide — that the layer asks the right question — by recording every
 * call and asserting on its shape. The other half (that the policies answer it
 * correctly) is proved against a real database in task 5, not here.
 *
 * The recurring assertions are the ones that map to a specific way this schema
 * bites back:
 *
 *   - no `merchant_id` filter on a read: RLS scopes the table, and adding the
 *     filter would imply the policy might not.
 *   - a write payload that is exactly the granted columns: anything else is a
 *     42501 waiting to happen, and the type would have caught it first.
 *   - a checksummed address lowercased before it is sent: the CHECK stores
 *     lowercase, wagmi hands out EIP-55.
 *   - a zero-row write reported, not swallowed: PostgREST calls it success.
 */
import { describe, expect, it } from 'vitest';

import {
  cancelInvoice,
  countInvoicePayments,
  createInvoiceDraft,
  deleteDraft,
  getInvoice,
  getInvoiceByReference,
  getInvoiceSummary,
  getPublicInvoice,
  getPublicInvoiceEvents,
  getPublicInvoicePage,
  listInvoicePayments,
  listInvoices,
  listPaymentHistory,
  listPaymentsByTx,
  prepareInvoiceForChain,
  updateInvoice,
} from '@/lib/db';
import { pgError, stubReturning, supabaseStub } from '@/test/supabaseStub';
import {
  INVOICE_ID,
  invoiceRow,
  MERCHANT_ID,
  paymentEventRow,
  publicInvoice,
  publicInvoiceEvent,
  REFERENCE,
  TX_HASH,
} from '@/test/fixtures';

const CHECKSUMMED = '0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B';

// ---------------------------------------------------------------------------
// invoices — reads
// ---------------------------------------------------------------------------

describe('listInvoices', () => {
  it('reads the merchant page without a merchant_id filter, newest first', async () => {
    const { db, only } = stubReturning({ data: [invoiceRow()], count: 1 });

    const result = await listInvoices(db);
    const call = only();

    expect(call.table).toBe('invoices');
    expect(call.method).toBe('select');
    expect(call.count).toBe('exact');
    expect(call.order).toEqual([{ column: 'created_at', ascending: false }]);
    expect(call.range).toEqual({ from: 0, to: 49 });
    // The point of the test: RLS does the scoping, so the query must not.
    expect(call.filters.some((f) => f.column === 'merchant_id')).toBe(false);
    expect(result.total).toBe(1);
    expect(result.invoices[0]?.id).toBe(INVOICE_ID);
  });

  it('clamps the page window rather than trusting the caller', async () => {
    const { db, only } = stubReturning({ data: [], count: 0 });
    await listInvoices(db, { limit: 9000, offset: -5 });
    // limit clamps to 200, offset floors to 0 → range(0, 199).
    expect(only().range).toEqual({ from: 0, to: 199 });
  });

  it('filters by status when asked', async () => {
    const { db, only } = stubReturning({ data: [], count: 0 });
    await listInvoices(db, { status: ['OPEN', 'PENDING'] });
    expect(only().filters).toContainEqual({
      op: 'in',
      column: 'status',
      value: ['OPEN', 'PENDING'],
    });
  });

  it('strips PostgREST filter syntax out of a search term', async () => {
    const { db, only } = stubReturning({ data: [], count: 0 });
    // Commas and parens are `or=` syntax; left in, they would reinterpret the
    // filter rather than search for the text.
    await listInvoices(db, { search: 'foo, bar (baz)*' });

    const or = only().filters.find((f) => f.op === 'or');
    expect(or?.value).toBe('title.ilike.%foo bar baz%,description.ilike.%foo bar baz%');
  });

  it('drops a search that is nothing but filter syntax', async () => {
    const { db, only } = stubReturning({ data: [], count: 0 });
    await listInvoices(db, { search: '()*' });
    expect(only().filters.some((f) => f.op === 'or')).toBe(false);
  });
});

describe('getInvoice', () => {
  it('looks one up by id and maps it', async () => {
    const { db, only } = stubReturning({ data: invoiceRow() });
    const invoice = await getInvoice(db, INVOICE_ID);

    expect(only().single).toBe('maybeSingle');
    expect(only().filters).toContainEqual({ op: 'eq', column: 'id', value: INVOICE_ID });
    expect(invoice?.tokenAmount).toBe(104500000n);
  });

  it('returns null for an absent row without claiming why', async () => {
    const { db } = stubReturning({ data: null });
    expect(await getInvoice(db, INVOICE_ID)).toBeNull();
  });

  it('rejects a malformed id before any query goes out', async () => {
    const { db, calls } = stubReturning({ data: null });
    await expect(getInvoice(db, 'not-a-uuid')).rejects.toThrow(/invoiceId/);
    expect(calls).toHaveLength(0);
  });
});

describe('getInvoiceByReference', () => {
  it('lowercases the reference to match the stored form', async () => {
    const { db, only } = stubReturning({ data: invoiceRow() });
    await getInvoiceByReference(db, REFERENCE.toUpperCase().replace('0X', '0x'));
    expect(only().filters).toContainEqual({
      op: 'eq',
      column: 'invoice_reference',
      value: REFERENCE,
    });
  });
});

describe('getInvoiceSummary', () => {
  it('sums outstanding and paid in integer micro-dollars', async () => {
    const { db } = stubReturning({
      data: [
        { status: 'OPEN', usd_amount: '250.000000' },
        { status: 'PENDING', usd_amount: '0.100000' },
        { status: 'PAID', usd_amount: '99.990000' },
        { status: 'SETTLED', usd_amount: '0.010000' },
        { status: 'DRAFT', usd_amount: '5.000000' },
      ],
    });

    const summary = await getInvoiceSummary(db);

    expect(summary.total).toBe(5);
    expect(summary.byStatus.OPEN).toBe(1);
    // 250 + 0.1, added as micros so the tenth of a dollar is exact.
    expect(summary.outstandingUsd).toBe('250.100000');
    expect(summary.paidUsd).toBe('100.000000');
  });
});

// ---------------------------------------------------------------------------
// invoices — writes
// ---------------------------------------------------------------------------

describe('createInvoiceDraft', () => {
  it('inserts exactly the granted columns and nothing about outcome', async () => {
    const { db, only } = stubReturning({ data: invoiceRow() });

    await createInvoiceDraft(db, {
      merchantId: MERCHANT_ID,
      title: '  Consulting, August  ',
      usdAmount: 250,
      tokenSymbol: 'FXRP',
      dueAt: '2026-09-01T00:00:00Z',
      customerAddress: CHECKSUMMED,
    });

    const payload = only().payload as Record<string, unknown>;

    expect(payload.title).toBe('Consulting, August');
    expect(payload.usd_amount).toBe('250');
    expect(payload.due_at).toBe('2026-09-01T00:00:00.000Z');
    // Checksummed in, lowercase out.
    expect(payload.customer_address).toBe(CHECKSUMMED.toLowerCase());

    // The columns the browser must never write, absent by construction.
    expect(payload).not.toHaveProperty('status');
    expect(payload).not.toHaveProperty('token_amount');
    expect(payload).not.toHaveProperty('payment_tx_hash');
    expect(payload).not.toHaveProperty('paid_at');
  });

  it('refuses a blank title before sending it', async () => {
    const { db, calls } = stubReturning({ data: invoiceRow() });
    await expect(
      createInvoiceDraft(db, {
        merchantId: MERCHANT_ID,
        title: '   ',
        usdAmount: 10,
        tokenSymbol: 'FXRP',
        dueAt: '2026-09-01T00:00:00Z',
      }),
    ).rejects.toThrow(/needs a title/);
    expect(calls).toHaveLength(0);
  });

  it('refuses a non-positive amount', async () => {
    const { db } = stubReturning({ data: invoiceRow() });
    await expect(
      createInvoiceDraft(db, {
        merchantId: MERCHANT_ID,
        title: 'x',
        usdAmount: 0,
        tokenSymbol: 'FXRP',
        dueAt: '2026-09-01T00:00:00Z',
      }),
    ).rejects.toThrow(/greater than zero/);
  });
});

describe('updateInvoice', () => {
  it('patches only the fields provided', async () => {
    const { db, only } = stubReturning({ data: invoiceRow({ title: 'New' }) });
    await updateInvoice(db, INVOICE_ID, { title: 'New' });

    const payload = only().payload as Record<string, unknown>;
    expect(payload).toEqual({ title: 'New' });
    expect(only().single).toBe('maybeSingle');
  });

  it('reports a zero-row update rather than pretending it happened', async () => {
    // The update matched nothing — the invoice is paid, or not the caller's.
    // PostgREST calls that success with no row; the layer must not.
    const { db } = stubReturning({ data: null });
    await expect(updateInvoice(db, INVOICE_ID, { title: 'New' })).rejects.toThrow(
      /not yours, or no longer DRAFT or OPEN/,
    );
  });

  it('translates a column-grant refusal into what it means here', async () => {
    const { db } = stubReturning({
      error: pgError('42501', 'permission denied for table invoices'),
    });
    await expect(updateInvoice(db, INVOICE_ID, { title: 'New' })).rejects.toThrow(
      /column grant/,
    );
  });
});

describe('cancelInvoice', () => {
  it('moves the invoice to CANCELLED', async () => {
    const { db, only } = stubReturning({ data: invoiceRow({ status: 'CANCELLED' }) });
    const invoice = await cancelInvoice(db, INVOICE_ID);

    expect(only().payload).toEqual({ status: 'CANCELLED' });
    expect(invoice.status).toBe('CANCELLED');
  });

  it('reports when there was nothing cancellable', async () => {
    const { db } = stubReturning({ data: null });
    await expect(cancelInvoice(db, INVOICE_ID)).rejects.toThrow(/was not cancelled/);
  });
});

describe('deleteDraft', () => {
  it('accepts a delete that removed a row', async () => {
    const { db, only } = stubReturning({ data: [{ id: INVOICE_ID }] });
    await expect(deleteDraft(db, INVOICE_ID)).resolves.toBeUndefined();
    expect(only().method).toBe('delete');
  });

  it('reports a delete that matched nothing', async () => {
    // Not a DRAFT — the policy filtered it, and an empty result is the only
    // signal PostgREST gives.
    const { db } = stubReturning({ data: [] });
    await expect(deleteDraft(db, INVOICE_ID)).rejects.toThrow(/was not deleted/);
  });
});

describe('prepareInvoiceForChain', () => {
  it('sends the price whole and returns the reference to publish', async () => {
    const { db, only } = stubReturning({ data: REFERENCE });

    const reference = await prepareInvoiceForChain(db, {
      invoiceId: INVOICE_ID,
      tokenAmount: 104500000n,
      tokenSymbol: 'FXRP',
      price: { raw: 2392537n, decimals: 6, at: '2026-08-01T10:00:05Z' },
    });

    const call = only();
    expect(call.kind).toBe('rpc');
    expect(call.fn).toBe('prepare_invoice_for_chain');
    expect(call.args).toEqual({
      p_invoice_id: INVOICE_ID,
      p_token_amount: '104500000',
      p_token_symbol: 'FXRP',
      // Raw oracle value and its exponent travel together, never pre-divided.
      p_price_usd: '2392537',
      p_price_decimals: 6,
      p_price_timestamp: '2026-08-01T10:00:05.000Z',
    });
    expect(reference).toBe(REFERENCE);
  });

  it('refuses a non-positive token amount', async () => {
    const { db, calls } = stubReturning({ data: REFERENCE });
    await expect(
      prepareInvoiceForChain(db, {
        invoiceId: INVOICE_ID,
        tokenAmount: 0n,
        tokenSymbol: 'FXRP',
        price: { raw: 2392537n, decimals: 6, at: '2026-08-01T10:00:05Z' },
      }),
    ).rejects.toThrow(/positive number of base units/);
    expect(calls).toHaveLength(0);
  });

  it('explains a missing function as unapplied migrations', async () => {
    const { db } = stubReturning({
      error: pgError('42883', 'function prepare_invoice_for_chain(...) does not exist'),
    });
    await expect(
      prepareInvoiceForChain(db, {
        invoiceId: INVOICE_ID,
        tokenAmount: 1n,
        tokenSymbol: 'FXRP',
        price: { raw: 1n, decimals: 6, at: '2026-08-01T10:00:05Z' },
      }),
    ).rejects.toThrow(/migrations/);
  });
});

// ---------------------------------------------------------------------------
// payments
// ---------------------------------------------------------------------------

describe('listInvoicePayments', () => {
  it('orders by created_at then log_index, newest first', async () => {
    const { db, only } = stubReturning({ data: [paymentEventRow()] });
    const records = await listInvoicePayments(db, INVOICE_ID);

    const call = only();
    expect(call.filters).toContainEqual({ op: 'eq', column: 'invoice_id', value: INVOICE_ID });
    expect(call.order).toEqual([
      { column: 'created_at', ascending: false },
      { column: 'log_index', ascending: false },
    ]);
    expect(records[0]?.logIndex).toBe(2);
    expect(records[0]?.amountUnits).toBe(104500000n);
  });
});

describe('listPaymentsByTx', () => {
  it('lowercases the hash and orders by log_index within the transaction', async () => {
    const { db, only } = stubReturning({ data: [] });
    await listPaymentsByTx(db, TX_HASH.toUpperCase().replace('0X', '0x'));

    const call = only();
    expect(call.filters).toContainEqual({ op: 'eq', column: 'tx_hash', value: TX_HASH });
    expect(call.order).toEqual([{ column: 'log_index', ascending: true }]);
  });
});

describe('listPaymentHistory', () => {
  it('joins each payment to its invoice in a second query', async () => {
    const { db, calls } = supabaseStub((call) => {
      if (call.table === 'payment_events') return { data: [paymentEventRow()], count: 1 };
      if (call.table === 'invoices') {
        return {
          data: [{ id: INVOICE_ID, title: 'Consulting, August', status: 'OPEN', usd_amount: '250.000000' }],
        };
      }
      return { data: [] };
    });

    const { payments, total } = await listPaymentHistory(db);

    expect(calls).toHaveLength(2);
    expect(total).toBe(1);
    expect(payments[0]?.invoiceTitle).toBe('Consulting, August');
    expect(payments[0]?.invoiceUsdAmount).toBe('250.000000');
    expect(payments[0]?.amountUnits).toBe(104500000n);
  });

  it('skips the second query when the first page is empty', async () => {
    const { db, calls } = supabaseStub(() => ({ data: [], count: 0 }));
    const { payments } = await listPaymentHistory(db);
    expect(payments).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it('applies every filter to the payment_events query', async () => {
    const { db, calls } = supabaseStub((call) =>
      call.table === 'payment_events' ? { data: [], count: 0 } : { data: [] },
    );

    await listPaymentHistory(db, {
      invoiceId: INVOICE_ID,
      rail: 'XRPL_NATIVE',
      attestationStatus: ['VERIFIED'],
      since: '2026-08-01T00:00:00Z',
    });

    const f = calls[0]!.filters;
    expect(f).toContainEqual({ op: 'eq', column: 'invoice_id', value: INVOICE_ID });
    expect(f).toContainEqual({ op: 'eq', column: 'rail', value: 'XRPL_NATIVE' });
    expect(f).toContainEqual({ op: 'in', column: 'attestation_status', value: ['VERIFIED'] });
    expect(f).toContainEqual({
      op: 'gte',
      column: 'created_at',
      value: '2026-08-01T00:00:00.000Z',
    });
  });

  it('refuses to silently drop payment evidence it cannot label', async () => {
    // A payment whose invoice is unreadable should be impossible under the 0002
    // policies; if it happens, that is a scope regression, not a row to hide.
    const { db } = supabaseStub((call) =>
      call.table === 'payment_events' ? { data: [paymentEventRow()], count: 1 } : { data: [] },
    );
    await expect(listPaymentHistory(db)).rejects.toThrow(/not readable/);
  });
});

describe('countInvoicePayments', () => {
  it('asks for a head count, not the rows', async () => {
    const { db, only } = stubReturning({ count: 3 });
    const count = await countInvoicePayments(db, INVOICE_ID);

    const call = only();
    expect(call.head).toBe(true);
    expect(call.count).toBe('exact');
    expect(count).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// public invoice — the payer's path
// ---------------------------------------------------------------------------

describe('getPublicInvoice', () => {
  it('reads through the SECURITY DEFINER function and takes the first row', async () => {
    const { db, only } = supabaseStub(() => ({ data: [publicInvoice()] }));
    const view = await getPublicInvoice(db, INVOICE_ID);

    const call = only();
    expect(call.kind).toBe('rpc');
    expect(call.fn).toBe('get_public_invoice');
    expect(call.args).toEqual({ p_invoice_id: INVOICE_ID });
    expect(view?.merchantName).toBe('Acme Coffee');
    // The payer's projection carries no merchant id.
    expect(view).not.toHaveProperty('merchantId');
  });

  it('returns null for a withheld invoice, and the empty set reads the same', async () => {
    const { db } = supabaseStub(() => ({ data: [] }));
    expect(await getPublicInvoice(db, INVOICE_ID)).toBeNull();
  });

  it('treats a malformed id as a bad link, not a database error', async () => {
    const { db, calls } = supabaseStub(() => ({ data: [] }));
    expect(await getPublicInvoice(db, '../../etc/passwd')).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe('getPublicInvoiceEvents', () => {
  it('maps the public payment rows', async () => {
    const { db } = supabaseStub(() => ({ data: [publicInvoiceEvent()] }));
    const events = await getPublicInvoiceEvents(db, INVOICE_ID);
    expect(events).toHaveLength(1);
    expect(events[0]?.amountUnits).toBe(104500000n);
  });

  it('returns empty for a malformed id without a query', async () => {
    const { db, calls } = supabaseStub(() => ({ data: [] }));
    expect(await getPublicInvoiceEvents(db, 'nope')).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe('getPublicInvoicePage', () => {
  it('fetches invoice and events together and computes payable', async () => {
    const { db, calls } = supabaseStub((call) => {
      if (call.fn === 'get_public_invoice') return { data: [publicInvoice()] };
      if (call.fn === 'get_public_invoice_events') return { data: [publicInvoiceEvent()] };
      return { data: [] };
    });

    const page = await getPublicInvoicePage(db, INVOICE_ID);

    expect(calls).toHaveLength(2);
    expect(page?.invoice.title).toBe('Consulting, August');
    expect(page?.payments).toHaveLength(1);
    // OPEN, quoted, and linked on-chain — genuinely payable.
    expect(page?.payable).toBe(true);
  });

  it('is null when the invoice is withheld, even though both calls fire', async () => {
    const { db, calls } = supabaseStub(() => ({ data: [] }));
    expect(await getPublicInvoicePage(db, INVOICE_ID)).toBeNull();
    expect(calls).toHaveLength(2);
  });

  it('is not payable when the invoice exists but the chain has not linked it', async () => {
    const { db } = supabaseStub((call) => {
      if (call.fn === 'get_public_invoice') {
        return { data: [publicInvoice({ onchain_invoice_id: null })] };
      }
      return { data: [] };
    });

    const page = await getPublicInvoicePage(db, INVOICE_ID);
    expect(page?.payable).toBe(false);
  });
});
