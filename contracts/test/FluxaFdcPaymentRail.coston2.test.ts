import { expect } from "chai";
import { ethers } from "hardhat";
import { reset, time } from "@nomicfoundation/hardhat-network-helpers";

import {
  COSTON2_PROTOCOL,
  COSTON2_TOKENS,
  FDC,
  FEED_IDS,
  FLARE_CONTRACT_REGISTRY,
  FLARE_TIMING,
} from "../config/flare";
import {
  describeTimingDrift,
  earliestProofTs,
  fetchVotingEpoch,
  votingRoundIdAt,
  votingRoundStartTs,
  type VotingEpoch,
} from "../config/fdcTiming";
import { FXRP_HOLDERS } from "../config/coston2Holders";
import {
  deployFluxaOnFork,
  enableAsset,
  erc20As,
  erc20At,
  findFundedHolder,
  forkCoston2,
} from "./forkHelpers";

/**
 * Rail B against the live Flare Data Connector — Sprint 3 §7.4.4.
 *
 * §7.4.4 requires FDC integration and explicitly says it is "not simply to mention
 * FDC in the documentation". The offline suite proves the rail's own checks against
 * a mock verifier that answers on command. That mock is the weak point of the
 * offline suite, and this file is what closes it.
 *
 * What is proved here:
 *
 *   1. The Flare Contract Registry resolves `FdcVerification` to the address Phase
 *      0 recorded, and the rail reaches it without that address being compiled in.
 *   2. The live verifier reports FDC protocol id 200 — read from chain, as the
 *      Flare docs instruct, rather than trusted from config.
 *   3. `verifyPayment` exists on this deployment, so the `Payment` attestation type
 *      is genuinely served for XRPL on Coston2.
 *   4. **A fabricated proof cannot move money.** The same proof shape the offline
 *      suite accepts is handed to the real verifier, and the rail refuses it. This
 *      is the assertion that makes the mock trustworthy: it demonstrates the mock
 *      stands in for something that actually verifies.
 *
 * ## What cannot be proved here, and why
 *
 * A *successful* Rail B payment cannot be demonstrated without a real attested
 * XRPL transaction, and obtaining one requires:
 *
 *   - an XRPL testnet payment carrying the invoice's `standardPaymentReference`;
 *   - a `prepareRequest` call to Flare's verifier, which needs
 *     `VERIFIER_API_KEY_TESTNET` — without it the verifier returns HTTP 401;
 *   - `FdcHub.requestAttestation` with the request fee;
 *   - a wait of at least one 90-second voting round;
 *   - a proof fetched from the DA layer.
 *
 * The key is not present in this repository — recorded as an open dependency in
 * docs/PHASE-0-FLARE-VALIDATION.md §6. `scripts/fdcRequestProof.ts` implements the
 * whole flow and fails with a specific message at whichever stage is blocked, so
 * the gap is a missing credential rather than missing code.
 *
 * Being precise about the boundary: this suite proves Fluxa is wired to the real
 * FDC and rejects invalid proofs. It does not prove a valid proof is accepted,
 * because no valid proof can be produced here.
 */
describe("FluxaFdcPaymentRail against live FDC on forked Coston2", () => {
  const MAX_PRICE_AGE = 300n;
  const FXRP = ethers.getAddress(COSTON2_TOKENS.FXRP.address);

  const MERCHANT_XRPL = ethers.keccak256(ethers.toUtf8Bytes("rMerchantTestAccount"));
  const CUSTOMER_XRPL = ethers.keccak256(ethers.toUtf8Bytes("rCustomerTestAccount"));

  /** 500 FXRP, and the same figure in drops. */
  const INVOICE_AMOUNT = 500_000_000n;

  let available = false;
  let skipReason = "";

  /** Voting-round grid, read from chain once. See config/fdcTiming.ts. */
  let epoch: VotingEpoch;

  before(async function () {
    this.timeout(180_000);

    const status = await forkCoston2();
    available = status.available;
    if (!status.available) {
      skipReason = status.reason;
      return;
    }
    console.log(`      forked Coston2 at block ${status.block}`);

    epoch = await fetchVotingEpoch(ethers.provider);
  });

  after(async () => {
    await reset();
  });

  beforeEach(function () {
    if (!available) {
      console.log(`      skipped: ${skipReason}`);
      this.skip();
    }
  });

  /** Deploy Fluxa plus the rail, with FXRP enabled and the rail floated. */
  async function deployWithRail() {
    const contracts = await deployFluxaOnFork(MAX_PRICE_AGE);
    await enableAsset(contracts, FXRP, FEED_IDS["XRP/USD"]);

    const rail = await (
      await ethers.getContractFactory("FluxaFdcPaymentRail")
    ).deploy(
      contracts.deployer.address,
      FLARE_CONTRACT_REGISTRY,
      await contracts.invoice.getAddress(),
      FXRP,
    );
    await rail.waitForDeployment();

    return { ...contracts, rail };
  }

  /** A structurally valid Payment proof for a transaction that was never attested. */
  function fabricatedProof(overrides: {
    paymentReference: string;
    blockTimestamp: bigint;
    votingRound: bigint;
    transactionId?: string;
  }) {
    return {
      merkleProof: [] as string[],
      data: {
        attestationType: FDC.attestationType.Payment,
        sourceId: FDC.sourceId.testXRP,
        votingRound: overrides.votingRound,
        lowestUsedTimestamp: overrides.blockTimestamp,
        requestBody: {
          transactionId: overrides.transactionId ?? "0x" + "ab".repeat(32),
          inUtxo: 0n,
          utxo: 0n,
        },
        responseBody: {
          blockNumber: 4_242_424n,
          blockTimestamp: overrides.blockTimestamp,
          sourceAddressHash: CUSTOMER_XRPL,
          sourceAddressesRoot: ethers.ZeroHash,
          receivingAddressHash: MERCHANT_XRPL,
          intendedReceivingAddressHash: MERCHANT_XRPL,
          spentAmount: INVOICE_AMOUNT + 12n,
          intendedSpentAmount: INVOICE_AMOUNT + 12n,
          receivedAmount: INVOICE_AMOUNT,
          intendedReceivedAmount: INVOICE_AMOUNT,
          standardPaymentReference: overrides.paymentReference,
          oneToOne: true,
          status: 0n,
        },
      },
    };
  }

  // -------------------------------------------------------------------
  // Reaching the real FDC
  // -------------------------------------------------------------------

  it("resolves the live FdcVerification through the registry", async () => {
    const { rail } = await deployWithRail();

    const resolved = await rail.fdcVerificationAddress();
    expect(resolved).to.equal(
      ethers.getAddress(COSTON2_PROTOCOL.FdcVerification),
      "registry resolves a different FdcVerification than Phase 0 recorded",
    );
    expect(await ethers.provider.getCode(resolved)).to.not.equal("0x");

    // The rail was given the canonical registry and nothing else. That the verifier
    // address is reachable at all is the integration working.
    expect(await rail.registry()).to.equal(FLARE_CONTRACT_REGISTRY);
    expect(await rail.CANONICAL_FLARE_REGISTRY()).to.equal(FLARE_CONTRACT_REGISTRY);

    console.log(`      FdcVerification ${resolved}`);
  });

  it("reads FDC protocol id 200 off the live verifier", async () => {
    // Config records 200 for reference; the docs say read it. This is the read.
    const { rail } = await deployWithRail();

    const protocolId = await rail.fdcProtocolId();
    expect(protocolId).to.equal(FDC.protocolId);

    console.log(`      live fdcProtocolId() = ${protocolId}`);
  });

  it("finds a live Relay behind the verifier, which is what holds the Merkle roots", async () => {
    // verifyPayment checks a proof against the voting round's Merkle root, and the
    // Relay is where those roots live. If the Relay were unreachable, verification
    // could not be doing anything.
    const { rail } = await deployWithRail();

    const verifier = await ethers.getContractAt(
      [
        "function relay() view returns (address)",
        "function fdcProtocolId() view returns (uint8)",
      ],
      await rail.fdcVerificationAddress(),
    );

    const relay = await verifier.relay();
    expect(relay).to.equal(ethers.getAddress(COSTON2_PROTOCOL.Relay));
    expect(await ethers.provider.getCode(relay)).to.not.equal("0x");

    console.log(`      Relay ${relay}`);
  });

  it("serves the Payment attestation type — verifyPayment exists and answers", async () => {
    // A selector that is not implemented reverts. Getting a clean `false` back is
    // what proves the type is served, and that the rail is calling something real.
    const { rail } = await deployWithRail();

    const verifier = await ethers.getContractAt(
      "IFdcVerification",
      await rail.fdcVerificationAddress(),
    );

    const latest = BigInt(await time.latest());
    const proof = fabricatedProof({
      paymentReference: ethers.keccak256(ethers.toUtf8Bytes("never-attested")),
      blockTimestamp: latest,
      votingRound: BigInt(votingRoundIdAt(Number(latest), epoch)),
    });

    const proved = await verifier.verifyPayment(proof);
    expect(proved).to.equal(false, "the live verifier accepted a fabricated proof");

    console.log(`      live verifyPayment(fabricated) = ${proved}`);
  });

  // -------------------------------------------------------------------
  // The claim that matters: a fabricated proof cannot move money
  // -------------------------------------------------------------------

  it("refuses a fabricated proof the mock verifier would have accepted", async () => {
    // Same proof shape the offline suite pays an invoice with. Against the real
    // verifier it buys nothing. This is what makes the mocked suite honest rather
    // than circular.
    const { rail, invoice, merchant, deployer } = await deployWithRail();

    // Float the rail with real FXRP, so the refusal cannot be mistaken for the rail
    // simply having no money.
    const fxrp = erc20At(FXRP);
    const { signer: whale } = await findFundedHolder(FXRP, FXRP_HOLDERS, 1_000_000_000n);
    await (
      await erc20As(FXRP, whale).transfer(await rail.getAddress(), INVOICE_AMOUNT)
    ).wait();
    expect(await rail.availableLiquidity()).to.equal(INVOICE_AMOUNT);

    const paymentRef = ethers.keccak256(ethers.toUtf8Bytes("fluxa-rail-b-fork"));
    const dueAt = (await time.latest()) + 7 * 24 * 60 * 60;

    await (
      await invoice.connect(merchant).createInvoice(FXRP, INVOICE_AMOUNT, dueAt, paymentRef)
    ).wait();
    await (
      await rail.connect(merchant).bindInvoice(1n, MERCHANT_XRPL, INVOICE_AMOUNT)
    ).wait();

    // Everything about the invoice side is correct — bound, funded, in date. The
    // only thing missing is a real attestation.
    expect(await rail.isBound(1n)).to.equal(true);
    expect(await invoice.isPayable(1n)).to.equal(true);

    const latest = BigInt(await time.latest());
    const proof = fabricatedProof({
      paymentReference: paymentRef,
      blockTimestamp: latest,
      votingRound: BigInt(votingRoundIdAt(Number(latest), epoch)),
    });

    await expect(rail.connect(deployer).payInvoiceFromXrpl(1n, proof))
      .to.be.revertedWithCustomError(rail, "ProofRejected")
      .withArgs(proof.data.requestBody.transactionId);

    // Nothing moved.
    expect(await invoice.isPayable(1n)).to.equal(true);
    expect(await rail.availableLiquidity()).to.equal(INVOICE_AMOUNT);
    expect(await fxrp.balanceOf(await invoice.getAddress())).to.equal(0n);
    expect(await rail.transactionUsed(proof.data.requestBody.transactionId)).to.equal(false);

    console.log("      fabricated proof rejected; escrow and float untouched");
  });

  it("rejects the wrong attestation type before it ever reaches the verifier", async () => {
    // Ordering matters: the type and source checks are local, so a proof about
    // another chain is refused without spending a call on the verifier.
    const { rail, invoice, merchant } = await deployWithRail();

    const paymentRef = ethers.keccak256(ethers.toUtf8Bytes("fluxa-rail-b-wrong-type"));
    const dueAt = (await time.latest()) + 7 * 24 * 60 * 60;
    await (
      await invoice.connect(merchant).createInvoice(FXRP, INVOICE_AMOUNT, dueAt, paymentRef)
    ).wait();
    await (
      await rail.connect(merchant).bindInvoice(1n, MERCHANT_XRPL, INVOICE_AMOUNT)
    ).wait();

    const latest = BigInt(await time.latest());
    const proof = fabricatedProof({
      paymentReference: paymentRef,
      blockTimestamp: latest,
      votingRound: BigInt(votingRoundIdAt(Number(latest), epoch)),
    });

    const wrongType = {
      ...proof,
      data: { ...proof.data, attestationType: FDC.attestationType.ReferencedPaymentNonexistence },
    };

    await expect(rail.payInvoiceFromXrpl(1n, wrongType))
      .to.be.revertedWithCustomError(rail, "UnexpectedAttestationType")
      .withArgs(FDC.attestationType.ReferencedPaymentNonexistence, FDC.attestationType.Payment);
  });

  // -------------------------------------------------------------------
  // Round arithmetic, checked against the live protocol
  // -------------------------------------------------------------------

  it("derives voting rounds from timing read off the live FlareSystemsManager", async () => {
    // The off-chain script computes which round contains a payment's timestamp in
    // order to fetch the proof. Get the grid wrong and the arithmetic still
    // succeeds — it just names a round the DA layer has no proof for, and the
    // failure is indistinguishable from an unconfirmed attestation.
    //
    // This test is why config/fdcTiming.ts reads the grid from chain: it found the
    // recorded constant to be wrong. See the drift assertion at the end.
    const registry = await ethers.getContractAt(
      "IFlareContractRegistry",
      FLARE_CONTRACT_REGISTRY,
    );

    // The registry is the authority on where the manager lives; the recorded
    // address is only a fallback for scripts, so confirm they still agree.
    const managerAddress = await registry.getContractAddressByName("FlareSystemsManager");
    expect(managerAddress).to.equal(
      ethers.getAddress(COSTON2_PROTOCOL.FlareSystemsManager),
    );

    const epoch = await fetchVotingEpoch(ethers.provider, managerAddress);
    expect(epoch.votingEpochDurationSeconds).to.equal(90);
    expect(epoch.firstVotingRoundStartTs).to.be.greaterThan(0);

    // Round derivation lands on a plausible current round, and the round's own
    // start time contains the timestamp it was derived from.
    const now = await time.latest();
    const round = votingRoundIdAt(now, epoch);

    expect(round).to.be.greaterThan(0);
    expect(votingRoundStartTs(round, epoch)).to.be.at.most(now);
    expect(votingRoundStartTs(round + 1, epoch)).to.be.greaterThan(now);

    // A proof cannot exist before the round has closed and been finalised.
    expect(earliestProofTs(round, epoch)).to.be.greaterThan(now);

    console.log(
      `      round ${round}, ${epoch.votingEpochDurationSeconds}s epochs from ` +
        `ts ${epoch.firstVotingRoundStartTs}`,
    );

    // The finding this test exists to surface. Sprint 1's constant is 512s stale —
    // 5.7 rounds — which is exactly the silent-wrong-round failure described above.
    // Reported rather than asserted-equal, because Sprint 3 no longer reads it and
    // the constant is Sprint 1's to correct.
    const drift = describeTimingDrift(epoch);
    if (drift) console.log(`      NOTE: ${drift}`);

    expect(epoch.firstVotingRoundStartTs).to.not.equal(
      FLARE_TIMING.firstVotingRoundStartTs,
      "FLARE_TIMING now matches the chain — Sprint 3 can drop the chain read, and " +
        "this assertion should be inverted to lock the constant in",
    );
  });

  it("finds a live FdcHub and fee configuration, so a request could be submitted", async () => {
    // The rail only verifies proofs; requesting an attestation happens off-chain
    // through FdcHub. Proving those contracts are live and priced is what shows the
    // blocked step is a missing API key rather than a missing integration.
    const registry = await ethers.getContractAt(
      "IFlareContractRegistry",
      FLARE_CONTRACT_REGISTRY,
    );

    const hub = await registry.getContractAddressByName("FdcHub");
    const feeConfig = await registry.getContractAddressByName("FdcRequestFeeConfigurations");

    expect(hub).to.equal(ethers.getAddress(COSTON2_PROTOCOL.FdcHub));
    expect(feeConfig).to.equal(
      ethers.getAddress(COSTON2_PROTOCOL.FdcRequestFeeConfigurations),
    );
    expect(await ethers.provider.getCode(hub)).to.not.equal("0x");
    expect(await ethers.provider.getCode(feeConfig)).to.not.equal("0x");

    console.log(`      FdcHub ${hub}`);
    console.log(`      FdcRequestFeeConfigurations ${feeConfig}`);
  });
});
