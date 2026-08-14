import { Contract, type Provider } from "ethers";

import { COSTON2_PROTOCOL, FLARE_TIMING } from "./flare";

/**
 * FDC voting-round arithmetic, resolved from the chain rather than from constants.
 *
 * Sprint 3 §7.4.4. Fetching an FDC proof means asking the DA layer for a specific
 * voting round, and the round is derived from the attested payment's timestamp:
 *
 *     round = floor((timestamp - firstVotingRoundStartTs) / votingEpochDurationSeconds)
 *
 * Get `firstVotingRoundStartTs` wrong and the arithmetic still succeeds — it just
 * names a different round, the DA layer returns no proof for the request, and the
 * failure looks like "the attestation was not confirmed" rather than "we asked the
 * wrong question". There is no error to catch, which is what makes it worth reading
 * the value from `FlareSystemsManager` instead of trusting a recorded copy.
 *
 * ## Why this module exists rather than a corrected constant
 *
 * `FLARE_TIMING` in config/flare.ts records `firstVotingRoundStartTs: 1658429488`.
 * The live Coston2 `FlareSystemsManager` reports **1658430000** — 512 seconds later,
 * or 5.7 voting rounds. `votingEpochDurationSeconds: 90` is correct.
 *
 * That constant is Sprint 1 work, so it is left alone here; nothing outside Sprint 3
 * reads it. {@link assertTimingMatchesChain} reports the drift instead of asserting
 * it away, and every Sprint 3 caller resolves timing through
 * {@link fetchVotingEpoch}, so the stale value cannot reach the DA layer.
 */

/** Timing that defines the voting-round grid. */
export type VotingEpoch = {
  readonly firstVotingRoundStartTs: number;
  readonly votingEpochDurationSeconds: number;
};

/** Minimal ABI — only the two timing getters are needed. */
export const FLARE_SYSTEMS_MANAGER_ABI = [
  "function firstVotingRoundStartTs() view returns (uint64)",
  "function votingEpochDurationSeconds() view returns (uint64)",
] as const;

/**
 * Read the voting-round grid from the live FlareSystemsManager.
 *
 * Prefer resolving the manager through the Flare Contract Registry when a registry
 * lookup is already at hand; the recorded address is the fallback, and the fork
 * suite asserts the two agree.
 */
export async function fetchVotingEpoch(
  provider: Provider,
  managerAddress: string = COSTON2_PROTOCOL.FlareSystemsManager,
): Promise<VotingEpoch> {
  const manager = new Contract(managerAddress, FLARE_SYSTEMS_MANAGER_ABI, provider);

  const [firstTs, duration] = await Promise.all([
    manager.firstVotingRoundStartTs() as Promise<bigint>,
    manager.votingEpochDurationSeconds() as Promise<bigint>,
  ]);

  if (duration === 0n) {
    throw new Error(
      `FlareSystemsManager at ${managerAddress} reports a zero voting epoch duration; ` +
        "refusing to divide by it.",
    );
  }

  return {
    firstVotingRoundStartTs: Number(firstTs),
    votingEpochDurationSeconds: Number(duration),
  };
}

/** The voting round containing `timestamp`. */
export function votingRoundIdAt(timestamp: number, epoch: VotingEpoch): number {
  if (timestamp < epoch.firstVotingRoundStartTs) {
    throw new Error(
      `timestamp ${timestamp} precedes the first voting round ` +
        `(${epoch.firstVotingRoundStartTs}); no round contains it.`,
    );
  }
  return Math.floor(
    (timestamp - epoch.firstVotingRoundStartTs) / epoch.votingEpochDurationSeconds,
  );
}

/** Unix timestamp at which `roundId` opens. */
export function votingRoundStartTs(roundId: number, epoch: VotingEpoch): number {
  return epoch.firstVotingRoundStartTs + roundId * epoch.votingEpochDurationSeconds;
}

/**
 * Earliest wall-clock time a proof for `roundId` can exist.
 *
 * The round must close and then be finalised, so a proof requested mid-round is not
 * available until at least one full epoch after the round's start. Callers polling
 * the DA layer should not begin before this.
 */
export function earliestProofTs(roundId: number, epoch: VotingEpoch): number {
  return votingRoundStartTs(roundId + 1, epoch);
}

/**
 * Compare the recorded constants against the chain.
 *
 * Returns a description of the drift rather than throwing: the recorded value being
 * stale is a fact to surface, not a reason to stop a run that no longer depends on
 * it. Returns `null` when they agree, at which point Sprint 3's callers could go
 * back to the constant — though reading from chain remains the safer default.
 */
export function describeTimingDrift(chain: VotingEpoch): string | null {
  const startDrift = chain.firstVotingRoundStartTs - FLARE_TIMING.firstVotingRoundStartTs;
  const durationDrift =
    chain.votingEpochDurationSeconds - FLARE_TIMING.votingEpochDurationSeconds;

  if (startDrift === 0 && durationDrift === 0) return null;

  const rounds = (startDrift / chain.votingEpochDurationSeconds).toFixed(1);
  return (
    `config/flare.ts FLARE_TIMING disagrees with the live FlareSystemsManager: ` +
    `firstVotingRoundStartTs recorded ${FLARE_TIMING.firstVotingRoundStartTs}, ` +
    `chain reports ${chain.firstVotingRoundStartTs} (${startDrift >= 0 ? "+" : ""}${startDrift}s, ` +
    `${rounds} voting rounds); votingEpochDurationSeconds recorded ` +
    `${FLARE_TIMING.votingEpochDurationSeconds}, chain reports ` +
    `${chain.votingEpochDurationSeconds}. Sprint 3 reads timing from chain, so this ` +
    `does not affect proof lookups — but the constant is wrong and should be corrected.`
  );
}
