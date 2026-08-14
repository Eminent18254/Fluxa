import { ethers } from "hardhat";
import { impersonateAccount, setBalance } from "@nomicfoundation/hardhat-network-helpers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import type { BaseContract, Signer } from "ethers";

import { COSTON2, FLARE_CONTRACT_REGISTRY } from "../config/flare";
import type { HolderCandidate } from "../config/coston2Holders";
import { HOLDERS_CAPTURED_AT } from "../config/coston2Holders";

/**
 * Helpers for tests that run against a Coston2 fork.
 *
 * The offline suites prove Fluxa's logic. They cannot prove the integration,
 * because a mock agrees with whatever assumption was built into it — a wrong feed
 * id, a token that is not really 6-decimal, or an FAsset that behaves unlike a
 * plain ERC-20 would all pass every offline test. These helpers exist so the
 * integration suites can use the *real* contracts and the *real* tokens.
 */

/** Minimum gas balance handed to an impersonated account, in wei. */
const GAS_STIPEND = ethers.parseEther("10");

/** ERC-20 surface these helpers need. Avoids depending on a specific artifact. */
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function transfer(address,uint256) returns (bool)",
  "function approve(address,uint256) returns (bool)",
  "function allowance(address,address) view returns (uint256)",
] as const;

export type ForkStatus =
  | { available: true; block: number }
  | { available: false; reason: string };

/**
 * Point the in-process network at a Coston2 fork.
 *
 * Returns a status rather than throwing so a suite can skip itself with a visible
 * reason when the RPC is unreachable, instead of failing an otherwise-offline test
 * run. Network access is a property of the environment, not a bug in the code
 * under test.
 *
 * Callers must `reset()` in an `after` hook — a fork left in place makes the next
 * suite read Coston2 state, which is slow and confusing.
 */
export async function forkCoston2(): Promise<ForkStatus> {
  // `reset` from the helpers rather than a raw hardhat_reset: it also clears
  // loadFixture's snapshot registry. A bare hardhat_reset silently invalidates
  // every snapshot other files took, and the resulting InvalidSnapshotError
  // points at the wrong test entirely.
  const { reset, mine } = await import("@nomicfoundation/hardhat-network-helpers");

  try {
    await reset(COSTON2.rpcUrl);
    const forkBlock = await ethers.provider.getBlockNumber();

    // Mine one local block before returning.
    //
    // Not cosmetic. EDR treats the fork block itself as *historical*, and to
    // execute a call against a historical block it needs to know which hardfork
    // was active then — which it only knows for chains in its built-in activation
    // history. Flare is not one of them, so any read taken while `latest` is still
    // the fork block fails with:
    //
    //   No known hardfork for execution on historical block N (relative to fork
    //   block number N) in chain with id 114
    //
    // Mining once makes `latest` a local block, which EDR runs under the hardfork
    // this project configures (cancun). Forked state is unchanged: block N+1
    // inherits everything from the fork.
    //
    // This is easy to miss because it only bites tests that read *before* sending
    // a transaction — any deploy hides it by advancing the block itself.
    await mine();

    // Connecting is not the same as forking Coston2. The registry's code is the
    // cheapest thing that can only be true on a real Flare fork.
    if ((await ethers.provider.getCode(FLARE_CONTRACT_REGISTRY)) === "0x") {
      return {
        available: false,
        reason: `no registry code at ${FLARE_CONTRACT_REGISTRY} on the fork`,
      };
    }

    return { available: true, block: forkBlock };
  } catch (error) {
    return {
      available: false,
      reason: `could not fork ${COSTON2.rpcUrl}: ${(error as Error).message}`,
    };
  }
}

/** A live token, typed to the minimal ERC-20 surface. */
export function erc20At(address: string) {
  return new ethers.Contract(address, ERC20_ABI, ethers.provider);
}

/**
 * The same token, bound to a signer so it can send transactions.
 *
 * `Contract.connect()` is typed to return `BaseContract`, which drops every method
 * off the returned value — so `erc20At(t).connect(s).transfer(...)` reads fine and
 * fails to typecheck. Re-attaching through the constructor keeps the ABI's typing.
 */
export function erc20As(address: string, signer: Signer) {
  return new ethers.Contract(address, ERC20_ABI, signer);
}

/**
 * Find a candidate holding at least `minimum` of `token`, and return it as a
 * usable signer.
 *
 * Balances move, so the candidate list is tried in order rather than trusted. The
 * failure message names the refresh command, because "impersonation failed" is a
 * useless thing to read six weeks from now when a whale has moved their funds.
 *
 * The account is also given native gas: impersonation grants the right to send
 * from an address, not the balance to pay for it, and a holder with zero C2FLR
 * fails with an opaque insufficient-funds error.
 */
export async function findFundedHolder(
  tokenAddress: string,
  candidates: readonly HolderCandidate[],
  minimum: bigint,
): Promise<{ signer: HardhatEthersSigner; balance: bigint }> {
  const token = erc20At(tokenAddress);
  const observed: string[] = [];

  for (const candidate of candidates) {
    const balance: bigint = await token.balanceOf(candidate.address);
    observed.push(`${candidate.address} holds ${balance}`);

    if (balance < minimum) continue;

    await impersonateAccount(candidate.address);
    await setBalance(candidate.address, GAS_STIPEND);

    return { signer: await ethers.getSigner(candidate.address), balance };
  }

  throw new Error(
    `No candidate holds the ${minimum} base units of ${tokenAddress} this test needs.\n` +
      `Candidates were captured ${HOLDERS_CAPTURED_AT} and balances move.\n` +
      `Observed:\n  ${observed.join("\n  ")}\n` +
      `Refresh config/coston2Holders.ts — see the curl command in its header.`,
  );
}

/**
 * Deploy the full Fluxa system against the live Flare Contract Registry.
 *
 * Same construction order the deploy script uses, so a fork test that passes is
 * evidence about the deployment and not just about the contracts. `maxPriceAge`
 * is a parameter because a test that ages a price needs a different window than
 * one reading a live feed.
 */
export async function deployFluxaOnFork(maxPriceAge: bigint) {
  const [deployer, merchant] = await ethers.getSigners();

  const FluxaInvoice = await ethers.getContractFactory("FluxaInvoice");
  const invoice = await FluxaInvoice.deploy(deployer.address);
  await invoice.waitForDeployment();

  const FluxaSettlement = await ethers.getContractFactory("FluxaSettlement");
  const settlement = await FluxaSettlement.deploy(
    deployer.address,
    await invoice.getAddress(),
  );
  await settlement.waitForDeployment();

  const FluxaPriceOracle = await ethers.getContractFactory("FluxaPriceOracle");
  const priceOracle = await FluxaPriceOracle.deploy(
    deployer.address,
    FLARE_CONTRACT_REGISTRY,
    maxPriceAge,
  );
  await priceOracle.waitForDeployment();

  await (await invoice.setSettlementContract(await settlement.getAddress())).wait();
  await (await settlement.setPriceOracle(await priceOracle.getAddress())).wait();

  return { deployer, merchant, invoice, settlement, priceOracle };
}

/** Register a live token as payable and priceable, the way deploy.ts does. */
export async function enableAsset(
  contracts: Awaited<ReturnType<typeof deployFluxaOnFork>>,
  tokenAddress: string,
  feedId: string,
) {
  await (await contracts.invoice.setAcceptedToken(tokenAddress, true)).wait();
  await (await contracts.priceOracle.setFeed(tokenAddress, feedId)).wait();
}

/** Address of a deployed contract, for readability at call sites. */
export async function addressOf(contract: BaseContract): Promise<string> {
  return contract.getAddress();
}
