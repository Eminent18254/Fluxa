#!/usr/bin/env tsx
import { indexerConfig } from "../config.js";
import { fetchLogs, makeProvider } from "../logs.js";
import { reduceContextFor } from "../indexer.js";
import { groupByTransaction, reduceTransaction } from "../reducer.js";

/**
 * `npm run verify:mapping` — replay a real deployment through the reducer and
 * print what it would write, without touching Supabase.
 *
 * The unit tests prove the mapping against events I constructed, which means
 * they prove the reducer agrees with my *idea* of the events. This proves it
 * agrees with the chain: real logs, real argument names, real ordering, real
 * Rail B ordering where the rail emits after the inner payInvoice returns.
 *
 * It needs a deployment and an RPC endpoint, and no credentials. Against a local
 * Hardhat node driven by `scripts/smokeLocal.ts` it is a complete end-to-end
 * check of Sprint 4's chain-facing half.
 *
 *   --network <name>   deployment record to read. Default FLUXA_NETWORK or coston2.
 *   --from <block>     first block. Default: the deployment block.
 *   --to <block>       last block. Default: the chain head.
 *   --all-topics       include logs the reducer has no handler for, so an event
 *                      the contracts gained shows up instead of being filtered out.
 */

const argv = process.argv.slice(2);
const flag = (name: string): boolean => argv.includes(`--${name}`);

function option(name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`--${name} needs a value`);
  }
  return value;
}

function intOption(name: string): number | undefined {
  const raw = option(name);
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`--${name} must be a non-negative integer, got ${raw}`);
  }
  return parsed;
}

async function main(): Promise<void> {
  const network = option("network") ?? process.env.FLUXA_NETWORK ?? "coston2";
  const config = indexerConfig(network, (m) => console.warn(`warning: ${m}`));
  const provider = makeProvider(config);

  const head = await provider.getBlockNumber();
  const fromBlock = intOption("from") ?? config.deployedAtBlock;
  const toBlock = intOption("to") ?? head;

  console.log(`network      ${config.network} (chain ${config.chainId})`);
  console.log(`rpc          ${config.rpcUrl}`);
  console.log(`range        ${fromBlock}-${toBlock} (head ${head})`);
  console.log(`invoice      ${config.addresses.invoice}`);
  console.log(`settlement   ${config.addresses.settlement}`);
  console.log(`rail         ${config.addresses.rail ?? "(not deployed)"}`);
  console.log(
    `tokens       ${[...config.tokens].map(([a, s]) => `${s}=${a}`).join(", ") || "(none)"}`,
  );

  const ctx = reduceContextFor(config);
  const allTopics = flag("all-topics");

  let seen = 0;
  let mutationCount = 0;
  let errorCount = 0;
  const kinds = new Map<string, number>();
  const railCount = new Map<string, number>();

  // Windowed, because a public RPC will refuse an eth_getLogs range that is too
  // wide and Coston2 has been running for years.
  for (let start = fromBlock; start <= toBlock; start += config.blockRange) {
    const end = Math.min(start + config.blockRange - 1, toBlock);
    const { events, unknown } = await fetchLogs(provider, config, start, end, {
      ...(allTopics ? { allTopics: true } : {}),
    });
    seen += events.length;

    for (const log of unknown) {
      console.log(
        `\n  [unknown] topic0 ${log.topic0} from ${log.address} ` +
          `at block ${log.blockNumber} did not decode`,
      );
      errorCount++;
    }

    // Per transaction, which is the unit the Rail B payer join needs.
    for (const batch of groupByTransaction(events)) {
      const first = batch[0];
      if (first === undefined) continue;

      const { mutations, warnings } = reduceTransaction(batch, ctx);

      console.log(`\nblock ${first.blockNumber}  tx ${first.txHash}`);
      console.log(`  logs      ${batch.map((e) => e.name).join(", ")}`);

      for (const mutation of mutations) {
        mutationCount++;
        kinds.set(mutation.kind, (kinds.get(mutation.kind) ?? 0) + 1);

        switch (mutation.kind) {
          case "record_payment": {
            railCount.set(mutation.rail, (railCount.get(mutation.rail) ?? 0) + 1);
            console.log(
              `  payment   ${mutation.amountUnits} ${mutation.tokenSymbol} ` +
                `via ${mutation.rail}`,
            );
            console.log(`            payer ${mutation.payerAddress}`);
            if (mutation.rail === "XRPL_NATIVE") {
              // The line that matters. If this says the rail address, the join
              // failed and every Rail B payment is recorded as Fluxa paying
              // itself.
              console.log(
                `            fronted ${mutation.frontedUnits} FXRP, ` +
                  `xrpl tx ${mutation.xrplTransactionId}, round ${mutation.votingRoundId}`,
              );
            }
            break;
          }
          case "link_invoice":
            console.log(
              `  link      onchain #${mutation.ref.onchainInvoiceId} -> ` +
                `ref ${mutation.paymentRef}`,
            );
            console.log(
              `            ${mutation.tokenAmount} ${mutation.tokenSymbol}, due ${mutation.dueAt}`,
            );
            break;
          case "bind_xrpl":
            console.log(
              `  bind      onchain #${mutation.ref.onchainInvoiceId} to XRPL, ` +
                `min ${mutation.minimumDrops} drops`,
            );
            break;
          case "record_settlement":
            console.log(
              `  settle    ${mutation.amountUnits} ${mutation.tokenSymbol} ` +
                `to ${mutation.toAddress}`,
            );
            break;
          case "attach_price_snapshot":
            console.log(
              `  price     ${mutation.priceUsd} at ${mutation.priceDecimals} decimals ` +
                `(${mutation.priceTimestamp})`,
            );
            break;
          case "set_status":
            console.log(
              `  status    onchain #${mutation.ref.onchainInvoiceId} -> ${mutation.status}`,
            );
            break;
        }
      }

      for (const warning of warnings) {
        if (warning.severity === "error") errorCount++;
        console.log(`  [${warning.severity}] ${warning.message}`);
      }
    }
  }

  provider.destroy();

  console.log("\n---");
  console.log(`events            ${seen}`);
  console.log(`mutations         ${mutationCount}`);
  for (const [kind, count] of [...kinds].sort()) {
    console.log(`  ${kind.padEnd(16)}${count}`);
  }
  if (railCount.size > 0) {
    console.log("payments by rail");
    for (const [rail, count] of [...railCount].sort()) {
      console.log(`  ${rail.padEnd(16)}${count}`);
    }
  }
  console.log(`errors            ${errorCount}`);

  if (seen === 0) {
    console.log(
      "\nNo events in this range. Against localhost, run " +
        "`npm run smoke:local -w contracts` first to produce some.",
    );
  }

  if (errorCount > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
