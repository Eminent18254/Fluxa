import type { SupabaseClient } from "@supabase/supabase-js";

import type { Mutation, OnchainRef, Warning } from "./reducer.js";
import { isForwardTransition } from "./statusMap.js";
import type { AssetSymbol, InvoiceStatus } from "./schema/rpc.js";

/**
 * Sending the reducer's intended writes to Supabase.
 *
 * Split from the reducer so the decisions are testable without credentials and
 * this file has no decisions left in it — it resolves an on-chain id to a row
 * and calls the writer for each mutation kind. Where it does branch, the branch
 * is about the database refusing something, not about what the chain meant.
 *
 * Two rules hold throughout:
 *
 *   1. **Every write names an id.** The service role bypasses RLS, so an update
 *      with a missing filter is a whole-table update.
 *   2. **Every write is idempotent.** The cursor advances only after a batch
 *      lands, so a crash re-scans the range it was working on. Re-applying must
 *      be a no-op, not a second payment.
 */

export type ApplyOutcome = {
  applied: number;
  /** Mutations whose invoice could not be resolved to a row. Counted, not fatal. */
  skipped: number;
  warnings: Warning[];
};

/** Just enough of a row to decide whether a write is forward progress. */
type InvoiceRow = {
  id: string;
  status: InvoiceStatus;
  token_amount: string | null;
  onchain_invoice_id: string | null;
  contract_version: 1 | 2;
  usd_amount: string | number;
  accepted_payment_assets: AssetSymbol[];
  settlement_token_symbol: AssetSymbol;
};

/**
 * On-chain identity to `invoices.id`.
 *
 * Two lookup paths, because an invoice acquires its on-chain id at a different
 * moment from its payment reference. Before the link, only the reference matches;
 * after it, either does. The reference is tried first because it is the field the
 * merchant's draft was created with, and therefore the one that exists earliest.
 *
 * Cached per run: a busy block range mentions the same invoice several times, and
 * a resolution that already happened cannot change mid-run.
 */
export class InvoiceResolver {
  private readonly byOnchainId = new Map<string, InvoiceRow | null>();
  private readonly byReference = new Map<string, InvoiceRow | null>();

  constructor(private readonly db: SupabaseClient) {}

  private static readonly COLUMNS =
    "id, status, token_amount, onchain_invoice_id, contract_version, usd_amount, accepted_payment_assets, settlement_token_symbol";

  async resolve(ref: OnchainRef): Promise<InvoiceRow | null> {
    if (ref.paymentRef !== undefined) {
      const row = await this.lookup(
        "invoice_reference", ref.paymentRef, ref.contractVersion, this.byReference,
      );
      if (row !== null) return row;
    }
    return this.lookup(
      "onchain_invoice_id", ref.onchainInvoiceId, ref.contractVersion, this.byOnchainId,
    );
  }

  private async lookup(
    column: "invoice_reference" | "onchain_invoice_id",
    value: string,
    contractVersion: 1 | 2,
    cache: Map<string, InvoiceRow | null>,
  ): Promise<InvoiceRow | null> {
    const key = `${contractVersion}:${value}`;
    const cachedRow = cache.get(key);
    if (cachedRow !== undefined) return cachedRow;

    const { data, error } = await this.db
      .from("invoices")
      .select(InvoiceResolver.COLUMNS)
      .eq(column, value)
      .eq("contract_version", contractVersion)
      .maybeSingle<InvoiceRow>();

    if (error !== null) {
      throw new Error(`looking up invoice by ${column}=${value}: ${error.message}`);
    }

    cache.set(key, data ?? null);
    return data ?? null;
  }

  /** Drop a row from the cache after writing to it, so a later read sees the new status. */
  invalidate(row: InvoiceRow): void {
    if (row.onchain_invoice_id !== null) {
      this.byOnchainId.delete(`${row.contract_version}:${row.onchain_invoice_id}`);
    }
    for (const [key, cachedRow] of this.byReference) {
      if (cachedRow?.id === row.id) this.byReference.delete(key);
    }
  }
}

export async function applyMutations(
  db: SupabaseClient,
  mutations: readonly Mutation[],
  resolver: InvoiceResolver = new InvoiceResolver(db),
): Promise<ApplyOutcome> {
  const warnings: Warning[] = [];
  let applied = 0;
  let skipped = 0;

  const note = (
    severity: Warning["severity"],
    mutation: Mutation,
    message: string,
  ): void => {
    warnings.push({
      severity,
      event: mutation.kind,
      txHash: mutation.txHash,
      logIndex: mutation.logIndex,
      message,
    });
  };

  for (const mutation of mutations) {
    const row = await resolver.resolve(mutation.ref);

    if (row === null) {
      skipped++;
      note(
        // A payment against an invoice with no row is worth an operator's
        // attention: money moved and Fluxa has nowhere to record it. An
        // unmatched InvoiceCreated is expected traffic — someone can create an
        // invoice on-chain without going through this application at all.
        mutation.kind === "record_payment" || mutation.kind === "record_settlement"
          ? "error"
          : "warn",
        mutation,
        `no invoice row for on-chain id ${mutation.ref.onchainInvoiceId}` +
          (mutation.ref.paymentRef !== undefined
            ? ` or reference ${mutation.ref.paymentRef}`
            : "") +
          `; ${mutation.kind} not applied`,
      );
      continue;
    }

    switch (mutation.kind) {
      case "link_invoice": {
        // The event carries the amount the contract will actually demand. If the
        // draft quotes something else, the pay page is showing a number the
        // contract will reject — so this is checked and reported, and the stored
        // quote is left alone. Overwriting it here would need a price snapshot
        // the event does not carry, and 0001 refuses a token_amount without one.
        if (row.token_amount !== null && BigInt(row.token_amount) !== BigInt(mutation.tokenAmount)) {
          note(
            "error",
            mutation,
            `invoice ${row.id} quotes token_amount ${row.token_amount} but the chain ` +
              `demands ${mutation.tokenAmount}. The pay page is quoting a figure the ` +
              `contract will reject.`,
          );
        }

        const patch: Record<string, unknown> = {
          onchain_invoice_id: mutation.ref.onchainInvoiceId,
          due_at: mutation.dueAt,
        };
        // DRAFT means "not yet published", and it plainly is now. Anything
        // further along stays where it is: a re-scan must not walk a paid
        // invoice back to OPEN.
        if (isForwardTransition(row.status, "OPEN")) patch.status = "OPEN";

        await update(db, row.id, patch);
        resolver.invalidate(row);
        applied++;
        break;
      }

      case "link_invoice_v2": {
        const rowUsd = usdMicros(row.usd_amount);
        if (rowUsd !== BigInt(mutation.usdAmount)) {
          note(
            "error",
            mutation,
            `invoice ${row.id} is ${rowUsd} USD micros but V2 demands ${mutation.usdAmount}.`,
          );
        }
        if (row.settlement_token_symbol !== mutation.settlementTokenSymbol) {
          note(
            "error",
            mutation,
            `invoice ${row.id} settles to ${row.settlement_token_symbol}, but the V2 event ` +
              `names ${mutation.settlementTokenSymbol}.`,
          );
        }
        const storedAssets = [...row.accepted_payment_assets].sort().join(",");
        const chainAssets = [...mutation.acceptedPaymentAssets].sort().join(",");
        if (storedAssets !== chainAssets) {
          note(
            "error",
            mutation,
            `invoice ${row.id} accepts [${storedAssets}], but the V2 event set is [${chainAssets}].`,
          );
        }

        const patch: Record<string, unknown> = {
          onchain_invoice_id: mutation.ref.onchainInvoiceId,
          due_at: mutation.dueAt,
        };
        if (isForwardTransition(row.status, "OPEN")) patch.status = "OPEN";
        await update(db, row.id, patch);
        resolver.invalidate(row);
        applied++;
        break;
      }

      case "bind_xrpl": {
        await update(db, row.id, { rail: "XRPL_NATIVE" });
        applied++;
        break;
      }

      case "record_payment": {
        // The atomic writer from 0003: it inserts the event and advances the
        // invoice in one statement, so there is no window where a payment exists
        // and the invoice does not know. `on conflict (tx_hash, log_index)`
        // makes a replay a no-op.
        const { error } = await db.rpc("record_payment_event", {
          p_invoice_id: row.id,
          p_rail: mutation.rail,
          p_tx_hash: mutation.txHash,
          p_log_index: mutation.logIndex,
          p_block_number: mutation.blockNumber,
          p_amount_units: mutation.amountUnits,
          p_token_symbol: mutation.tokenSymbol,
          p_payer_address: mutation.payerAddress,
          p_paid_at: mutation.paidAt,
          p_attestation_status: mutation.attestationStatus,
          p_attestation_type: mutation.attestationType,
          p_voting_round_id: mutation.votingRoundId,
        });
        if (error !== null) {
          throw new Error(`record_payment_event for invoice ${row.id}: ${error.message}`);
        }
        resolver.invalidate(row);
        applied++;
        break;
      }

      case "record_settlement": {
        const { error } = await db.rpc("record_settlement", {
          p_invoice_id: row.id,
          p_tx_hash: mutation.txHash,
          p_token_symbol: mutation.tokenSymbol,
          p_amount_units: mutation.amountUnits,
          p_to_address: mutation.toAddress,
          p_settled_at: mutation.settledAt,
        });
        if (error !== null) {
          throw new Error(`record_settlement for invoice ${row.id}: ${error.message}`);
        }
        resolver.invalidate(row);
        applied++;
        break;
      }

      case "attach_price_snapshot": {
        // Its own columns, not the invoice quote. `price_usd` is what the
        // merchant issued the invoice at; this is what the payout was computed
        // at, possibly days later at a different price. Writing one over the
        // other would erase the only comparison anyone wants to make.
        await update(db, row.id, {
          settlement_price_usd: mutation.priceUsd,
          settlement_price_decimals: mutation.priceDecimals,
          settlement_price_timestamp: mutation.priceTimestamp,
        });
        applied++;
        break;
      }

      case "set_status": {
        if (!isForwardTransition(row.status, mutation.status)) {
          note(
            row.status === mutation.status ? "warn" : "error",
            mutation,
            `invoice ${row.id} is ${row.status}; refusing to move it to ${mutation.status}`,
          );
          skipped++;
          break;
        }
        await update(db, row.id, { status: mutation.status });
        resolver.invalidate(row);
        applied++;
        break;
      }
    }
  }

  return { applied, skipped, warnings };
}

function usdMicros(value: string | number): bigint {
  const text = String(value);
  if (!/^\d+(\.\d+)?$/.test(text)) throw new Error(`invalid stored USD amount ${text}`);
  const [whole = "0", fraction = ""] = text.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0").slice(0, 6));
}

async function update(
  db: SupabaseClient,
  invoiceId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const { error } = await db.from("invoices").update(patch).eq("id", invoiceId);
  if (error !== null) {
    throw new Error(
      `updating invoice ${invoiceId} (${Object.keys(patch).join(", ")}): ${error.message}`,
    );
  }
}
