import type { SupabaseClient } from "@supabase/supabase-js";
import type { ethers } from "ethers";

import { applyMutations, InvoiceResolver, type ApplyOutcome } from "./apply.js";
import type { IndexerConfig } from "./config.js";
import { fetchLogs, makeProvider } from "./logs.js";
import { reduceRange, type ReduceContext, type Warning } from "./reducer.js";
import type { SyncStateRow } from "./schema/rpc.js";

/**
 * The loop that keeps Supabase level with the chain.
 *
 * ## The cursor
 *
 * `sync_state.last_processed_block` is the highest block whose writes have
 * *landed*. It advances after the batch, never before. The consequence is
 * deliberate: a crash mid-batch means the next run re-scans that range rather
 * than stepping over it. Re-scanning is safe because every write is idempotent —
 * `record_payment_event` conflicts on `(tx_hash, log_index)`, the status updates
 * are guarded by `isForwardTransition` — and skipping is not, because a skipped
 * range is a payment that silently never appears.
 *
 * The cursor is also fingerprinted. A block number means nothing on its own: a
 * redeploy to a fresh chain resets block numbers while the stored cursor still
 * points at a height the new contracts have not reached, so the indexer would
 * resume from the future and skip everything before it. Comparing fingerprints
 * turns that into a refusal instead of silence.
 */

export type SyncOptions = {
  /** Run one catch-up pass and stop, instead of following the head. */
  once?: boolean;
  /** Start again from the deployment block. Rewrites the cursor; the writes it replays are idempotent. */
  reset?: boolean;
  log?: (message: string) => void;
};

export type SyncSummary = {
  fromBlock: number;
  toBlock: number;
  eventsSeen: number;
  mutations: number;
  applied: number;
  skipped: number;
  warnings: Warning[];
};

const noop = (): void => {};

/** The reducer needs a token map; the config already built one from the deployment. */
export function reduceContextFor(config: IndexerConfig): ReduceContext {
  return {
    symbolForToken: (address) => config.tokens.get(address.toLowerCase()) ?? null,
  };
}

/**
 * Read the cursor, creating it on first run and refusing a foreign one.
 *
 * The initial value is `deployedAtBlock - 1`, so the first range includes the
 * deployment block itself. The invoice contract cannot have emitted anything
 * before it existed, which is what makes starting there complete rather than
 * merely convenient — scanning from block 0 would be the same set of events and
 * several million pointless requests.
 */
export async function loadCursor(
  db: SupabaseClient,
  config: IndexerConfig,
  options: { reset?: boolean } = {},
): Promise<number> {
  const { data, error } = await db
    .from("sync_state")
    .select("*")
    .eq("id", config.syncStateId)
    .maybeSingle<SyncStateRow>();

  if (error !== null) {
    throw new Error(`reading sync_state ${config.syncStateId}: ${error.message}`);
  }

  const start = config.deployedAtBlock - 1;

  if (data === null) {
    const { error: insertError } = await db.from("sync_state").insert({
      id: config.syncStateId,
      chain_id: config.chainId,
      last_processed_block: start,
      deployed_at_block: config.deployedAtBlock,
      contract_fingerprint: config.fingerprint,
      contracts: {
        FluxaInvoice: config.addresses.invoice,
        FluxaSettlement: config.addresses.settlement,
        ...(config.addresses.rail !== null
          ? { FluxaFdcPaymentRail: config.addresses.rail }
          : {}),
        ...(config.addresses.invoiceV2 !== null
          ? { FluxaInvoiceV2: config.addresses.invoiceV2 }
          : {}),
        ...(config.addresses.settlementV2 !== null
          ? { FluxaSettlementV2: config.addresses.settlementV2 }
          : {}),
      },
    });
    if (insertError !== null) {
      throw new Error(`creating sync_state ${config.syncStateId}: ${insertError.message}`);
    }
    return start;
  }

  if (data.contract_fingerprint !== config.fingerprint) {
    if (options.reset !== true) {
      throw new Error(
        `sync_state ${config.syncStateId} was written for a different deployment ` +
          `(stored fingerprint ${data.contract_fingerprint}, current ${config.fingerprint}). ` +
          `Its cursor at block ${data.last_processed_block} is meaningless for these ` +
          `addresses and resuming from it would skip every event before that height. ` +
          `Re-run with --reset to start from block ${config.deployedAtBlock}.`,
      );
    }
  }

  if (data.chain_id !== config.chainId) {
    throw new Error(
      `sync_state ${config.syncStateId} belongs to chain ${data.chain_id}, but this ` +
        `deployment is on chain ${config.chainId}. Refusing to mix two chains under ` +
        `one cursor.`,
    );
  }

  if (options.reset === true) {
    await db
      .from("sync_state")
      .update({
        last_processed_block: start,
        deployed_at_block: config.deployedAtBlock,
        contract_fingerprint: config.fingerprint,
        last_error: null,
      })
      .eq("id", config.syncStateId);
    return start;
  }

  return data.last_processed_block;
}

/** Advance the cursor, after the batch's writes have landed and not before. */
async function saveCursor(
  db: SupabaseClient,
  config: IndexerConfig,
  toBlock: number,
  outcome: ApplyOutcome,
): Promise<void> {
  const { error } = await db.rpc("advance_sync_cursor", {
    p_id: config.syncStateId,
    p_block: toBlock,
    p_events_applied: outcome.applied,
    p_error: null,
  });

  if (error !== null) {
    throw new Error(`advancing sync_state to block ${toBlock}: ${error.message}`);
  }
}

async function recordError(
  db: SupabaseClient,
  config: IndexerConfig,
  message: string,
): Promise<void> {
  // Best effort. If the database is what broke, saying so in the database is not
  // going to work, and the thrown error is still on its way to the operator.
  await db
    .from("sync_state")
    .update({ last_error: message.slice(0, 2_000), last_run_at: new Date().toISOString() })
    .eq("id", config.syncStateId);
}

/** One window: fetch, reduce, apply, advance. */
export async function syncRange(
  db: SupabaseClient,
  provider: ethers.Provider,
  config: IndexerConfig,
  fromBlock: number,
  toBlock: number,
  resolver: InvoiceResolver,
): Promise<SyncSummary> {
  const { events, unknown } = await fetchLogs(provider, config, fromBlock, toBlock);
  const { mutations, warnings } = reduceRange(events, reduceContextFor(config));
  const outcome = await applyMutations(db, mutations, resolver);

  for (const log of unknown) {
    warnings.push({
      severity: "warn",
      event: "unknown",
      txHash: log.txHash,
      logIndex: log.logIndex,
      message: `log with topic0 ${log.topic0} from ${log.address} did not decode`,
    });
  }

  await saveCursor(db, config, toBlock, outcome);

  return {
    fromBlock,
    toBlock,
    eventsSeen: events.length,
    mutations: mutations.length,
    applied: outcome.applied,
    skipped: outcome.skipped,
    warnings: [...warnings, ...outcome.warnings],
  };
}

/**
 * Catch up to the head, then optionally keep following it.
 *
 * `confirmations` blocks of lag keeps the tip from being read mid-reorg. It is
 * not finality insurance — Flare finalises quickly — it just means a range is
 * never fetched while its blocks can still be replaced.
 */
export async function sync(
  db: SupabaseClient,
  config: IndexerConfig,
  options: SyncOptions = {},
): Promise<SyncSummary[]> {
  const log = options.log ?? noop;
  const provider = makeProvider(config);
  const resolver = new InvoiceResolver(db);
  const summaries: SyncSummary[] = [];

  let cursor = await loadCursor(db, config, options);
  log(`cursor at block ${cursor} (deployment block ${config.deployedAtBlock})`);

  for (;;) {
    const head = (await provider.getBlockNumber()) - config.confirmations;

    if (head <= cursor) {
      if (options.once === true) {
        log(`up to date at block ${cursor}`);
        break;
      }
      await sleep(config.pollIntervalMs);
      continue;
    }

    const from = cursor + 1;
    const to = Math.min(from + config.blockRange - 1, head);

    try {
      const summary = await syncRange(db, provider, config, from, to, resolver);
      summaries.push(summary);
      cursor = to;

      if (summary.eventsSeen > 0 || summary.warnings.length > 0) {
        log(
          `blocks ${from}-${to}: ${summary.eventsSeen} events, ` +
            `${summary.applied} applied, ${summary.skipped} skipped`,
        );
        for (const warning of summary.warnings) {
          log(`  [${warning.severity}] ${warning.event}: ${warning.message}`);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await recordError(db, config, `blocks ${from}-${to}: ${message}`);
      // Rethrown rather than swallowed and retried. The cursor has not moved, so
      // a restart re-attempts this exact range; a silent retry loop against a
      // schema error would spin forever while looking like it was working.
      throw error;
    }
  }

  provider.destroy();
  return summaries;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
