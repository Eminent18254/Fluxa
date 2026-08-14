/**
 * The value layer: numbers, identifiers, error translation, row mapping.
 *
 * No stub client and no I/O — these are the pure functions everything else is
 * built on, and they are where the expensive bugs live. A wrong `or=` filter shows
 * up as an empty list someone notices. A NUMERIC read as a double shows up as a
 * payment that is off by a few base units, months later, in a reconciliation.
 */
import { describe, expect, it } from 'vitest';

import { dbError } from '@/lib/db/errors';
import {
  assertUuid,
  isUuid,
  toStoredAddress,
  toStoredAddressOrNull,
  toStoredHash,
} from '@/lib/db/identifiers';
import {
  isOverdue,
  isPayable,
  isTerminal,
  toInvoice,
  toMerchant,
  toPaymentRecord,
  toPublicInvoiceView,
} from '@/lib/db/model';
import {
  fromBigInt,
  priceToNumber,
  toBigInt,
  toBigIntOrNull,
  toDecimalString,
  toNumberOrNull,
  toUsdNumber,
} from '@/lib/db/numeric';
import { pgError } from '@/test/supabaseStub';
import {
  BIG_UNITS,
  CUSTOMER,
  invoiceRow,
  merchantRow,
  paymentEventRow,
  publicInvoice,
  TX_HASH,
  WALLET,
} from '@/test/fixtures';

describe('numeric', () => {
  it('reads a uint256-scale NUMERIC exactly when it arrives as a string', () => {
    expect(toBigInt(BIG_UNITS, 'amount')).toBe(123456789012345678901234567890n);
  });

  it('refuses a value that already lost precision as a JSON number', () => {
    // What PostgREST hands over if it ever serialises NUMERIC unquoted: the exact
    // value is gone before this function is called, so there is nothing to
    // recover and nothing honest to return.
    const lossy = Number(BIG_UNITS);
    expect(() => toBigInt(lossy, 'invoices.token_amount')).toThrow(
      /invoices\.token_amount/,
    );
    expect(() => toBigInt(lossy, 'invoices.token_amount')).toThrow(/::text/);
  });

  it('accepts a safe integer arriving as a JSON number', () => {
    expect(toBigInt(104500000, 'amount')).toBe(104500000n);
  });

  it('drops a zero fraction from a NUMERIC widened through a function return', () => {
    expect(toBigInt('495483667.000000', 'amount')).toBe(495483667n);
  });

  it('refuses a fractional base-unit amount', () => {
    expect(() => toBigInt('1.5', 'amount')).toThrow(/not a whole number of base units/);
  });

  it('refuses text that is not a number at all', () => {
    expect(() => toBigInt('1e9', 'amount')).toThrow(/not a number/);
  });

  it('passes null through', () => {
    expect(toBigIntOrNull(null, 'amount')).toBeNull();
    expect(toBigIntOrNull(undefined, 'amount')).toBeNull();
    expect(toNumberOrNull(null, 'block')).toBeNull();
  });

  it('keeps a scaled NUMERIC as exact text rather than round-tripping a double', () => {
    expect(toDecimalString('250.000000', 'usd')).toBe('250.000000');
    expect(toUsdNumber('250.000000', 'usd')).toBe(250);
  });

  it('divides an FTSO price by that feed exponent, not a constant', () => {
    // XRP/USD reports 6 decimals, FLR/USD reports 8. Same raw value, two prices.
    expect(priceToNumber('2392537', 6, 'price')).toBeCloseTo(2.392537, 9);
    expect(priceToNumber('2392537', 8, 'price')).toBeCloseTo(0.02392537, 11);
  });

  it('reports no price rather than a guessed one when the exponent is missing', () => {
    expect(priceToNumber('2392537', null, 'price')).toBeNull();
  });

  it('writes amounts as exact decimal text', () => {
    expect(fromBigInt(123456789012345678901234567890n)).toBe(BIG_UNITS);
  });
});

describe('identifiers', () => {
  it('lowercases the EIP-55 address wagmi hands out', () => {
    // The trap this closes: viem returns checksummed addresses, 0001 CHECKs for
    // ^0x[0-9a-f]{40}$, and the mismatch surfaces as SQLSTATE 23514 at write time.
    const checksummed = '0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B';
    expect(toStoredAddress(checksummed)).toBe(checksummed.toLowerCase());
  });

  it('rejects a malformed address instead of lowercasing it', () => {
    expect(() => toStoredAddress('0x1234', 'customerAddress')).toThrow(/customerAddress/);
    expect(() => toStoredAddress('not-an-address')).toThrow(/20-byte hex address/);
  });

  it('treats an empty address as absent', () => {
    expect(toStoredAddressOrNull('')).toBeNull();
    expect(toStoredAddressOrNull('   ')).toBeNull();
    expect(toStoredAddressOrNull(null)).toBeNull();
    expect(toStoredAddressOrNull(WALLET)).toBe(WALLET);
  });

  it('lowercases a 32-byte hash and rejects a short one', () => {
    expect(toStoredHash(TX_HASH.toUpperCase().replace('0X', '0x'))).toBe(TX_HASH);
    expect(() => toStoredHash('0xdead', 'reference')).toThrow(/32-byte hex value/);
  });

  it('recognises a v4 uuid and refuses anything else', () => {
    expect(isUuid('22222222-2222-4222-8222-222222222222')).toBe(true);
    expect(isUuid('22222222222242228222222222222222')).toBe(false);
    expect(isUuid('../../etc/passwd')).toBe(false);
    expect(() => assertUuid('nope', 'invoiceId')).toThrow(/invoiceId/);
  });
});

describe('dbError', () => {
  it('explains a column-grant refusal as a grant failure, not an RLS one', () => {
    const error = dbError(
      'updating invoice',
      pgError('42501', 'permission denied for table invoices'),
    );
    expect(error.code).toBe('42501');
    expect(error.message).toContain('updating invoice');
    expect(error.message).toContain('42501:');
    expect(error.message).toContain('column grant');
  });

  it('passes a migration `raise exception` through unembellished', () => {
    // Those messages were written to be read by whoever hits them. Appending a
    // generic gloss would bury the specific one.
    const error = dbError('preparing invoice', pgError('P0001', 'invoice is not a DRAFT'));
    expect(error.message).toBe('preparing invoice: invoice is not a DRAFT');
  });

  it('adds nothing to a code it has no opinion about', () => {
    const error = dbError('reading', pgError('08006', 'connection failure'));
    expect(error.message).toBe('reading: connection failure');
  });
});

describe('row mapping', () => {
  it('resolves a merchant payout address to the wallet when unset', () => {
    // The same coalesce get_public_invoice applies, so both paths agree on where
    // money goes.
    expect(toMerchant(merchantRow()).settlementAddress).toBe(WALLET);
    expect(
      toMerchant(merchantRow({ settlement_address: CUSTOMER })).settlementAddress,
    ).toBe(CUSTOMER);
  });

  it('maps an invoice to bigint amounts and a priced snapshot', () => {
    const invoice = toInvoice(invoiceRow());

    expect(invoice.tokenAmount).toBe(104500000n);
    expect(invoice.usdAmount).toBe('250.000000');
    expect(invoice.usdAmountNumber).toBe(250);
    expect(invoice.price).toEqual({
      raw: '2392537',
      decimals: 6,
      usd: 2.392537,
      at: '2026-08-01T10:00:05.000Z',
    });
    expect(invoice.settlement).toBeNull();
  });

  it('names the column when an amount arrives imprecise', () => {
    const row = invoiceRow({ token_amount: Number(BIG_UNITS) });
    expect(() => toInvoice(row)).toThrow(/invoices\.token_amount/);
  });

  it('reports no quote for an unpriced draft', () => {
    const invoice = toInvoice(
      invoiceRow({
        status: 'DRAFT',
        token_amount: null,
        price_usd: null,
        price_decimals: null,
        price_timestamp: null,
        invoice_reference: null,
        onchain_invoice_id: null,
      }),
    );

    expect(invoice.tokenAmount).toBeNull();
    expect(invoice.price).toBeNull();
  });

  it('surfaces settlement only once the chain has reported it', () => {
    const invoice = toInvoice(
      invoiceRow({
        status: 'SETTLED',
        settled_at: '2026-08-02T09:20:00.000Z',
        settlement_tx_hash: TX_HASH,
        settled_token_symbol: 'USDT0',
        settled_amount_units: '250000000',
        settled_to_address: WALLET,
        settlement_price_usd: '2401200',
        settlement_price_decimals: 6,
        settlement_price_timestamp: '2026-08-02T09:19:55.000Z',
      }),
    );

    expect(invoice.settlement).not.toBeNull();
    // Pay in FXRP, settle in USDT0 — the settled symbol is its own fact.
    expect(invoice.settlement?.tokenSymbol).toBe('USDT0');
    expect(invoice.settlement?.amountUnits).toBe(250000000n);
    // And the payout price is not the invoice's quote.
    expect(invoice.settlement?.price?.raw).toBe('2401200');
    expect(invoice.price?.raw).toBe('2392537');
  });

  it('keeps a payment event id as a string, since it is a key and not a number', () => {
    const record = toPaymentRecord(paymentEventRow({ id: 9007199254740993 as unknown as string }));
    expect(typeof record.id).toBe('string');
  });

  it('maps payment evidence including the log index that makes it unique', () => {
    const record = toPaymentRecord(paymentEventRow());
    expect(record.amountUnits).toBe(104500000n);
    expect(record.logIndex).toBe(2);
    expect(record.blockNumber).toBe(20481933);
    expect(record.txHash).toBe(TX_HASH);
  });

  it('maps the public view without a merchant id on it', () => {
    const view = toPublicInvoiceView(publicInvoice());
    expect(view.merchantAddress).toBe(WALLET);
    expect(view.tokenAmount).toBe(104500000n);
    expect(view).not.toHaveProperty('merchantId');
    expect(view).not.toHaveProperty('email');
  });
});

describe('derived state', () => {
  it('treats an invoice as payable only when the chain knows about it', () => {
    const base = { status: 'OPEN' as const, tokenAmount: 1n, onchainInvoiceId: '7' };

    expect(isPayable(base)).toBe(true);
    // OPEN in Postgres, absent from Coston2: payInvoice takes an on-chain id, so
    // there is nothing to call.
    expect(isPayable({ ...base, onchainInvoiceId: null })).toBe(false);
    // Published but never quoted: no figure to show the payer.
    expect(isPayable({ ...base, tokenAmount: null })).toBe(false);
    expect(isPayable({ ...base, status: 'DRAFT' })).toBe(false);
    expect(isPayable({ ...base, status: 'PAID' })).toBe(false);
    // PENDING is payable: a Rail B attestation in flight has not landed yet.
    expect(isPayable({ ...base, status: 'PENDING' })).toBe(true);
  });

  it('knows which statuses are final', () => {
    expect(isTerminal('PAID')).toBe(true);
    expect(isTerminal('SETTLED')).toBe(true);
    expect(isTerminal('CANCELLED')).toBe(true);
    expect(isTerminal('EXPIRED')).toBe(true);
    expect(isTerminal('OPEN')).toBe(false);
    expect(isTerminal('PENDING')).toBe(false);
  });

  it('derives overdue from the clock, because nothing sweeps EXPIRED', () => {
    const now = new Date('2026-09-02T00:00:00.000Z');
    const dueAt = '2026-09-01T00:00:00.000Z';

    expect(isOverdue({ status: 'OPEN', dueAt }, now)).toBe(true);
    expect(isOverdue({ status: 'PENDING', dueAt }, now)).toBe(true);
    // A paid invoice is not overdue however long ago it was due.
    expect(isOverdue({ status: 'PAID', dueAt }, now)).toBe(false);
    expect(isOverdue({ status: 'DRAFT', dueAt }, now)).toBe(false);
    expect(
      isOverdue({ status: 'OPEN', dueAt }, new Date('2026-08-30T00:00:00.000Z')),
    ).toBe(false);
  });
});
