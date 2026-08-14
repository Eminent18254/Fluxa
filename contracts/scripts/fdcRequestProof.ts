import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

import { COSTON2_PROTOCOL, FDC, FLARE_CONTRACT_REGISTRY } from "../config/flare";
import {
  earliestProofTs,
  fetchVotingEpoch,
  votingRoundIdAt,
  votingRoundStartTs,
  type VotingEpoch,
} from "../config/fdcTiming";

/**
 * Request an FDC attestation for an XRPL payment and drive it into Rail B.
 *
 * Sprint 3 §7.4.4, off-chain half. `FluxaFdcPaymentRail` verifies a proof; nothing
 * in Solidity can *produce* one. That is this script: the five-stage round trip
 * between an XRPL testnet payment and a `payInvoiceFromXrpl` call.
 *
 *   1. Prepare   — POST the transaction to Flare's XRP verifier, which validates it
 *                  and returns the ABI-encoded attestation request.
 *   2. Fee       — read the request price from FdcRequestFeeConfigurations.
 *   3. Request   — submit to FdcHub with the fee attached.
 *   4. Wait      — the request lands in a 90s voting round; a proof exists only once
 *                  that round has closed and been finalised.
 *   5. Collect   — fetch the Merkle proof from the DA layer, decode the response.
 *   6. Redeem    — hand the proof to the rail, which verifies and fronts the FXRP.
 *
 * ## The blocker, stated plainly
 *
 * Stage 1 requires `VERIFIER_API_KEY_TESTNET`. It is not in this repository and
 * Flare issues it on request — so **stages 1-6 have never been executed against the
 * live network**. What has been executed is everything that does not need the key:
 * run with `--preflight` and the script resolves every FDC contract through the
 * registry, prices a real request, derives the voting-round grid from chain, and
 * inspects the XRPL transaction. That is the honest boundary. Nothing here is
 * reported as verified when it was not.
 *
 * Once the key exists, no code should need to change: set it in the repo-root .env
 * and drop `--preflight`.
 *
 * ## Usage
 *
 * Configuration is by environment variable, because Hardhat 2's `run` task does not
 * forward script arguments.
 *
 *   # everything that works without the key (the default)
 *   npx hardhat run scripts/fdcRequestProof.ts --network coston2
 *   FDC_TXID=ABC... npx hardhat run scripts/fdcRequestProof.ts --network coston2
 *
 *   # full round trip, once VERIFIER_API_KEY_TESTNET is set
 *   FDC_FULL=1 FDC_TXID=ABC... FDC_INVOICE=7 FDC_RAIL=0xRail... \
 *     npx hardhat run scripts/fdcRequestProof.ts --network coston2
 *
 * The XRPL payment must carry the invoice's `paymentRef` as its first memo's
 * MemoData, hex, no 0x prefix. That is where FDC reads `standardPaymentReference`
 * from, and the rail refuses any proof whose reference does not match the invoice.
 */

// ---------------------------------------------------------------------------
// Stage plumbing
// ---------------------------------------------------------------------------

/**
 * A failure attributable to one stage, carrying what to do about it.
 *
 * The point is that "it didn't work" is useless here: a 401 from the verifier, an
 * unfunded deployer and an unfinalised voting round all surface as an absent proof
 * and have nothing to do with each other.
 */
class StageError extends Error {
  constructor(
    readonly stage: string,
    message: string,
    readonly remedy: string,
  ) {
    super(message);
    this.name = "StageError";
  }
}

const OUTPUT_DIR = path.resolve(__dirname, "..", "deployments");

/** How long to keep asking the DA layer before giving up, in seconds. */
const PROOF_POLL_TIMEOUT = 600;
const PROOF_POLL_INTERVAL = 15;

const IPAYMENT_RESPONSE_ABI =
  "tuple(" +
  "bytes32 attestationType," +
  "bytes32 sourceId," +
  "uint64 votingRound," +
  "uint64 lowestUsedTimestamp," +
  "tuple(bytes32 transactionId,uint256 inUtxo,uint256 utxo) requestBody," +
  "tuple(" +
  "uint64 blockNumber,uint64 blockTimestamp,bytes32 sourceAddressHash," +
  "bytes32 sourceAddressesRoot,bytes32 receivingAddressHash," +
  "bytes32 intendedReceivingAddressHash,int256 spentAmount," +
  "int256 intendedSpentAmount,int256 receivedAmount," +
  "int256 intendedReceivedAmount,bytes32 standardPaymentReference," +
  "bool oneToOne,uint8 status" +
  ") responseBody" +
  ")";

const FDC_HUB_ABI = [
  "function requestAttestation(bytes _data) payable",
  "event AttestationRequest(bytes data, uint256 fee)",
] as const;

const FEE_CONFIG_ABI = [
  "function getRequestFee(bytes _data) view returns (uint256)",
] as const;

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

type Args = {
  txid: string | null;
  invoiceId: bigint | null;
  rail: string | null;
  preflight: boolean;
};

function parseArgs(): Args {
  // Hardhat 2's `run` task rejects unrecognised parameters and does not forward a
  // trailing `--`, so configuration comes through the environment.
  const at = (name: string) => process.env[name]?.trim() || null;

  const rawTxid = at("FDC_TXID");
  let txid: string | null = null;
  if (rawTxid) {
    // XRPL prints hashes uppercase and unprefixed; FDC wants 32 bytes, 0x-prefixed.
    const hex = rawTxid.startsWith("0x") ? rawTxid.slice(2) : rawTxid;
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
      throw new StageError(
        "args",
        `FDC_TXID=${rawTxid} is not a 32-byte hex hash`,
        "Pass the XRPL transaction hash: 64 hex characters, 0x prefix optional.",
      );
    }
    txid = `0x${hex.toLowerCase()}`;
  }

  const rawInvoice = at("FDC_INVOICE");
  const rawRail = at("FDC_RAIL");

  return {
    txid,
    invoiceId: rawInvoice === null ? null : BigInt(rawInvoice),
    rail: rawRail === null ? null : ethers.getAddress(rawRail),
    // Default to preflight: the full flow spends C2FLR, so it should be asked for.
    preflight: at("FDC_FULL") === null,
  };
}

function requireEnv(name: string, remedy: string): string {
  const value = process.env[name];
  if (!value) {
    throw new StageError("env", `${name} is not set`, remedy);
  }
  return value;
}

/** Trailing-slash-safe join, because both URL styles appear in Flare's docs. */
function joinUrl(base: string, route: string): string {
  return `${base.replace(/\/+$/, "")}/${route.replace(/^\/+/, "")}`;
}

// ---------------------------------------------------------------------------
// Preflight: everything provable without the verifier key
// ---------------------------------------------------------------------------

type Preflight = {
  chainId: number;
  registry: string;
  fdcHub: string;
  fdcVerification: string;
  feeConfig: string;
  protocolId: number;
  epoch: VotingEpoch;
  currentRound: number;
  deployer: string | null;
  balance: string | null;
};

async function preflight(): Promise<Preflight> {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);

  if (chainId !== 114) {
    throw new StageError(
      "preflight",
      `connected to chain ${chainId}, not Coston2 (114)`,
      "FDC has no local deployment. Run with --network coston2.",
    );
  }

  // A signer needs PRIVATE_KEY, which only stages 3 and 6 actually spend. Preflight
  // is deliberately usable without one, so the FDC wiring can be checked on a
  // machine that holds no key.
  const signers = await ethers.getSigners();
  const deployer = signers[0] ?? null;

  const registry = await ethers.getContractAt(
    "IFlareContractRegistry",
    FLARE_CONTRACT_REGISTRY,
  );

  // Resolve, never hardcode. The recorded addresses are a cross-check only.
  const [fdcHub, fdcVerification, feeConfig] = await Promise.all([
    registry.getContractAddressByName("FdcHub"),
    registry.getContractAddressByName("FdcVerification"),
    registry.getContractAddressByName("FdcRequestFeeConfigurations"),
  ]);

  for (const [name, resolved, recorded] of [
    ["FdcHub", fdcHub, COSTON2_PROTOCOL.FdcHub],
    ["FdcVerification", fdcVerification, COSTON2_PROTOCOL.FdcVerification],
    [
      "FdcRequestFeeConfigurations",
      feeConfig,
      COSTON2_PROTOCOL.FdcRequestFeeConfigurations,
    ],
  ] as const) {
    if ((await ethers.provider.getCode(resolved)) === "0x") {
      throw new StageError(
        "preflight",
        `registry resolved ${name} to ${resolved}, which holds no code`,
        "The FDC deployment has moved or the registry is wrong. Re-run Phase 0 discovery.",
      );
    }
    const drifted = resolved.toLowerCase() !== recorded.toLowerCase();
    console.log(
      `  ${name.padEnd(28)} ${resolved}${drifted ? `  (config records ${recorded})` : ""}`,
    );
  }

  const verification = await ethers.getContractAt("IFdcVerification", fdcVerification);
  const protocolId = Number(await verification.fdcProtocolId());
  if (protocolId !== FDC.protocolId) {
    console.log(
      `  NOTE: live fdcProtocolId() is ${protocolId}, config records ${FDC.protocolId}. ` +
        "The DA layer route is keyed by protocol id; trusting the live value.",
    );
  }

  const epoch = await fetchVotingEpoch(ethers.provider, COSTON2_PROTOCOL.FlareSystemsManager);
  const now = (await ethers.provider.getBlock("latest"))!.timestamp;
  const currentRound = votingRoundIdAt(now, epoch);

  const balance = deployer ? await ethers.provider.getBalance(deployer.address) : 0n;

  console.log(`  ${"FDC protocol id".padEnd(28)} ${protocolId}`);
  console.log(
    `  ${"voting round".padEnd(28)} ${currentRound} ` +
      `(${epoch.votingEpochDurationSeconds}s epochs from ${epoch.firstVotingRoundStartTs})`,
  );

  if (!deployer) {
    console.log(
      `  ${"deployer".padEnd(28)} none (PRIVATE_KEY unset — read-only preflight)`,
    );
  } else {
    console.log(`  ${"deployer".padEnd(28)} ${deployer.address}`);
    console.log(`  ${"balance".padEnd(28)} ${ethers.formatEther(balance)} C2FLR`);
    if (balance === 0n) {
      throw new StageError(
        "preflight",
        "deployer holds no C2FLR",
        "Fund it at https://faucet.flare.network/coston2 — stage 3 pays the request fee.",
      );
    }
  }

  return {
    chainId,
    registry: FLARE_CONTRACT_REGISTRY,
    fdcHub,
    fdcVerification,
    feeConfig,
    protocolId,
    epoch,
    currentRound,
    deployer: deployer?.address ?? null,
    balance: deployer ? ethers.formatEther(balance) : null,
  };
}

/**
 * Read the XRPL transaction straight from a public testnet node.
 *
 * Best-effort: reaching XRPL is not required for any stage, and this is here
 * because the most common way the flow fails is an XRPL payment with no memo or the
 * wrong memo, which is far cheaper to catch before paying a request fee than after
 * waiting a voting round for a proof that will not match the invoice.
 */
async function inspectXrplTransaction(txid: string): Promise<void> {
  const url = process.env.XRPL_TESTNET_RPC_URL ?? "https://s.altnet.rippletest.net:51234/";
  const hash = txid.slice(2).toUpperCase();

  let payload: any;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method: "tx", params: [{ transaction: hash, binary: false }] }),
    });
    payload = await response.json();
  } catch (error) {
    console.log(`  XRPL lookup skipped: ${(error as Error).message}`);
    return;
  }

  const result = payload?.result;
  if (!result || result.status === "error") {
    console.log(
      `  XRPL lookup failed: ${result?.error_message ?? result?.error ?? "unknown error"}`,
    );
    console.log(
      "  If this is txnNotFound, the payment may not be on testnet, or not yet validated.",
    );
    return;
  }

  const tx = result.tx_json ?? result;
  const meta = result.meta ?? result.metaData;
  const delivered = meta?.delivered_amount ?? tx?.Amount;

  console.log(`  XRPL type                    ${tx?.TransactionType}`);
  console.log(`  XRPL from → to               ${tx?.Account} → ${tx?.Destination}`);
  console.log(`  XRPL delivered               ${delivered} drops`);
  console.log(`  XRPL result                  ${meta?.TransactionResult}`);
  console.log(`  XRPL validated               ${result.validated === true}`);

  if (result.validated !== true) {
    console.log(
      "  NOTE: FDC will reject an unvalidated transaction. Wait for validation.",
    );
  }

  // The memo is where standardPaymentReference comes from on XRPL.
  const memoData: string | undefined = tx?.Memos?.[0]?.Memo?.MemoData;
  if (!memoData) {
    console.log(
      "  NOTE: no memo. standardPaymentReference will be zero and the rail will " +
        "reject the proof with ReferenceMismatch.",
    );
  } else if (!/^[0-9a-fA-F]{64}$/.test(memoData)) {
    console.log(
      `  NOTE: memo "${memoData}" is not 32 bytes of hex, so it will not decode to ` +
        "the invoice's paymentRef.",
    );
  } else {
    console.log(`  XRPL payment reference       0x${memoData.toLowerCase()}`);
  }
}

// ---------------------------------------------------------------------------
// Stage 1 — prepare the request
// ---------------------------------------------------------------------------

async function prepareRequest(txid: string): Promise<string> {
  const apiKey = requireEnv(
    "VERIFIER_API_KEY_TESTNET",
    "Request a testnet verifier key from Flare and set it in the repo-root .env. " +
      "Until then, run with --preflight, which covers every stage that does not need it.",
  );
  const baseUrl =
    process.env.COSTON2_VERIFIER_URL_TESTNET ?? "https://fdc-verifiers-testnet.flare.network/";
  const url = joinUrl(baseUrl, FDC.verifierPaymentRoute);

  const body = {
    attestationType: FDC.attestationType.Payment,
    sourceId: FDC.sourceId.testXRP,
    requestBody: { transactionId: txid, inUtxo: "0", utxo: "0" },
  };

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-KEY": apiKey },
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw new StageError(
      "1-prepare",
      `could not reach the verifier at ${url}: ${(error as Error).message}`,
      "Check COSTON2_VERIFIER_URL_TESTNET and network access.",
    );
  }

  if (response.status === 401 || response.status === 403) {
    throw new StageError(
      "1-prepare",
      `verifier rejected the API key (HTTP ${response.status})`,
      "VERIFIER_API_KEY_TESTNET is missing, expired, or not valid for this verifier.",
    );
  }
  if (!response.ok) {
    throw new StageError(
      "1-prepare",
      `verifier returned HTTP ${response.status}: ${await response.text()}`,
      "A 400 usually means the transaction is not a provable XRPL payment.",
    );
  }

  const payload: any = await response.json();
  if (payload.status !== "VALID" || !payload.abiEncodedRequest) {
    throw new StageError(
      "1-prepare",
      `verifier did not return a valid request: ${JSON.stringify(payload)}`,
      "The transaction exists but cannot be attested — check status and confirmations.",
    );
  }

  console.log(`  request  ${payload.abiEncodedRequest.slice(0, 66)}...`);
  return payload.abiEncodedRequest as string;
}

// ---------------------------------------------------------------------------
// Stages 2 and 3 — price it, submit it
// ---------------------------------------------------------------------------

async function submitRequest(
  pre: Preflight,
  abiEncodedRequest: string,
): Promise<{ round: number; txHash: string; fee: bigint }> {
  const feeConfig = new ethers.Contract(pre.feeConfig, FEE_CONFIG_ABI, ethers.provider);

  let fee: bigint;
  try {
    fee = await feeConfig.getRequestFee(abiEncodedRequest);
  } catch (error) {
    throw new StageError(
      "2-fee",
      `getRequestFee reverted: ${(error as Error).message}`,
      "An unpriced attestation type reverts here. Confirm Payment/testXRP is supported.",
    );
  }
  console.log(`  fee      ${ethers.formatEther(fee)} C2FLR`);

  const signers = await ethers.getSigners();
  const signer = signers[0];
  if (!signer) {
    throw new StageError(
      "3-request",
      "no signer available",
      "Set PRIVATE_KEY in the repo-root .env. Stage 3 sends a transaction.",
    );
  }
  const balance = await ethers.provider.getBalance(signer.address);
  if (balance < fee) {
    throw new StageError(
      "3-request",
      `fee is ${ethers.formatEther(fee)} C2FLR but the deployer holds ${ethers.formatEther(balance)}`,
      "Top up at https://faucet.flare.network/coston2.",
    );
  }

  const hub = new ethers.Contract(pre.fdcHub, FDC_HUB_ABI, signer);
  const tx = await hub.requestAttestation(abiEncodedRequest, { value: fee });
  const receipt = await tx.wait();
  if (!receipt) {
    throw new StageError("3-request", "no receipt for the attestation request", "Retry.");
  }

  // The round is determined by the block the request landed in, not by wall clock.
  const block = await ethers.provider.getBlock(receipt.blockNumber);
  const round = votingRoundIdAt(block!.timestamp, pre.epoch);

  console.log(`  tx       ${receipt.hash} (block ${receipt.blockNumber})`);
  console.log(`  round    ${round}`);

  return { round, txHash: receipt.hash, fee };
}

// ---------------------------------------------------------------------------
// Stages 4 and 5 — wait for finalisation, collect the proof
// ---------------------------------------------------------------------------

type CollectedProof = {
  merkleProof: string[];
  data: any;
};

async function collectProof(
  pre: Preflight,
  round: number,
  abiEncodedRequest: string,
): Promise<CollectedProof> {
  const baseUrl =
    process.env.COSTON2_DA_LAYER_URL ?? "https://ctn2-data-availability.flare.network/";
  const url = joinUrl(baseUrl, FDC.daLayerProofRoute);
  const apiKey = process.env.VERIFIER_API_KEY_TESTNET;

  // A proof cannot exist before the round closes and is finalised, so waiting for
  // that boundary before the first request avoids a guaranteed-empty round trip.
  const readyAt = earliestProofTs(round, pre.epoch);
  const nowTs = (await ethers.provider.getBlock("latest"))!.timestamp;
  if (readyAt > nowTs) {
    const waitFor = readyAt - nowTs;
    console.log(
      `  round ${round} closes at ${readyAt}; waiting ${waitFor}s before the first poll`,
    );
    await new Promise((resolve) => setTimeout(resolve, waitFor * 1000));
  }

  const deadline = Date.now() + PROOF_POLL_TIMEOUT * 1000;
  let lastStatus = "";

  while (Date.now() < deadline) {
    let payload: any = null;
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(apiKey ? { "X-API-KEY": apiKey } : {}),
        },
        body: JSON.stringify({ votingRoundId: round, requestBytes: abiEncodedRequest }),
      });
      lastStatus = `HTTP ${response.status}`;
      if (response.ok) payload = await response.json();
    } catch (error) {
      lastStatus = (error as Error).message;
    }

    // Both route shapes appear in Flare's docs: the raw route returns hex to decode,
    // the other returns an already-decoded response object.
    const hex = payload?.response_hex ?? payload?.responseHex;
    if (payload && (hex || payload.response)) {
      const data = hex
        ? ethers.AbiCoder.defaultAbiCoder().decode([IPAYMENT_RESPONSE_ABI], hex)[0]
        : payload.response;

      const merkleProof: string[] = payload.proof ?? payload.merkleProof ?? [];
      if (merkleProof.length === 0) {
        console.log(
          "  NOTE: the DA layer returned an empty Merkle proof. That is valid only " +
            "when the round held a single attestation.",
        );
      }

      console.log(`  proof    ${merkleProof.length} Merkle node(s)`);
      return { merkleProof, data };
    }

    const remaining = Math.round((deadline - Date.now()) / 1000);
    console.log(`  waiting for round ${round} (${lastStatus}), ${remaining}s left`);
    await new Promise((resolve) => setTimeout(resolve, PROOF_POLL_INTERVAL * 1000));
  }

  throw new StageError(
    "5-collect",
    `no proof for round ${round} after ${PROOF_POLL_TIMEOUT}s (last: ${lastStatus})`,
    "Either the round has not finalised, or the request was not included. Check the " +
      `AttestationRequest event and retry with round ${round}.`,
  );
}

// ---------------------------------------------------------------------------
// Stage 6 — redeem against the rail
// ---------------------------------------------------------------------------

async function redeem(
  railAddress: string,
  invoiceId: bigint,
  proof: CollectedProof,
): Promise<string> {
  const rail = await ethers.getContractAt("FluxaFdcPaymentRail", railAddress);

  if (!(await rail.isBound(invoiceId))) {
    throw new StageError(
      "6-redeem",
      `invoice ${invoiceId} is not bound on the rail at ${railAddress}`,
      "The merchant must call bindInvoice(invoiceId, receivingAddressHash, minimumDrops) first.",
    );
  }

  const expectation = await rail.expectationOf(invoiceId);
  const reference = proof.data.responseBody.standardPaymentReference;
  if (reference.toLowerCase() !== expectation.paymentReference.toLowerCase()) {
    throw new StageError(
      "6-redeem",
      `proof reference ${reference} does not match invoice ${invoiceId} ` +
        `(${expectation.paymentReference})`,
      "The XRPL memo must carry the invoice's paymentRef. This proof is for a " +
        "different invoice.",
    );
  }

  const drops = BigInt(proof.data.responseBody.receivedAmount);
  const liquidity = await rail.availableLiquidity();
  if (liquidity < drops) {
    throw new StageError(
      "6-redeem",
      `rail holds ${liquidity} FXRP base units but the invoice needs ${drops}`,
      "Call depositLiquidity to float the rail before redeeming.",
    );
  }

  // The proof is the authorisation, so any account can submit it.
  const tx = await rail.payInvoiceFromXrpl(invoiceId, {
    merkleProof: proof.merkleProof,
    data: proof.data,
  });
  const receipt = await tx.wait();

  console.log(`  paid     invoice ${invoiceId} in ${receipt!.hash}`);
  return receipt!.hash;
}

// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs();

  console.log(`Network   ${network.name}`);
  console.log(`Mode      ${args.preflight ? "preflight (no verifier key needed)" : "full"}\n`);

  console.log("Preflight");
  const pre = await preflight();

  if (args.txid) {
    console.log("\nXRPL transaction");
    await inspectXrplTransaction(args.txid);
  }

  if (args.preflight) {
    const record = {
      network: network.name,
      mode: "preflight",
      ...pre,
      epoch: pre.epoch,
      txid: args.txid,
      blockedOn: process.env.VERIFIER_API_KEY_TESTNET
        ? null
        : "VERIFIER_API_KEY_TESTNET is not set; stages 1-6 not attempted",
    };
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    const outPath = path.join(OUTPUT_DIR, `fdc-preflight.${network.name}.json`);
    fs.writeFileSync(outPath, `${JSON.stringify(record, null, 2)}\n`);

    console.log(`\nPreflight recorded at ${path.relative(process.cwd(), outPath)}`);
    console.log(
      "\nEvery FDC contract resolves, a request can be priced, and the round grid is\n" +
        "correct. Stages 1-6 need VERIFIER_API_KEY_TESTNET; they have not been run.",
    );
    return;
  }

  if (!args.txid) {
    throw new StageError(
      "args",
      "FDC_TXID is required for the full flow",
      "Set FDC_TXID to the XRPL testnet hash of the customer's payment.",
    );
  }
  if (args.invoiceId === null || args.rail === null) {
    throw new StageError(
      "args",
      "FDC_INVOICE and FDC_RAIL are required for the full flow",
      "Set FDC_INVOICE to the invoice id and FDC_RAIL to the deployed rail address.",
    );
  }

  console.log("\nStage 1 — prepare");
  const abiEncodedRequest = await prepareRequest(args.txid);

  console.log("\nStages 2-3 — price and submit");
  const { round, txHash, fee } = await submitRequest(pre, abiEncodedRequest);

  console.log("\nStages 4-5 — wait and collect");
  const proof = await collectProof(pre, round, abiEncodedRequest);

  console.log("\nStage 6 — redeem");
  const payHash = await redeem(args.rail, args.invoiceId, proof);

  const record = {
    network: network.name,
    mode: "full",
    txid: args.txid,
    invoiceId: args.invoiceId.toString(),
    rail: args.rail,
    votingRound: round,
    requestFeeWei: fee.toString(),
    requestTx: txHash,
    paymentTx: payHash,
    merkleProofNodes: proof.merkleProof.length,
    receivedDrops: proof.data.responseBody.receivedAmount.toString(),
    standardPaymentReference: proof.data.responseBody.standardPaymentReference,
  };
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const outPath = path.join(OUTPUT_DIR, `fdc-payment.${network.name}.${round}.json`);
  fs.writeFileSync(outPath, `${JSON.stringify(record, null, 2)}\n`);

  console.log(`\nRecorded at ${path.relative(process.cwd(), outPath)}`);
}

main().catch((error) => {
  if (error instanceof StageError) {
    console.error(`\nFAILED at stage ${error.stage}\n  ${error.message}\n  → ${error.remedy}`);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
});
