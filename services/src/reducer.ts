import type { ContractKey } from "./abi.js";
import { HANDLED_EVENTS } from "./abi.js";
import type {
  AssetSymbol,
  AttestationStatus,
  InvoiceStatus,
  PaymentRail,
} from "./schema/rpc.js";

/**
 * Turning chain events into database writes.
 *
 * Everything in this file is pure. No network, no clock, no database — a log
 * batch and a token map go in, a list of intended writes comes out. That is the
 * point: the whole of the synchronisation logic can be tested without Supabase
 * credentials, which do not exist in this repository, and the untestable part is
 * reduced to "send these writes", which is mechanical.
 *
 * ## Why the unit is a transaction, not an event
 *
 * The obvious shape is one handler per event, and it produces a wrong database
 * for Rail B.
 *
 * `FluxaFdcPaymentRail` verifies an FDC proof of an XRPL payment and then fronts
 * its own FXRP through the ordinary `payInvoice`. So `FluxaInvoice` records
 * `payer = <the rail's address>` and `rail = FLARE_ERC20` — the latter is not
 * even a field the contract varies: all three assignment sites in
 * FluxaInvoice.sol write `Rail.FLARE_ERC20` literally, so `InvoicePaid.rail`
 * carries no information at all.
 *
 * The customer's XRPL account and the drops they really sent appear only in
 * `XrplPaymentAccepted`, which the rail emits *after* the inner `payInvoice`
 * call returns — a higher log index in the same transaction. An event-at-a-time
 * reducer therefore sees `InvoicePaid` first, has no way to know a rail is
 * involved, and records Fluxa paying itself in FXRP. Reducing a whole
 * transaction at once is what makes the join possible.
 *
 * ## Why nothing here invents an invoice
 *
 * The spec's diagram (§7.5) is `InvoiceCreated → application detects event →
 * Supabase → invoice available in UI`, which reads as: the chain creates the
 * row. It cannot. `InvoiceCreated(invoiceId, merchant, payToken, amount, dueAt,
 * paymentRef)` carries no title, no description and no USD figure, and
 * `invoices.usd_amount` is `not null check (usd_amount > 0)` — so a row built
 * from the event alone does not satisfy the schema, and the three fields it is
 * missing are precisely the ones §5.11 says the database exists to hold.
 *
 * Fluxa's flow is off-chain first: the merchant writes a DRAFT, publishes it,
 * and this reducer *links* the event to the waiting row by its payment
 * reference. An `InvoiceCreated` with no matching row is reported as unlinked
 * rather than fabricated, because the alternative is showing a merchant an
 * invoice with a USD amount nobody entered.
 */

/** One decoded log, with the block context needed to date it. */
export type DecodedEvent = {
  contract: ContractKey;
  name: string;
  /** Decoded arguments by name. bigint for numerics, lowercase hex for the rest. */
  args: Record<string, bigint | string>;
  address: string;
  txHash: string;
  logIndex: number;
  blockNumber: number;
  /** Unix seconds. The chain's clock, not the indexer's. */
  blockTimestamp: number;
};

/**
 * How a mutation names its invoice.
 *
 * Both identifiers are on-chain: the applier resolves them to a `invoices.id`
 * UUID. `paymentRef` is present only on the two events that carry it
 * (`InvoiceCreated`, `InvoiceBound`) and is the stronger of the two, because it
 * is the field a merchant's off-chain draft already holds.
 */
export type OnchainRef = {
  onchainInvoiceId: string;
  contractVersion: 1 | 2;
  paymentRef?: string;
};

export type Mutation =
  /** `InvoiceCreated`: attach an on-chain id to the draft that was waiting for it. */
  | {
      kind: "link_invoice";
      ref: OnchainRef;
      paymentRef: string;
      merchant: string;
      payToken: string;
      tokenSymbol: AssetSymbol;
      tokenAmount: string;
      dueAt: string;
      txHash: string;
      logIndex: number;
      blockNumber: number;
    }
  /** `InvoiceCreatedV2`: link a USD invoice and its selectable payment assets. */
  | {
      kind: "link_invoice_v2";
      ref: OnchainRef;
      paymentRef: string;
      merchant: string;
      settlementToken: string;
      settlementTokenSymbol: AssetSymbol;
      acceptedPaymentAssets: AssetSymbol[];
      usdAmount: string;
      dueAt: string;
      txHash: string;
      logIndex: number;
      blockNumber: number;
    }
  /** `InvoiceBound`: this invoice will be paid on the XRPL, so its rail changes. */
  | {
      kind: "bind_xrpl";
      ref: OnchainRef;
      paymentRef: string;
      receivingAddressHash: string;
      minimumDrops: string;
      txHash: string;
      logIndex: number;
    }
  /** `InvoicePaid`, joined with `XrplPaymentAccepted` when the rail was involved. */
  | {
      kind: "record_payment";
      ref: OnchainRef;
      rail: PaymentRail;
      txHash: string;
      logIndex: number;
      blockNumber: number;
      amountUnits: string;
      tokenSymbol: AssetSymbol;
      payerAddress: string;
      paidAt: string;
      attestationStatus: AttestationStatus;
      attestationType: string | null;
      votingRoundId: number | null;
      /** Rail B only: the FXRP the rail fronted, which is not what the customer paid. */
      frontedUnits?: string;
      /** Rail B only: the XRPL transaction the proof was about. */
      xrplTransactionId?: string;
    }
  /** `InvoiceSettled`: what the merchant actually received, and where. */
  | {
      kind: "record_settlement";
      ref: OnchainRef;
      txHash: string;
      logIndex: number;
      tokenSymbol: AssetSymbol;
      amountUnits: string;
      toAddress: string;
      settledAt: string;
    }
  /** `SettlementPriceSnapshot`: the FTSO read the payout was priced at. */
  | {
      kind: "attach_price_snapshot";
      ref: OnchainRef;
      priceUsd: string;
      priceDecimals: number;
      priceTimestamp: string;
      txHash: string;
      logIndex: number;
    }
  /** `InvoiceCancelled` / `InvoiceExpired`: a terminal state, with no money attached. */
  | {
      kind: "set_status";
      ref: OnchainRef;
      status: InvoiceStatus;
      txHash: string;
      logIndex: number;
    };

/** Something the operator needs to know about, that is not a crash. */
export type Warning = {
  severity: "warn" | "error";
  event: string;
  txHash: string;
  logIndex: number;
  message: string;
};

export type ReduceResult = {
  mutations: Mutation[];
  warnings: Warning[];
};

export type ReduceContext = {
  /**
   * Token address to `asset_symbol`, from the deployment record.
   *
   * Returns null for an address the deployment does not know. The reducer then
   * refuses to write the payment rather than guessing a symbol — an amount
   * filed under the wrong asset is a wrong number in front of a merchant, and
   * `asset_symbol` has only three members so a guess is likely to be wrong.
   */
  symbolForToken(address: string): AssetSymbol | null;
};

const iso = (unixSeconds: number | bigint): string =>
  new Date(Number(unixSeconds) * 1000).toISOString();

const lower = (value: unknown): string => String(value).toLowerCase();

const versionFor = (contract: ContractKey): 1 | 2 =>
  contract === "invoiceV2" || contract === "settlementV2" ? 2 : 1;

function asBigInt(value: bigint | string | undefined, field: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "string" && /^(0x[0-9a-fA-F]+|\d+)$/.test(value)) return BigInt(value);
  throw new Error(`expected a numeric value for ${field}, got ${String(value)}`);
}

/**
 * Reduce every log of a single transaction to the writes it implies.
 *
 * `events` must be all logs of one transaction, in ascending log-index order,
 * and must not span transactions — the Rail B join below is only sound within
 * one. `groupByTransaction` enforces that.
 */
export function reduceTransaction(
  events: readonly DecodedEvent[],
  ctx: ReduceContext,
): ReduceResult {
  const mutations: Mutation[] = [];
  const warnings: Warning[] = [];

  if (events.length === 0) return { mutations, warnings };

  const first = events[0]!;
  const txHash = first.txHash;

  for (const event of events) {
    if (event.txHash !== txHash) {
      throw new Error(
        `reduceTransaction was given logs from more than one transaction ` +
          `(${txHash} and ${event.txHash}). The Rail B payer join is only valid ` +
          `within a single transaction.`,
      );
    }
  }

  const warn = (
    severity: Warning["severity"],
    event: DecodedEvent,
    message: string,
  ): void => {
    warnings.push({
      severity,
      event: event.name,
      txHash: event.txHash,
      logIndex: event.logIndex,
      message,
    });
  };

  /**
   * `XrplPaymentAccepted` by on-chain invoice id, for the payer join.
   *
   * Built before the main pass because the rail emits it *after* the inner
   * `payInvoice`, so a single forward pass would reach `InvoicePaid` first.
   */
  const xrplByInvoice = new Map<string, DecodedEvent>();
  for (const event of events) {
    if (event.contract === "rail" && event.name === "XrplPaymentAccepted") {
      xrplByInvoice.set(String(event.args.invoiceId), event);
    }
  }

  for (const event of events) {
    if (!HANDLED_EVENTS.has(event.name)) {
      warn(
        "warn",
        event,
        `no handler for ${event.name}; the contract set may have gained an event ` +
          `this indexer does not know about`,
      );
      continue;
    }

    try {
      switch (event.name) {
        case "InvoiceCreated": {
          const onchainInvoiceId = String(event.args.invoiceId);
          const payToken = lower(event.args.payToken);
          const symbol = ctx.symbolForToken(payToken);
          const paymentRef = lower(event.args.paymentRef);

          if (symbol === null) {
            warn(
              "error",
              event,
              `invoice ${onchainInvoiceId} is denominated in ${payToken}, which is not ` +
                `in the deployment's token set. Refusing to guess an asset_symbol.`,
            );
            break;
          }

          mutations.push({
            kind: "link_invoice",
            ref: { onchainInvoiceId, contractVersion: 1, paymentRef },
            paymentRef,
            merchant: lower(event.args.merchant),
            payToken,
            tokenSymbol: symbol,
            tokenAmount: asBigInt(event.args.amount, "amount").toString(),
            dueAt: iso(asBigInt(event.args.dueAt, "dueAt")),
            txHash: event.txHash,
            logIndex: event.logIndex,
            blockNumber: event.blockNumber,
          });
          break;
        }

        case "InvoiceCreatedV2": {
          const onchainInvoiceId = String(event.args.invoiceId);
          const settlementToken = lower(event.args.settlementToken);
          const settlementTokenSymbol = ctx.symbolForToken(settlementToken);
          const paymentRef = lower(event.args.paymentRef);
          if (settlementTokenSymbol === null || settlementTokenSymbol === "XRP") {
            warn(
              "error",
              event,
              `V2 invoice ${onchainInvoiceId} settles in ${settlementToken}, which is not a ` +
                `supported Coston2 ERC-20 asset. Refusing to link it.`,
            );
            break;
          }

          const acceptedPaymentAssets: AssetSymbol[] = [];
          let optionsValid = true;
          for (const option of events) {
            if (
              option.contract !== "invoiceV2" ||
              option.name !== "PaymentOptionSet" ||
              String(option.args.invoiceId) !== onchainInvoiceId
            ) continue;
            const symbol = ctx.symbolForToken(lower(option.args.token));
            if (symbol === null || symbol === "XRP") {
              optionsValid = false;
              warn(
                "error",
                option,
                `V2 invoice ${onchainInvoiceId} accepts unknown token ${lower(option.args.token)}.`,
              );
            } else if (!acceptedPaymentAssets.includes(symbol)) {
              acceptedPaymentAssets.push(symbol);
            }
          }
          if (!optionsValid || acceptedPaymentAssets.length === 0) {
            warn("error", event, `V2 invoice ${onchainInvoiceId} has no indexable payment option.`);
            break;
          }

          mutations.push({
            kind: "link_invoice_v2",
            ref: { onchainInvoiceId, contractVersion: 2, paymentRef },
            paymentRef,
            merchant: lower(event.args.merchant),
            settlementToken,
            settlementTokenSymbol,
            acceptedPaymentAssets,
            usdAmount: asBigInt(event.args.usdAmount, "usdAmount").toString(),
            dueAt: iso(asBigInt(event.args.dueAt, "dueAt")),
            txHash: event.txHash,
            logIndex: event.logIndex,
            blockNumber: event.blockNumber,
          });
          break;
        }

        case "InvoiceBound": {
          const onchainInvoiceId = String(event.args.invoiceId);
          const paymentRef = lower(event.args.paymentReference);
          mutations.push({
            kind: "bind_xrpl",
            ref: { onchainInvoiceId, contractVersion: 1, paymentRef },
            paymentRef,
            receivingAddressHash: lower(event.args.receivingAddressHash),
            minimumDrops: asBigInt(event.args.minimumDrops, "minimumDrops").toString(),
            txHash: event.txHash,
            logIndex: event.logIndex,
          });
          break;
        }

        case "InvoicePaid": {
          const onchainInvoiceId = String(event.args.invoiceId);
          const contractVersion = versionFor(event.contract);
          const xrpl = contractVersion === 1 ? xrplByInvoice.get(onchainInvoiceId) : undefined;

          if (xrpl !== undefined) {
            // Rail B. What the *customer* paid is drops of native XRP on the
            // XRPL; the FXRP in this transaction is the rail's own float and
            // belongs nowhere near a payment record. `InvoicePaid.rail` says
            // FLARE_ERC20 here and is simply wrong about the world — see the
            // note at the top of this file.
            const fronted = asBigInt(xrpl.args.fxrpFronted, "fxrpFronted");
            const drops = asBigInt(xrpl.args.dropsReceived, "dropsReceived");
            const payerFromInvoice = lower(event.args.payer);

            mutations.push({
              kind: "record_payment",
              ref: { onchainInvoiceId, contractVersion: 1 },
              rail: "XRPL_NATIVE",
              txHash: event.txHash,
              logIndex: event.logIndex,
              blockNumber: event.blockNumber,
              amountUnits: drops.toString(),
              // XRPL-native, not the FXRP the rail moved. 1 drop and 1 FXRP base
              // unit are both 1e-6, which is what lets the rail compare them —
              // but they are not the same asset and must not be filed as one.
              tokenSymbol: "XRP",
              // keccak of the sender's r-address, which is all FDC reports. Not
              // 0x-shaped and not reversible; payment_events.payer_address is
              // deliberately unconstrained for exactly this.
              payerAddress: lower(xrpl.args.sourceAddressHash),
              paidAt: iso(event.blockTimestamp),
              attestationStatus: "VERIFIED",
              attestationType: "Payment",
              votingRoundId: Number(asBigInt(xrpl.args.votingRound, "votingRound")),
              frontedUnits: fronted.toString(),
              xrplTransactionId: lower(xrpl.args.transactionId),
            });

            if (payerFromInvoice === lower(xrpl.address)) {
              // Expected, and worth saying once: this is the fronting design,
              // not a bug. Noted at `warn` so an operator reading the log can
              // see why the recorded payer differs from the chain's `payer`.
              warn(
                "warn",
                event,
                `invoice ${onchainInvoiceId} records payer ${payerFromInvoice} (the FDC ` +
                  `rail, which fronted ${fronted} FXRP); the payment is recorded against ` +
                  `the XRPL sender from XrplPaymentAccepted instead`,
              );
            }
            break;
          }

          // Rail A: the contract observed the transfer itself, so the invoice's
          // own record is the whole truth.
          const payToken = lower(event.args.payToken);
          const symbol = ctx.symbolForToken(payToken);
          if (symbol === null) {
            warn(
              "error",
              event,
              `payment for invoice ${onchainInvoiceId} is in ${payToken}, which is not in ` +
                `the deployment's token set. Refusing to guess an asset_symbol.`,
            );
            break;
          }

          mutations.push({
            kind: "record_payment",
            ref: { onchainInvoiceId, contractVersion },
            rail: "FLARE_ERC20",
            txHash: event.txHash,
            logIndex: event.logIndex,
            blockNumber: event.blockNumber,
            amountUnits: asBigInt(event.args.amountPaid, "amountPaid").toString(),
            tokenSymbol: symbol,
            payerAddress: lower(event.args.payer),
            paidAt: iso(event.blockTimestamp),
            // Rail A needs no attestation: the transfer is already in the state
            // of the contract being asked about it. See Phase 0 §2.3.
            attestationStatus: "NOT_REQUIRED",
            attestationType: null,
            votingRoundId: null,
          });
          break;
        }

        case "InvoiceSettled": {
          const onchainInvoiceId = String(event.args.invoiceId);
          const token = lower(event.args.token);
          const symbol = ctx.symbolForToken(token);
          if (symbol === null) {
            warn(
              "error",
              event,
              `invoice ${onchainInvoiceId} settled in ${token}, which is not in the ` +
                `deployment's token set. Refusing to guess an asset_symbol.`,
            );
            break;
          }
          mutations.push({
            kind: "record_settlement",
            ref: { onchainInvoiceId, contractVersion: versionFor(event.contract) },
            txHash: event.txHash,
            logIndex: event.logIndex,
            tokenSymbol: symbol,
            amountUnits: asBigInt(event.args.amountOut, "amountOut").toString(),
            toAddress: lower(event.args.recipient),
            settledAt: iso(event.blockTimestamp),
          });
          break;
        }

        case "SettlementPriceSnapshot": {
          const onchainInvoiceId = String(event.args.invoiceId);
          const decimals = Number(asBigInt(event.args.priceDecimals, "priceDecimals"));

          // `priceDecimals` is int8 on the contract — signed. FTSO exponents are
          // positive in practice, but `invoices.price_decimals` is
          // `smallint check (between 0 and 30)`, so a negative value would be
          // rejected by Postgres as a constraint violation with nothing in it to
          // explain why. Caught here instead, where the cause can be named.
          if (decimals < 0 || decimals > 30) {
            warn(
              "error",
              event,
              `invoice ${onchainInvoiceId} reported price_decimals ${decimals}, outside the ` +
                `0-30 the schema allows. FTSO exponents are per-feed (6 for XRP/USD, 8 for ` +
                `FLR/USD); a value outside this range means the feed changed shape.`,
            );
            break;
          }

          mutations.push({
            kind: "attach_price_snapshot",
            ref: { onchainInvoiceId, contractVersion: versionFor(event.contract) },
            priceUsd: asBigInt(event.args.priceValue, "priceValue").toString(),
            priceDecimals: decimals,
            priceTimestamp: iso(asBigInt(event.args.priceTimestamp, "priceTimestamp")),
            txHash: event.txHash,
            logIndex: event.logIndex,
          });
          break;
        }

        case "InvoiceCancelled":
        case "InvoiceExpired": {
          mutations.push({
            kind: "set_status",
            ref: {
              onchainInvoiceId: String(event.args.invoiceId),
              contractVersion: versionFor(event.contract),
            },
            // By name, never by ordinal: the two enums transpose CANCELLED and
            // EXPIRED. See statusMap.ts.
            status: event.name === "InvoiceCancelled" ? "CANCELLED" : "EXPIRED",
            txHash: event.txHash,
            logIndex: event.logIndex,
          });
          break;
        }

        case "EscrowReleased":
          // The escrow leg of the settlement transaction. `InvoiceSettled`
          // already records the payout; writing both would double-count it.
          break;

        case "PaymentOptionSet":
          // Folded into InvoiceCreatedV2 above so the accepted set is validated
          // as one fact rather than applied as several partial database writes.
          break;

        case "ConversionRecorded":
          // InvoiceSettled carries the merchant payout and is the authoritative
          // settlement projection. This event documents reserve inventory only.
          break;

        case "XrplPaymentAccepted":
          // Consumed by the InvoicePaid case above, where it supplies the real
          // payer. On its own it is not a payment: the rail can only emit it
          // after `payInvoice` succeeded.
          if (!events.some((e) => e.name === "InvoicePaid")) {
            warn(
              "error",
              event,
              `XrplPaymentAccepted with no InvoicePaid in the same transaction. The rail ` +
                `emits it only after payInvoice returns, so this should be impossible; the ` +
                `payment has NOT been recorded.`,
            );
          }
          break;

        default:
          warn("warn", event, `unhandled event ${event.name}`);
      }
    } catch (error) {
      warn("error", event, error instanceof Error ? error.message : String(error));
    }
  }

  // Applied in log order so that a link precedes the payment that depends on it
  // when both land in one transaction.
  mutations.sort((a, b) => a.logIndex - b.logIndex);

  return { mutations, warnings };
}

/**
 * Split a block range's logs into per-transaction batches, in chain order.
 *
 * Ordering is (blockNumber, logIndex) — the order the chain produced them, which
 * is also the order the database must apply them in. Sorting by log index alone
 * would interleave blocks.
 */
export function groupByTransaction(
  events: readonly DecodedEvent[],
): DecodedEvent[][] {
  const byTx = new Map<string, DecodedEvent[]>();
  for (const event of events) {
    const bucket = byTx.get(event.txHash);
    if (bucket === undefined) byTx.set(event.txHash, [event]);
    else bucket.push(event);
  }

  const batches = [...byTx.values()];
  for (const batch of batches) batch.sort((a, b) => a.logIndex - b.logIndex);

  batches.sort((a, b) => {
    const left = a[0]!;
    const right = b[0]!;
    return left.blockNumber === right.blockNumber
      ? left.logIndex - right.logIndex
      : left.blockNumber - right.blockNumber;
  });

  return batches;
}

/** Reduce a whole block range. Convenience over groupByTransaction + reduceTransaction. */
export function reduceRange(
  events: readonly DecodedEvent[],
  ctx: ReduceContext,
): ReduceResult {
  const mutations: Mutation[] = [];
  const warnings: Warning[] = [];
  for (const batch of groupByTransaction(events)) {
    const result = reduceTransaction(batch, ctx);
    mutations.push(...result.mutations);
    warnings.push(...result.warnings);
  }
  return { mutations, warnings };
}
