import type { InvoiceStatus } from "./schema/rpc.js";

/**
 * Translating the contract's lifecycle into the database's.
 *
 * These two enums look interchangeable and are not. `FluxaTypes.Status` in the
 * contract is:
 *
 *   CREATED(0)  PENDING(1)  PAID(2)  SETTLED(3)  CANCELLED(4)  EXPIRED(5)
 *
 * and `invoice_status` in migration 0001 is:
 *
 *   DRAFT  OPEN  PENDING  PAID  SETTLED  EXPIRED  CANCELLED
 *
 * Three differences, each of which breaks something:
 *
 *   1. **CANCELLED and EXPIRED are transposed.** On-chain CANCELLED is 4 and
 *      EXPIRED is 5; in the Postgres enum the declaration order is the other
 *      way round. Anything that indexes by ordinal — `Object.values(enum)[n]`,
 *      a generated client that maps enums positionally, a hand-written array —
 *      files every cancelled invoice as expired and vice versa. So the mapping
 *      below is by name and there is no array anywhere in this file.
 *
 *   2. **CREATED has no database twin.** It means "issued and payable", which
 *      the database calls OPEN. Passing "CREATED" to Postgres is a plain error.
 *
 *   3. **DRAFT has no on-chain twin,** and must not: a draft is an invoice the
 *      merchant has not published, so there is nothing on the chain to see. It
 *      is the state the off-chain-first flow starts in and the reason
 *      `toDbStatus` is one-directional.
 *
 * The reverse direction is deliberately absent. There is no `toChainStatus`,
 * because the database is never the authority on a lifecycle state (§5.12) and
 * a function converting the other way would only ever be used to write one.
 */

/** On-chain `FluxaTypes.Status`, by name, with its real ordinal. */
export const CHAIN_STATUS = {
  CREATED: 0,
  PENDING: 1,
  PAID: 2,
  SETTLED: 3,
  CANCELLED: 4,
  EXPIRED: 5,
} as const;

export type ChainStatusName = keyof typeof CHAIN_STATUS;

/**
 * Every on-chain status, mapped by name to the database status that means the
 * same thing. Exhaustive by construction: `Record<ChainStatusName, ...>` fails
 * to compile if the contract's enum gains a member and this is not updated.
 */
const TO_DB: Record<ChainStatusName, InvoiceStatus> = {
  // "Issued and awaiting payment." The database calls this OPEN; DRAFT is the
  // off-chain-only state that precedes publication.
  CREATED: "OPEN",
  PENDING: "PENDING",
  PAID: "PAID",
  SETTLED: "SETTLED",
  CANCELLED: "CANCELLED",
  EXPIRED: "EXPIRED",
};

/** On-chain `FluxaTypes.Rail`, by name. Ordinals match; recorded so nothing infers them. */
export const CHAIN_RAIL = {
  FLARE_ERC20: 0,
  XRPL_NATIVE: 1,
} as const;

/** Reverse lookup built from CHAIN_STATUS rather than written out again. */
const BY_ORDINAL = new Map<number, ChainStatusName>(
  Object.entries(CHAIN_STATUS).map(([name, ordinal]) => [ordinal, name as ChainStatusName]),
);

/**
 * The name of an on-chain status ordinal, as read out of a contract call or an
 * event argument.
 *
 * Throws on an unknown ordinal instead of returning a default. A status the
 * contract can produce and this file does not know about means the contract has
 * been upgraded past the indexer, and guessing at that point writes a wrong
 * lifecycle state that looks entirely normal in the UI.
 */
export function chainStatusName(ordinal: number | bigint): ChainStatusName {
  const n = Number(ordinal);
  const name = BY_ORDINAL.get(n);
  if (name === undefined) {
    throw new Error(
      `Unknown on-chain invoice status ordinal ${n}. FluxaTypes.Status has ` +
        `${BY_ORDINAL.size} members (0-${BY_ORDINAL.size - 1}); the contract may have been ` +
        `upgraded past this indexer. Refusing to guess.`,
    );
  }
  return name;
}

/** The database status corresponding to an on-chain status ordinal. */
export function toDbStatus(ordinal: number | bigint): InvoiceStatus {
  return TO_DB[chainStatusName(ordinal)];
}

/** The database status corresponding to an on-chain status name. */
export function toDbStatusByName(name: ChainStatusName): InvoiceStatus {
  return TO_DB[name];
}

/**
 * How far along the lifecycle a status is, for the monotonicity rule.
 *
 * The indexer re-scans block ranges by design — the cursor only advances after
 * a batch's writes land, so a crash replays rather than skips. Replaying means
 * an already-settled invoice can be handed a fresh `InvoicePaid`, and the
 * database must not walk backwards. 0003's writers enforce this in SQL; this
 * exists so the indexer can decide not to send the write at all, and so the
 * decision is testable without a database.
 *
 * Terminal states share rank 4: an invoice cannot go from CANCELLED to EXPIRED
 * or the reverse, and neither is "further along" than the other.
 */
const RANK: Record<InvoiceStatus, number> = {
  DRAFT: 0,
  OPEN: 1,
  PENDING: 2,
  PAID: 3,
  SETTLED: 4,
  CANCELLED: 4,
  EXPIRED: 4,
};

/**
 * True if moving from `from` to `to` is forward progress along the lifecycle.
 *
 * SETTLED, CANCELLED and EXPIRED are all terminal, so any transition *between*
 * them is refused rather than ranked — a settled invoice being cancelled is a
 * disagreement to report, not a state to apply.
 */
export function isForwardTransition(from: InvoiceStatus, to: InvoiceStatus): boolean {
  if (from === to) return false;
  return RANK[to] > RANK[from];
}
