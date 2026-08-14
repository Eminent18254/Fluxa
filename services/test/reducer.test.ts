import { describe, expect, it } from "vitest";

import {
  groupByTransaction,
  reduceRange,
  reduceTransaction,
  type DecodedEvent,
  type ReduceContext,
} from "../src/reducer.js";
import {
  CHAIN_STATUS,
  chainStatusName,
  isForwardTransition,
  toDbStatus,
} from "../src/statusMap.js";

/**
 * These tests exist because the mapping between chain and database is the part
 * of Sprint 4 that can be wrong while looking right. A misfiled rail, a
 * transposed terminal status or a payer that is really the rail's own address
 * all produce a database that loads, renders and lies.
 *
 * They need no network and no Supabase credentials, which is the whole reason
 * the reducer is pure.
 */

const FXRP = "0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0";
const USDT0 = "0xdc64a140aa3e981100a9beca4e685f962f0cf6c9";
const RAIL_ADDRESS = "0x2546bcd3c84621e976d8185a91a922ae77ecec30";
const CUSTOMER = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const MERCHANT = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const PAYMENT_REF = `0x${"ab".repeat(32)}`;
const XRPL_TXID = `0x${"cd".repeat(32)}`;
const XRPL_SENDER_HASH = `0x${"ef".repeat(32)}`;

const ctx: ReduceContext = {
  symbolForToken: (address) => {
    const map: Record<string, "FXRP" | "USDT0"> = { [FXRP]: "FXRP", [USDT0]: "USDT0" };
    return map[address.toLowerCase()] ?? null;
  },
};

let nextLogIndex = 0;

function evt(
  contract: DecodedEvent["contract"],
  name: string,
  args: Record<string, bigint | string>,
  overrides: Partial<DecodedEvent> = {},
): DecodedEvent {
  return {
    contract,
    name,
    args,
    address: contract === "rail" ? RAIL_ADDRESS : `0x${"11".repeat(20)}`,
    txHash: `0x${"22".repeat(32)}`,
    logIndex: nextLogIndex++,
    blockNumber: 1_000,
    blockTimestamp: 1_786_452_368,
    ...overrides,
  };
}

describe("reduceTransaction — Rail A", () => {
  it("records an ERC-20 payment against the address that paid it", () => {
    nextLogIndex = 0;
    const { mutations, warnings } = reduceTransaction(
      [
        evt("invoice", "InvoicePaid", {
          invoiceId: 7n,
          payer: CUSTOMER.toUpperCase(),
          payToken: FXRP,
          amountPaid: 40_000_000n,
          rail: 0n,
        }),
      ],
      ctx,
    );

    expect(warnings).toEqual([]);
    expect(mutations).toHaveLength(1);
    const m = mutations[0]!;
    expect(m.kind).toBe("record_payment");
    if (m.kind !== "record_payment") throw new Error("unreachable");

    expect(m.rail).toBe("FLARE_ERC20");
    expect(m.tokenSymbol).toBe("FXRP");
    expect(m.amountUnits).toBe("40000000");
    // Lowercased, because invoices/payment_events CHECK constraints are
    // `~ '^0x[0-9a-f]{40}$'` — a checksummed address fails them.
    expect(m.payerAddress).toBe(CUSTOMER);
    expect(m.attestationStatus).toBe("NOT_REQUIRED");
    expect(m.attestationType).toBeNull();
    expect(m.votingRoundId).toBeNull();
    expect(m.paidAt).toBe(new Date(1_786_452_368_000).toISOString());
  });

  it("refuses a payment in a token the deployment does not list", () => {
    nextLogIndex = 0;
    const { mutations, warnings } = reduceTransaction(
      [
        evt("invoice", "InvoicePaid", {
          invoiceId: 7n,
          payer: CUSTOMER,
          payToken: `0x${"99".repeat(20)}`,
          amountPaid: 1n,
          rail: 0n,
        }),
      ],
      ctx,
    );

    expect(mutations).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.severity).toBe("error");
    expect(warnings[0]!.message).toMatch(/Refusing to guess an asset_symbol/);
  });
});

describe("reduceTransaction — Rail B", () => {
  /**
   * The regression this whole design exists for. The rail fronts its own FXRP
   * through `payInvoice`, so the chain's own `InvoicePaid` says the rail paid,
   * in FXRP, with `rail = FLARE_ERC20`. All three are wrong about the world.
   */
  const railBatch = (): DecodedEvent[] => {
    nextLogIndex = 0;
    return [
      // Emitted first: the rail calls payInvoice before it emits its own event.
      evt("invoice", "InvoicePaid", {
        invoiceId: 12n,
        payer: RAIL_ADDRESS,
        payToken: FXRP,
        amountPaid: 40_000_000n,
        rail: 0n,
      }),
      evt("rail", "XrplPaymentAccepted", {
        invoiceId: 12n,
        transactionId: XRPL_TXID,
        sourceAddressHash: XRPL_SENDER_HASH,
        dropsReceived: 40_500_000n,
        fxrpFronted: 40_000_000n,
        votingRound: 1_034_882n,
      }),
    ];
  };

  it("records the XRPL sender, not the rail that fronted the FXRP", () => {
    const { mutations } = reduceTransaction(railBatch(), ctx);
    const payment = mutations.find((m) => m.kind === "record_payment");
    expect(payment).toBeDefined();
    if (payment?.kind !== "record_payment") throw new Error("unreachable");

    expect(payment.rail).toBe("XRPL_NATIVE");
    expect(payment.payerAddress).toBe(XRPL_SENDER_HASH);
    expect(payment.payerAddress).not.toBe(RAIL_ADDRESS);
  });

  it("records the drops the customer sent, not the FXRP the rail moved", () => {
    const { mutations } = reduceTransaction(railBatch(), ctx);
    const payment = mutations[0]!;
    if (payment.kind !== "record_payment") throw new Error("unreachable");

    expect(payment.amountUnits).toBe("40500000");
    expect(payment.tokenSymbol).toBe("XRP");
    // Kept, because it is real and auditable — just not the payment amount.
    expect(payment.frontedUnits).toBe("40000000");
    expect(payment.xrplTransactionId).toBe(XRPL_TXID);
  });

  it("carries the attestation provenance the FDC proof established", () => {
    const { mutations } = reduceTransaction(railBatch(), ctx);
    const payment = mutations[0]!;
    if (payment.kind !== "record_payment") throw new Error("unreachable");

    expect(payment.attestationStatus).toBe("VERIFIED");
    expect(payment.attestationType).toBe("Payment");
    expect(payment.votingRoundId).toBe(1_034_882);
  });

  it("does not let the join reach across transactions", () => {
    nextLogIndex = 0;
    const [paid, accepted] = railBatch() as [DecodedEvent, DecodedEvent];
    const other: DecodedEvent = { ...accepted, txHash: `0x${"33".repeat(32)}` };

    expect(() => reduceTransaction([paid, other], ctx)).toThrow(
      /more than one transaction/,
    );

    // Reduced as two separate transactions, the payment is Rail A — which is
    // what the chain said, and correct, because the rail was not involved in it.
    const { mutations, warnings } = reduceRange([paid, other], ctx);
    const payment = mutations.find((m) => m.kind === "record_payment");
    if (payment?.kind !== "record_payment") throw new Error("unreachable");
    expect(payment.rail).toBe("FLARE_ERC20");
    expect(warnings.some((w) => w.severity === "error")).toBe(true);
  });

  it("flags an XrplPaymentAccepted with no payment beside it", () => {
    nextLogIndex = 0;
    const { mutations, warnings } = reduceTransaction(
      [
        evt("rail", "XrplPaymentAccepted", {
          invoiceId: 12n,
          transactionId: XRPL_TXID,
          sourceAddressHash: XRPL_SENDER_HASH,
          dropsReceived: 1n,
          fxrpFronted: 1n,
          votingRound: 1n,
        }),
      ],
      ctx,
    );

    expect(mutations).toEqual([]);
    expect(warnings[0]!.severity).toBe("error");
    expect(warnings[0]!.message).toMatch(/NOT been recorded/);
  });

  it("binds an invoice to the XRPL rail", () => {
    nextLogIndex = 0;
    const { mutations } = reduceTransaction(
      [
        evt("rail", "InvoiceBound", {
          invoiceId: 12n,
          merchant: MERCHANT,
          receivingAddressHash: XRPL_SENDER_HASH,
          paymentReference: PAYMENT_REF,
          minimumDrops: 40_500_000n,
        }),
      ],
      ctx,
    );

    const m = mutations[0]!;
    expect(m.kind).toBe("bind_xrpl");
    if (m.kind !== "bind_xrpl") throw new Error("unreachable");
    expect(m.paymentRef).toBe(PAYMENT_REF);
    expect(m.minimumDrops).toBe("40500000");
  });
});

describe("reduceTransaction — lifecycle", () => {
  it("links an InvoiceCreated to the draft that carries its payment reference", () => {
    nextLogIndex = 0;
    const { mutations, warnings } = reduceTransaction(
      [
        evt("invoice", "InvoiceCreated", {
          invoiceId: 3n,
          merchant: MERCHANT,
          payToken: USDT0,
          amount: 100_000_000n,
          dueAt: 1_786_500_000n,
          paymentRef: PAYMENT_REF,
        }),
      ],
      ctx,
    );

    expect(warnings).toEqual([]);
    const m = mutations[0]!;
    expect(m.kind).toBe("link_invoice");
    if (m.kind !== "link_invoice") throw new Error("unreachable");
    // No usd_amount, title or description anywhere in the event — which is why
    // this is a link and not an insert.
    expect(m).not.toHaveProperty("usdAmount");
    expect(m.ref.onchainInvoiceId).toBe("3");
    expect(m.ref.paymentRef).toBe(PAYMENT_REF);
    expect(m.tokenAmount).toBe("100000000");
    expect(m.dueAt).toBe(new Date(1_786_500_000_000).toISOString());
  });

  it("links a V2 creation with its accepted payment set and settlement asset", () => {
    nextLogIndex = 0;
    const { mutations, warnings } = reduceTransaction(
      [
        evt("invoiceV2", "PaymentOptionSet", { invoiceId: 3n, token: FXRP }),
        evt("invoiceV2", "PaymentOptionSet", { invoiceId: 3n, token: USDT0 }),
        evt("invoiceV2", "InvoiceCreatedV2", {
          invoiceId: 3n,
          merchant: MERCHANT,
          settlementToken: USDT0,
          usdAmount: 125_500_000n,
          dueAt: 1_786_500_000n,
          paymentRef: PAYMENT_REF,
        }),
      ],
      ctx,
    );

    expect(warnings).toEqual([]);
    expect(mutations).toHaveLength(1);
    const mutation = mutations[0]!;
    expect(mutation.kind).toBe("link_invoice_v2");
    if (mutation.kind !== "link_invoice_v2") throw new Error("unreachable");
    expect(mutation.ref.contractVersion).toBe(2);
    expect(mutation.usdAmount).toBe("125500000");
    expect(mutation.acceptedPaymentAssets).toEqual(["FXRP", "USDT0"]);
    expect(mutation.settlementTokenSymbol).toBe("USDT0");
  });

  it("keeps V1 and V2 numeric invoice ids in separate namespaces", () => {
    nextLogIndex = 0;
    const v1 = reduceTransaction([
      evt("invoice", "InvoicePaid", {
        invoiceId: 1n, payer: CUSTOMER, payToken: FXRP, amountPaid: 1n, rail: 0n,
      }),
    ], ctx).mutations[0]!;
    const v2 = reduceTransaction([
      evt("invoiceV2", "InvoicePaid", {
        invoiceId: 1n, payer: CUSTOMER, payToken: USDT0, amountPaid: 2n, rail: 0n,
      }),
    ], ctx).mutations[0]!;
    expect(v1.ref.contractVersion).toBe(1);
    expect(v2.ref.contractVersion).toBe(2);
  });

  /**
   * The transposition regression. On-chain CANCELLED is ordinal 4 and EXPIRED is
   * 5; in `invoice_status` the declaration order is EXPIRED then CANCELLED. Any
   * ordinal-indexed mapping swaps them, and a cancelled invoice showing as
   * expired is a support ticket nobody can explain.
   */
  it("maps cancelled and expired by name, not by position", () => {
    nextLogIndex = 0;
    const cancelled = reduceTransaction(
      [evt("invoice", "InvoiceCancelled", { invoiceId: 4n, merchant: MERCHANT })],
      ctx,
    ).mutations[0]!;
    const expired = reduceTransaction(
      [evt("invoice", "InvoiceExpired", { invoiceId: 5n, caller: MERCHANT })],
      ctx,
    ).mutations[0]!;

    if (cancelled.kind !== "set_status" || expired.kind !== "set_status") {
      throw new Error("unreachable");
    }
    expect(cancelled.status).toBe("CANCELLED");
    expect(expired.status).toBe("EXPIRED");
  });

  it("records a settlement and its price snapshot, and not the escrow leg twice", () => {
    nextLogIndex = 0;
    const { mutations, warnings } = reduceTransaction(
      [
        evt("invoice", "EscrowReleased", {
          invoiceId: 9n,
          recipient: MERCHANT,
          token: FXRP,
          amount: 40_000_000n,
        }),
        evt("settlement", "SettlementPriceSnapshot", {
          invoiceId: 9n,
          token: FXRP,
          priceValue: 2_500_000n,
          priceDecimals: 6n,
          priceTimestamp: 1_786_452_360n,
        }),
        evt("settlement", "InvoiceSettled", {
          invoiceId: 9n,
          merchant: MERCHANT,
          recipient: MERCHANT,
          token: USDT0,
          amountOut: 100_000_000n,
        }),
      ],
      ctx,
    );

    expect(warnings).toEqual([]);
    expect(mutations.map((m) => m.kind)).toEqual([
      "attach_price_snapshot",
      "record_settlement",
    ]);

    const snapshot = mutations[0]!;
    if (snapshot.kind !== "attach_price_snapshot") throw new Error("unreachable");
    // Value and exponent together. XRP/USD is 6dp; 2500000 alone is not a price.
    expect(snapshot.priceUsd).toBe("2500000");
    expect(snapshot.priceDecimals).toBe(6);

    const settled = mutations[1]!;
    if (settled.kind !== "record_settlement") throw new Error("unreachable");
    expect(settled.tokenSymbol).toBe("USDT0");
    expect(settled.amountUnits).toBe("100000000");
  });

  /**
   * `priceDecimals` is `int8` on the contract — signed — while
   * `invoices.price_decimals` is `smallint check (between 0 and 30)`. Letting a
   * negative through means a Postgres constraint violation with nothing in it to
   * say which feed changed shape.
   */
  it("refuses a price exponent the schema cannot store", () => {
    nextLogIndex = 0;
    const { mutations, warnings } = reduceTransaction(
      [
        evt("settlement", "SettlementPriceSnapshot", {
          invoiceId: 9n,
          token: FXRP,
          priceValue: 2_500_000n,
          priceDecimals: -2n,
          priceTimestamp: 1_786_452_360n,
        }),
      ],
      ctx,
    );

    expect(mutations).toEqual([]);
    expect(warnings[0]!.severity).toBe("error");
    expect(warnings[0]!.message).toMatch(/price_decimals -2/);
  });

  it("keeps a uint256 exact instead of rounding it through a double", () => {
    nextLogIndex = 0;
    const huge = 2n ** 200n + 1n;
    const { mutations } = reduceTransaction(
      [
        evt("invoice", "InvoicePaid", {
          invoiceId: 1n,
          payer: CUSTOMER,
          payToken: FXRP,
          amountPaid: huge,
          rail: 0n,
        }),
      ],
      ctx,
    );
    const m = mutations[0]!;
    if (m.kind !== "record_payment") throw new Error("unreachable");
    expect(m.amountUnits).toBe(huge.toString());
    expect(BigInt(m.amountUnits)).toBe(huge);
  });

  it("reports an event it has no handler for rather than dropping it", () => {
    nextLogIndex = 0;
    const { mutations, warnings } = reduceTransaction(
      [evt("invoice", "SomethingNew", { invoiceId: 1n })],
      ctx,
    );
    expect(mutations).toEqual([]);
    expect(warnings[0]!.message).toMatch(/no handler for SomethingNew/);
  });
});

describe("groupByTransaction", () => {
  it("orders by block then log index, never log index alone", () => {
    const a: DecodedEvent = evt(
      "invoice",
      "InvoiceCancelled",
      { invoiceId: 1n, merchant: MERCHANT },
      { txHash: `0x${"aa".repeat(32)}`, blockNumber: 200, logIndex: 0 },
    );
    const b: DecodedEvent = evt(
      "invoice",
      "InvoiceCancelled",
      { invoiceId: 2n, merchant: MERCHANT },
      { txHash: `0x${"bb".repeat(32)}`, blockNumber: 100, logIndex: 9 },
    );

    const batches = groupByTransaction([a, b]);
    expect(batches.map((batch) => batch[0]!.blockNumber)).toEqual([100, 200]);
  });

  it("puts every log of a transaction in one batch, in log order", () => {
    const tx = `0x${"cc".repeat(32)}`;
    const later = evt("rail", "InvoiceBound", { invoiceId: 1n, merchant: MERCHANT, receivingAddressHash: XRPL_SENDER_HASH, paymentReference: PAYMENT_REF, minimumDrops: 1n }, { txHash: tx, logIndex: 5 });
    const earlier = evt("invoice", "InvoiceCancelled", { invoiceId: 1n, merchant: MERCHANT }, { txHash: tx, logIndex: 2 });

    const batches = groupByTransaction([later, earlier]);
    expect(batches).toHaveLength(1);
    expect(batches[0]!.map((e) => e.logIndex)).toEqual([2, 5]);
  });
});

describe("statusMap", () => {
  it("maps every on-chain ordinal to the database status of the same meaning", () => {
    expect(toDbStatus(CHAIN_STATUS.CREATED)).toBe("OPEN");
    expect(toDbStatus(CHAIN_STATUS.PENDING)).toBe("PENDING");
    expect(toDbStatus(CHAIN_STATUS.PAID)).toBe("PAID");
    expect(toDbStatus(CHAIN_STATUS.SETTLED)).toBe("SETTLED");
    expect(toDbStatus(CHAIN_STATUS.CANCELLED)).toBe("CANCELLED");
    expect(toDbStatus(CHAIN_STATUS.EXPIRED)).toBe("EXPIRED");
  });

  it("does not translate ordinal 4 to EXPIRED", () => {
    // If this ever fails, someone has indexed the Postgres enum positionally.
    expect(toDbStatus(4)).toBe("CANCELLED");
    expect(toDbStatus(5)).toBe("EXPIRED");
  });

  it("refuses an ordinal the contract enum does not have", () => {
    expect(() => chainStatusName(6)).toThrow(/Refusing to guess/);
    expect(() => chainStatusName(-1)).toThrow(/Unknown on-chain invoice status/);
  });

  it("accepts a bigint straight from a decoded log", () => {
    expect(toDbStatus(2n)).toBe("PAID");
  });

  it("allows forward lifecycle moves and refuses the rest", () => {
    expect(isForwardTransition("DRAFT", "OPEN")).toBe(true);
    expect(isForwardTransition("OPEN", "PAID")).toBe(true);
    expect(isForwardTransition("PAID", "SETTLED")).toBe(true);

    // Replay safety: the cursor advances only after writes land, so an already
    // settled invoice can be handed a fresh InvoicePaid on a re-scan.
    expect(isForwardTransition("SETTLED", "PAID")).toBe(false);
    expect(isForwardTransition("PAID", "OPEN")).toBe(false);
    expect(isForwardTransition("PAID", "PAID")).toBe(false);

    // Terminal states are not ranked against each other.
    expect(isForwardTransition("CANCELLED", "EXPIRED")).toBe(false);
    expect(isForwardTransition("SETTLED", "CANCELLED")).toBe(false);
  });
});
