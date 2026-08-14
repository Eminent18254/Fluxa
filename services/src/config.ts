import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ethers } from "ethers";
import * as dotenv from "dotenv";

import type { AssetSymbol } from "./schema/rpc.js";
import type { ContractKey } from "./abi.js";

/**
 * Where the indexer gets its facts.
 *
 * Two sources, and the split matters. Secrets come from the environment; the
 * *addresses* come from the deployment record that `scripts/deploy.ts` writes,
 * never from the environment.
 *
 * The `.env.example` at the repository root offers `VITE_INVOICE_REGISTRY_ADDRESS`
 * and `VITE_SETTLEMENT_VAULT_ADDRESS`, which would be the obvious place to look.
 * They are the wrong source for this service, for three reasons: there are four
 * contracts and only two variables (no rail, no oracle); an address in an env
 * file can drift from the chain silently, whereas the deployment record is
 * written by the deploy that produced those addresses; and the record also
 * carries `deployedAtBlock` and the token set, which the indexer needs and no
 * environment variable holds.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const DEPLOYMENTS_DIR = path.resolve(REPO_ROOT, "contracts", "deployments");

// The repository keeps one .env at the root, shared by contracts and services.
// `override: false` so a real environment variable — a CI secret, a container
// env — always wins over a stale file on a developer's disk.
dotenv.config({ path: path.join(REPO_ROOT, ".env"), override: false, quiet: true });

/** A token as the deployment recorded it. */
export type DeployedToken = {
  symbol: string;
  address: string;
  decimals: number;
  feedId?: string;
  feedName?: string;
  mock?: boolean;
};

/** The shape of `contracts/deployments/<network>.json`, as far as this service cares. */
export type DeploymentRecord = {
  network: string;
  chainId: number;
  deployedAtBlock: number;
  contracts: Record<string, string>;
  tokens: DeployedToken[];
};

/** Every `asset_symbol` the database enum allows. */
const KNOWN_SYMBOLS = new Set<AssetSymbol>(["FXRP", "USDT0", "XRP"]);

function isAssetSymbol(value: string): value is AssetSymbol {
  return KNOWN_SYMBOLS.has(value as AssetSymbol);
}

export function deploymentPath(network: string): string {
  return path.join(DEPLOYMENTS_DIR, `${network}.json`);
}

export function loadDeployment(network: string): DeploymentRecord {
  const file = deploymentPath(network);
  if (!fs.existsSync(file)) {
    const available = fs.existsSync(DEPLOYMENTS_DIR)
      ? fs
          .readdirSync(DEPLOYMENTS_DIR)
          .filter((f) => f.endsWith(".json") && !f.includes("preflight"))
          .map((f) => f.replace(/\.json$/, ""))
      : [];
    throw new Error(
      `No deployment record at ${path.relative(REPO_ROOT, file)}. ` +
        `Run \`npm run deploy -w contracts\` against ${network} first.` +
        (available.length > 0 ? ` Available: ${available.join(", ")}.` : ""),
    );
  }

  const record = JSON.parse(fs.readFileSync(file, "utf8")) as DeploymentRecord;

  for (const field of ["chainId", "deployedAtBlock", "contracts"] as const) {
    if (record[field] === undefined) {
      throw new Error(`${path.basename(file)} is missing "${field}"`);
    }
  }
  // V2 is deliberately written to a second deployment record so deploying it
  // can never overwrite the addresses that keep existing V1 links alive. The
  // indexer consumes a merged in-memory view and fingerprints the full set.
  const v2File = path.join(DEPLOYMENTS_DIR, `${network}-v2.json`);
  if (!fs.existsSync(v2File)) return record;

  const v2 = JSON.parse(fs.readFileSync(v2File, "utf8")) as DeploymentRecord;
  return {
    ...record,
    deployedAtBlock: Math.min(record.deployedAtBlock, v2.deployedAtBlock),
    contracts: { ...record.contracts, ...v2.contracts },
    tokens: [...(record.tokens ?? []), ...(v2.tokens ?? [])].filter(
      (token, index, all) =>
        all.findIndex((candidate) => candidate.address.toLowerCase() === token.address.toLowerCase()) === index,
    ),
  };
}

/**
 * Which deployed addresses the indexer subscribes to.
 *
 * `rail` is optional on purpose. A deployment record written before Sprint 3
 * has no `FluxaFdcPaymentRail`, and the indexer should still be able to follow
 * Rail A against it rather than refusing to start. Where the rail is absent,
 * `XrplPaymentAccepted` cannot occur, so every payment is correctly Rail A.
 */
export type WatchedAddresses = {
  invoice: string;
  settlement: string;
  rail: string | null;
  invoiceV2: string | null;
  settlementV2: string | null;
};

export function watchedAddresses(record: DeploymentRecord): WatchedAddresses {
  const need = (name: string): string => {
    const address = record.contracts[name];
    if (typeof address !== "string" || !ethers.isAddress(address)) {
      throw new Error(
        `Deployment record for ${record.network} has no valid ${name} address`,
      );
    }
    return address.toLowerCase();
  };

  const rail = record.contracts.FluxaFdcPaymentRail;
  const invoiceV2 = record.contracts.FluxaInvoiceV2;
  const settlementV2 = record.contracts.FluxaSettlementV2;
  if ((invoiceV2 && !settlementV2) || (!invoiceV2 && settlementV2)) {
    throw new Error(`Deployment record for ${record.network} must contain both V2 contracts or neither.`);
  }
  return {
    invoice: need("FluxaInvoice"),
    settlement: need("FluxaSettlement"),
    rail: typeof rail === "string" && ethers.isAddress(rail) ? rail.toLowerCase() : null,
    invoiceV2: typeof invoiceV2 === "string" && ethers.isAddress(invoiceV2) ? invoiceV2.toLowerCase() : null,
    settlementV2: typeof settlementV2 === "string" && ethers.isAddress(settlementV2) ? settlementV2.toLowerCase() : null,
  };
}

/** Reverse the watch list, so a log's address identifies its contract. */
export function contractKeyByAddress(
  addresses: WatchedAddresses,
): Map<string, ContractKey> {
  const map = new Map<string, ContractKey>();
  map.set(addresses.invoice, "invoice");
  map.set(addresses.settlement, "settlement");
  if (addresses.rail !== null) map.set(addresses.rail, "rail");
  if (addresses.invoiceV2 !== null) map.set(addresses.invoiceV2, "invoiceV2");
  if (addresses.settlementV2 !== null) map.set(addresses.settlementV2, "settlementV2");
  return map;
}

/**
 * Token address to `asset_symbol`, from the deployment's own token list.
 *
 * Reading it from the record rather than hardcoding the Coston2 addresses is
 * what lets the same reducer run against a local chain, where the tokens are
 * freshly deployed mocks at addresses nobody can know in advance.
 *
 * A symbol the database enum does not have is dropped with a warning rather
 * than mapped to something adjacent: an unmapped address makes the reducer
 * refuse the write and say why, which is recoverable. A wrong symbol is a wrong
 * number in front of a merchant, which is not.
 */
export function tokenSymbolMap(
  record: DeploymentRecord,
  onSkip?: (message: string) => void,
): Map<string, AssetSymbol> {
  const map = new Map<string, AssetSymbol>();
  for (const token of record.tokens ?? []) {
    if (!isAssetSymbol(token.symbol)) {
      onSkip?.(
        `deployment lists token ${token.symbol} at ${token.address}, which is not a ` +
          `member of the asset_symbol enum; payments in it will be refused`,
      );
      continue;
    }
    map.set(token.address.toLowerCase(), token.symbol);
  }
  return map;
}

/**
 * A stable identity for "this set of contracts at these addresses".
 *
 * The cursor in `sync_state` is a block number, and a block number is only
 * meaningful relative to a deployment. Redeploying to a fresh chain resets block
 * numbers while the old cursor sits in the database pointing at a height the new
 * contracts have not reached — so the indexer would resume from the future and
 * silently skip every event before it. The fingerprint makes that mismatch
 * detectable: it changes when any watched address does, and the indexer refuses
 * a cursor whose fingerprint is not its own.
 *
 * Sorted, lowercased, and joined — so the hash depends on the set of addresses
 * and not on the order the record happened to list them in.
 */
export function contractFingerprint(
  chainId: number,
  addresses: WatchedAddresses,
): string {
  const parts = [addresses.invoice, addresses.settlement];
  if (addresses.rail !== null) parts.push(addresses.rail);
  if (addresses.invoiceV2 !== null) parts.push(addresses.invoiceV2);
  if (addresses.settlementV2 !== null) parts.push(addresses.settlementV2);
  parts.sort();
  return ethers.id(`${chainId}:${parts.join(",")}`);
}

function requireEnv(name: string, hint: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`${name} is not set. ${hint}`);
  }
  return value.trim();
}

export type SupabaseConfig = {
  url: string;
  serviceRoleKey: string;
};

/**
 * The service-role credentials, which bypass Row Level Security entirely.
 *
 * Read here and nowhere else, so there is exactly one place in the codebase to
 * audit for "does this key ever reach the browser". The answer is no: this file
 * is in the `services` workspace, which Vite does not bundle, and the variable
 * has no `VITE_` prefix, so Vite would refuse to expose it even if it were
 * imported by accident.
 */
export function supabaseConfig(): SupabaseConfig {
  return {
    url: requireEnv(
      "SUPABASE_URL",
      "Copy it from your Supabase project settings (API → Project URL).",
    ),
    serviceRoleKey: requireEnv(
      "SUPABASE_SERVICE_ROLE_KEY",
      "Supabase project settings → API → service_role. This key bypasses RLS: " +
        "keep it in .env, never in the frontend, never in a commit.",
    ),
  };
}

export type IndexerConfig = {
  network: string;
  rpcUrl: string;
  chainId: number;
  deployedAtBlock: number;
  addresses: WatchedAddresses;
  contractsByAddress: Map<string, ContractKey>;
  tokens: Map<string, AssetSymbol>;
  fingerprint: string;
  /** `sync_state.id`. One cursor per network, so two networks can be followed at once. */
  syncStateId: string;
  /** Logs are fetched in windows this wide; RPC providers cap the range. */
  blockRange: number;
  /** Maximum span of one eth_getLogs request. Coston2 currently enforces 30. */
  rpcLogRange: number;
  /** Bounded parallelism for the small RPC log windows inside one batch. */
  rpcLogConcurrency: number;
  /** How long to wait between polls when following the head, in milliseconds. */
  pollIntervalMs: number;
  /** Blocks to stay behind the head, so a reorg is re-scanned rather than missed. */
  confirmations: number;
};

const DEFAULT_RPC: Record<string, string> = {
  coston2: "https://coston2-api.flare.network/ext/C/rpc",
  localhost: "http://127.0.0.1:8545",
  hardhat: "http://127.0.0.1:8545",
};

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

export function indexerConfig(
  network = process.env.FLUXA_NETWORK ?? "coston2",
  onWarn?: (message: string) => void,
): IndexerConfig {
  const record = loadDeployment(network);
  const addresses = watchedAddresses(record);

  const rpcUrl =
    process.env.FLUXA_RPC_URL?.trim() ||
    process.env.COSTON2_RPC_URL?.trim() ||
    DEFAULT_RPC[network];

  if (rpcUrl === undefined || rpcUrl === "") {
    throw new Error(
      `No RPC URL for network "${network}". Set FLUXA_RPC_URL, or use one of: ` +
        `${Object.keys(DEFAULT_RPC).join(", ")}.`,
    );
  }

  if (addresses.rail === null) {
    onWarn?.(
      `deployment record for ${network} has no FluxaFdcPaymentRail; following Rail A only`,
    );
  }

  return {
    network,
    rpcUrl,
    chainId: record.chainId,
    deployedAtBlock: record.deployedAtBlock,
    addresses,
    contractsByAddress: contractKeyByAddress(addresses),
    tokens: tokenSymbolMap(record, onWarn),
    fingerprint: contractFingerprint(record.chainId, addresses),
    syncStateId: `fluxa:${network}`,
    // Coston2's public RPC serves 10k-block eth_getLogs windows comfortably; a
    // wider range is where "query returned more than N results" starts.
    blockRange: intEnv("FLUXA_BLOCK_RANGE", 5_000),
    rpcLogRange: intEnv("FLUXA_RPC_LOG_RANGE", network === "coston2" ? 30 : 5_000),
    rpcLogConcurrency: intEnv("FLUXA_RPC_LOG_CONCURRENCY", network === "coston2" ? 8 : 1),
    // Flare blocks are ~1.8s. Polling faster than that just re-reads the same head.
    pollIntervalMs: intEnv("FLUXA_POLL_INTERVAL_MS", 4_000),
    // Flare has no probabilistic finality to wait out, but a couple of blocks of
    // lag costs nothing and means the tip is never read mid-reorg. Every write is
    // idempotent, so re-scanning the lag window on each poll is harmless.
    confirmations: intEnv("FLUXA_CONFIRMATIONS", 2),
  };
}

export { REPO_ROOT, DEPLOYMENTS_DIR };
