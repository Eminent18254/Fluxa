import { ethers } from "ethers";

import { WATCHED, type ContractKey } from "./abi.js";
import type { IndexerConfig } from "./config.js";
import type { DecodedEvent } from "./reducer.js";

/**
 * Getting logs off the chain and into the reducer's shape.
 *
 * This is the only file that talks to an RPC endpoint. Everything downstream
 * takes `DecodedEvent[]`, which is why the reducer can be tested without a node
 * and why `verifyMapping` can replay a real deployment through it.
 */

/** One `ethers.Interface` per contract, built from the hand-written fragments. */
export const INTERFACES: Record<ContractKey, ethers.Interface> = {
  invoice: new ethers.Interface([...WATCHED.invoice]),
  settlement: new ethers.Interface([...WATCHED.settlement]),
  rail: new ethers.Interface([...WATCHED.rail]),
  invoiceV2: new ethers.Interface([...WATCHED.invoiceV2]),
  settlementV2: new ethers.Interface([...WATCHED.settlementV2]),
};

/** topic0 for every event the reducer handles, so the node filters for us. */
export const HANDLED_TOPICS: string[] = (() => {
  const topics = new Set<string>();
  for (const iface of Object.values(INTERFACES)) {
    iface.forEachEvent((fragment) => topics.add(fragment.topicHash));
  }
  return [...topics];
})();

export type UnknownLog = {
  address: string;
  topic0: string;
  txHash: string;
  logIndex: number;
  blockNumber: number;
};

export type FetchResult = {
  events: DecodedEvent[];
  /**
   * Logs from a watched address whose topic0 no interface recognises. Empty
   * unless `allTopics` was set — the filtered path never receives one.
   */
  unknown: UnknownLog[];
};

/**
 * Resolve block numbers to their chain timestamps, once each.
 *
 * `paid_at` and `settled_at` are the chain's clock, not the indexer's: an
 * indexer that was offline for a day and then caught up must not stamp
 * yesterday's payments with today's time. A block header is one round trip and a
 * range usually touches only a handful of distinct blocks, so the cache does the
 * real work here.
 */
export class BlockTimeCache {
  private readonly times = new Map<number, number>();

  constructor(private readonly provider: ethers.Provider) {}

  async get(blockNumber: number): Promise<number> {
    const cached = this.times.get(blockNumber);
    if (cached !== undefined) return cached;

    const block = await this.provider.getBlock(blockNumber);
    if (block === null) {
      throw new Error(
        `block ${blockNumber} could not be read; it produced logs, so the RPC ` +
          `endpoint is inconsistent with itself`,
      );
    }
    this.times.set(blockNumber, block.timestamp);
    return block.timestamp;
  }

  get size(): number {
    return this.times.size;
  }
}

/**
 * Normalise a decoded log's arguments into the plain record the reducer wants.
 *
 * ethers hands back a `Result`, which is an array with named accessors. Turning
 * it into a plain object by name means the reducer reads `args.payToken` rather
 * than `args[2]` — and positional access is exactly the class of bug that
 * transposed the status enums.
 */
function namedArgs(
  fragment: ethers.EventFragment,
  decoded: ethers.Result,
): Record<string, bigint | string> {
  const args: Record<string, bigint | string> = {};
  fragment.inputs.forEach((input, index) => {
    const value = decoded[index] as unknown;
    args[input.name] =
      typeof value === "bigint"
        ? value
        : typeof value === "number"
          ? BigInt(value)
          : String(value);
  });
  return args;
}

export type FetchOptions = {
  /**
   * Fetch every log from the watched addresses instead of only the handled
   * topics. Slower and noisier; used by `verify:mapping` so an event the
   * contracts gained is visible rather than filtered away before anyone sees it.
   */
  allTopics?: boolean;
};

/**
 * Every handled event emitted by the watched contracts in `[fromBlock, toBlock]`.
 *
 * One `eth_getLogs` for all three addresses rather than one per contract: the
 * Rail B payer join needs both `InvoicePaid` and `XrplPaymentAccepted` from the
 * same transaction, and separate queries would have to be stitched back together
 * afterwards anyway.
 */
export async function fetchLogs(
  provider: ethers.Provider,
  config: IndexerConfig,
  fromBlock: number,
  toBlock: number,
  options: FetchOptions = {},
): Promise<FetchResult> {
  const addresses = [config.addresses.invoice, config.addresses.settlement];
  if (config.addresses.rail !== null) addresses.push(config.addresses.rail);
  if (config.addresses.invoiceV2 !== null) addresses.push(config.addresses.invoiceV2);
  if (config.addresses.settlementV2 !== null) addresses.push(config.addresses.settlementV2);

  const ranges: Array<{ fromBlock: number; toBlock: number }> = [];
  for (let start = fromBlock; start <= toBlock; start += config.rpcLogRange) {
    ranges.push({ fromBlock: start, toBlock: Math.min(start + config.rpcLogRange - 1, toBlock) });
  }

  const logs: ethers.Log[] = [];
  let nextRange = 0;
  const workers = Array.from(
    { length: Math.min(config.rpcLogConcurrency, ranges.length) },
    async () => {
      for (;;) {
        const index = nextRange++;
        const range = ranges[index];
        if (range === undefined) return;
        const filter: ethers.Filter = {
          address: addresses,
          ...range,
          ...(options.allTopics === true ? {} : { topics: [HANDLED_TOPICS] }),
        };
        logs.push(...await provider.getLogs(filter));
      }
    },
  );
  await Promise.all(workers);
  logs.sort((left, right) => left.blockNumber - right.blockNumber || left.index - right.index);
  const times = new BlockTimeCache(provider);

  const events: DecodedEvent[] = [];
  const unknown: UnknownLog[] = [];

  for (const log of logs) {
    const address = log.address.toLowerCase();
    const contract = config.contractsByAddress.get(address);
    if (contract === undefined) {
      // Cannot happen: the filter named these addresses. Kept because a proxy or
      // a misconfigured provider returning foreign logs should surface, not be
      // silently attributed to whichever contract happens to decode it.
      unknown.push({
        address,
        topic0: log.topics[0] ?? "0x",
        txHash: log.transactionHash,
        logIndex: log.index,
        blockNumber: log.blockNumber,
      });
      continue;
    }

    const parsed = INTERFACES[contract].parseLog({
      topics: [...log.topics],
      data: log.data,
    });

    if (parsed === null) {
      unknown.push({
        address,
        topic0: log.topics[0] ?? "0x",
        txHash: log.transactionHash,
        logIndex: log.index,
        blockNumber: log.blockNumber,
      });
      continue;
    }

    events.push({
      contract,
      name: parsed.name,
      args: namedArgs(parsed.fragment, parsed.args),
      address,
      txHash: log.transactionHash,
      logIndex: log.index,
      blockNumber: log.blockNumber,
      blockTimestamp: await times.get(log.blockNumber),
    });
  }

  return { events, unknown };
}

/** A provider for the configured network. Static network, so it makes no discovery call. */
export function makeProvider(config: IndexerConfig): ethers.JsonRpcProvider {
  return new ethers.JsonRpcProvider(config.rpcUrl, config.chainId, {
    staticNetwork: ethers.Network.from(config.chainId),
  });
}
