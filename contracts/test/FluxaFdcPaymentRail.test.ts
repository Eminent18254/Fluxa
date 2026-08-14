import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

import {
  AMOUNT,
  MINT,
  ONE_WEEK,
  Rail,
  REF_A,
  REF_B,
  Status,
  TOKEN_DECIMALS,
  weekFromNow,
} from "./fixtures";

/**
 * Rail B — FDC-verified cross-chain payment. Sprint 3 §7.4.4.
 *
 * §7.4.4 asks for FDC to be integrated and "not simply to mention FDC in the
 * documentation". This suite covers the half of that claim which can be proved
 * offline: that `FluxaFdcPaymentRail` interrogates an attestation properly and
 * refuses every malformed one.
 *
 * The other half — that the *real* verifier performs real Merkle verification, and
 * that Fluxa reads the live FdcVerification the registry names — is in
 * `FluxaFdcPaymentRail.coston2.test.ts`. Neither suite is sufficient alone: a
 * mocked verifier that always says yes proves nothing about proofs, and the live
 * verifier cannot be made to say yes without an attested XRPL transaction, which
 * needs a verifier API key this project does not have.
 *
 * The split is deliberate and the boundary is worth stating: **these tests prove
 * Fluxa's logic, not Flare's cryptography.**
 */

// ---------------------------------------------------------------------------
// Proof construction
// ---------------------------------------------------------------------------

/** Standard address hashes, as FDC reports XRPL accounts. */
const MERCHANT_XRPL = ethers.keccak256(ethers.toUtf8Bytes("rMerchantTestAccount"));
const CUSTOMER_XRPL = ethers.keccak256(ethers.toUtf8Bytes("rCustomerTestAccount"));
const STRANGER_XRPL = ethers.keccak256(ethers.toUtf8Bytes("rSomebodyElseEntirely"));

const TXID = "0x" + "11".repeat(32);
const OTHER_TXID = "0x" + "22".repeat(32);

/** Attestation type `Payment` and source `testXRP`, right-padded ASCII. */
const TYPE_PAYMENT = "0x5061796d656e7400000000000000000000000000000000000000000000000000";
const TYPE_BALANCE_DECREASING =
  "0x42616c616e636544656372656173696e675472616e73616374696f6e00000000";
const SOURCE_TEST_XRP = "0x7465737458525000000000000000000000000000000000000000000000000000";
const SOURCE_TEST_BTC = "0x7465737442544300000000000000000000000000000000000000000000000000";

/**
 * 100 XRP in drops.
 *
 * Identical to AMOUNT, which is 100.000000 FXRP in base units — and that identity
 * is the whole reason the rail can compare the two. One drop is 1e-6 XRP and FXRP
 * carries 6 decimals, so the numbers are the same quantity of value.
 */
const DROPS = 100_000_000n;

type ProofOverrides = {
  attestationType?: string;
  sourceId?: string;
  votingRound?: bigint;
  transactionId?: string;
  blockTimestamp?: bigint;
  receivingAddressHash?: string;
  sourceAddressHash?: string;
  receivedAmount?: bigint;
  standardPaymentReference?: string;
  status?: bigint;
};

/**
 * Build a well-formed `IPayment.Proof` that the rail should accept, with any field
 * overridable.
 *
 * `merkleProof` is empty because the mock verifier ignores it. That is not a
 * shortcut being hidden — it is the precise reason the fork suite exists.
 */
function buildProof(overrides: ProofOverrides = {}) {
  return {
    merkleProof: [] as string[],
    data: {
      attestationType: overrides.attestationType ?? TYPE_PAYMENT,
      sourceId: overrides.sourceId ?? SOURCE_TEST_XRP,
      votingRound: overrides.votingRound ?? 987_654n,
      lowestUsedTimestamp: overrides.blockTimestamp ?? 0n,
      requestBody: {
        transactionId: overrides.transactionId ?? TXID,
        inUtxo: 0n, // always 0 for non-UTXO chains
        utxo: 0n,
      },
      responseBody: {
        blockNumber: 4_242_424n,
        blockTimestamp: overrides.blockTimestamp ?? 0n,
        sourceAddressHash: overrides.sourceAddressHash ?? CUSTOMER_XRPL,
        sourceAddressesRoot: ethers.ZeroHash,
        receivingAddressHash: overrides.receivingAddressHash ?? MERCHANT_XRPL,
        intendedReceivingAddressHash: overrides.receivingAddressHash ?? MERCHANT_XRPL,
        spentAmount: (overrides.receivedAmount ?? DROPS) + 12n, // + XRPL network fee
        intendedSpentAmount: (overrides.receivedAmount ?? DROPS) + 12n,
        receivedAmount: overrides.receivedAmount ?? DROPS,
        intendedReceivedAmount: overrides.receivedAmount ?? DROPS,
        standardPaymentReference: overrides.standardPaymentReference ?? REF_A,
        oneToOne: true,
        status: overrides.status ?? 0n, // 0 = success
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

async function deployRailFixture() {
  const [owner, merchant, customer, other] = await ethers.getSigners();

  const MockERC20 = await ethers.getContractFactory("MockERC20");
  const fxrp = await MockERC20.deploy("Fluxa FXRP", "FXRP", TOKEN_DECIMALS);
  const usdt = await MockERC20.deploy("Fluxa USDT0", "USDT0", TOKEN_DECIMALS);

  const FluxaInvoice = await ethers.getContractFactory("FluxaInvoice");
  const invoice = await FluxaInvoice.deploy(owner.address);

  const FluxaSettlement = await ethers.getContractFactory("FluxaSettlement");
  const settlement = await FluxaSettlement.deploy(owner.address, await invoice.getAddress());

  const MockPriceOracle = await ethers.getContractFactory("MockPriceOracle");
  const oracle = await MockPriceOracle.deploy();

  const MockFdcVerification = await ethers.getContractFactory("MockFdcVerification");
  const verifier = await MockFdcVerification.deploy();

  const MockContractRegistry = await ethers.getContractFactory("MockContractRegistry");
  const registry = await MockContractRegistry.deploy();
  await registry.setAddress("FdcVerification", await verifier.getAddress());

  const FluxaFdcPaymentRail = await ethers.getContractFactory("FluxaFdcPaymentRail");
  const rail = await FluxaFdcPaymentRail.deploy(
    owner.address,
    await registry.getAddress(),
    await invoice.getAddress(),
    await fxrp.getAddress(),
  );

  await invoice.setAcceptedToken(await fxrp.getAddress(), true);
  await invoice.setAcceptedToken(await usdt.getAddress(), true);
  await invoice.setSettlementContract(await settlement.getAddress());
  await settlement.setPriceOracle(await oracle.getAddress());
  await oracle.setPrice(await fxrp.getAddress(), 1_000_000n, 6, await time.latest());

  // Float the rail. In production the operator funds this from the XRP they were
  // paid on XRPL; here it is simply minted.
  await fxrp.mint(owner.address, MINT);
  await fxrp.connect(owner).approve(await rail.getAddress(), MINT);
  await rail.connect(owner).depositLiquidity(MINT / 2n);

  // A funded customer, so a Rail A comparison is available in the same fixture.
  await fxrp.mint(customer.address, MINT);
  await fxrp.connect(customer).approve(await invoice.getAddress(), MINT);

  const dueAt = await weekFromNow();
  await invoice
    .connect(merchant)
    .createInvoice(await fxrp.getAddress(), AMOUNT, dueAt, REF_A);

  return {
    owner,
    merchant,
    customer,
    other,
    fxrp,
    usdt,
    invoice,
    settlement,
    oracle,
    verifier,
    registry,
    rail,
    invoiceId: 1n,
    dueAt,
  };
}

/** Fixture with invoice 1 already bound to the merchant's XRPL account. */
async function boundFixture() {
  const base = await deployRailFixture();
  await base.rail.connect(base.merchant).bindInvoice(base.invoiceId, MERCHANT_XRPL, DROPS);
  return base;
}

// ---------------------------------------------------------------------------

describe("FluxaFdcPaymentRail", () => {
  describe("deployment", () => {
    it("records the registry, invoice contract and FAsset it fronts", async () => {
      const { rail, invoice, fxrp, registry, owner } = await loadFixture(deployRailFixture);

      expect(await rail.registry()).to.equal(await registry.getAddress());
      expect(await rail.fluxaInvoice()).to.equal(await invoice.getAddress());
      expect(await rail.fxrp()).to.equal(await fxrp.getAddress());
      expect(await rail.owner()).to.equal(owner.address);
    });

    it("rejects zero addresses for every dependency", async () => {
      const { owner, registry, invoice, fxrp } = await loadFixture(deployRailFixture);
      const Rail_ = await ethers.getContractFactory("FluxaFdcPaymentRail");

      const registryAddress = await registry.getAddress();
      const invoiceAddress = await invoice.getAddress();
      const fxrpAddress = await fxrp.getAddress();

      await expect(
        Rail_.deploy(owner.address, ethers.ZeroAddress, invoiceAddress, fxrpAddress),
      ).to.be.revertedWithCustomError(Rail_, "ZeroAddress");
      await expect(
        Rail_.deploy(owner.address, registryAddress, ethers.ZeroAddress, fxrpAddress),
      ).to.be.revertedWithCustomError(Rail_, "ZeroAddress");
      await expect(
        Rail_.deploy(owner.address, registryAddress, invoiceAddress, ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(Rail_, "ZeroAddress");
    });

    it("resolves FdcVerification through the registry rather than storing it", async () => {
      // The address is looked up per call, so repointing the registry repoints the
      // rail. This is what stops a protocol upgrade stranding the contract.
      const { rail, registry, verifier } = await loadFixture(deployRailFixture);

      expect(await rail.fdcVerificationAddress()).to.equal(await verifier.getAddress());
      expect(await rail.fdcProtocolId()).to.equal(200);

      const replacement = await (
        await ethers.getContractFactory("MockFdcVerification")
      ).deploy();
      await replacement.setProtocolId(201);
      await registry.setAddress("FdcVerification", await replacement.getAddress());

      expect(await rail.fdcVerificationAddress()).to.equal(await replacement.getAddress());
      expect(await rail.fdcProtocolId()).to.equal(201);
    });

    it("reverts with the key when the registry cannot resolve FdcVerification", async () => {
      const { rail, registry } = await loadFixture(deployRailFixture);
      await registry.setAddress("FdcVerification", ethers.ZeroAddress);

      const key = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(["string"], ["FdcVerification"]),
      );
      await expect(rail.fdcVerificationAddress())
        .to.be.revertedWithCustomError(rail, "RegistryLookupFailed")
        .withArgs(key);
    });

    it("agrees with the canonical registry address recorded on-chain", async () => {
      const { rail } = await loadFixture(deployRailFixture);
      expect(await rail.CANONICAL_FLARE_REGISTRY()).to.equal(
        "0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019",
      );
    });
  });

  // -------------------------------------------------------------------------

  describe("bindInvoice", () => {
    it("binds an invoice and takes the payment reference from the invoice", async () => {
      // The reference is not a parameter. FluxaInvoice already enforces global
      // uniqueness of paymentRef, so reading it here means one reference can never
      // be bound to two invoices — a guarantee that would be lost if the caller
      // supplied it.
      const { rail, merchant, invoiceId } = await loadFixture(deployRailFixture);

      await expect(rail.connect(merchant).bindInvoice(invoiceId, MERCHANT_XRPL, DROPS))
        .to.emit(rail, "InvoiceBound")
        .withArgs(invoiceId, merchant.address, MERCHANT_XRPL, REF_A, DROPS);

      expect(await rail.isBound(invoiceId)).to.equal(true);

      const expectation = await rail.expectationOf(invoiceId);
      expect(expectation.receivingAddressHash).to.equal(MERCHANT_XRPL);
      expect(expectation.paymentReference).to.equal(REF_A);
      expect(expectation.minimumDrops).to.equal(DROPS);
      expect(expectation.bound).to.equal(true);
    });

    it("refuses anyone but the invoice's merchant", async () => {
      // The XRPL account being credited is the merchant's to name. Letting a third
      // party bind would let them redirect the payment instructions.
      const { rail, customer, merchant, invoiceId } = await loadFixture(deployRailFixture);

      await expect(rail.connect(customer).bindInvoice(invoiceId, MERCHANT_XRPL, DROPS))
        .to.be.revertedWithCustomError(rail, "NotInvoiceMerchant")
        .withArgs(customer.address, merchant.address);
    });

    it("refuses an invoice that does not exist", async () => {
      const { rail, merchant } = await loadFixture(deployRailFixture);

      await expect(rail.connect(merchant).bindInvoice(999n, MERCHANT_XRPL, DROPS))
        .to.be.revertedWithCustomError(rail, "InvoiceNotFound")
        .withArgs(999n);
    });

    it("refuses a zero receiving address hash", async () => {
      const { rail, merchant, invoiceId } = await loadFixture(deployRailFixture);

      await expect(
        rail.connect(merchant).bindInvoice(invoiceId, ethers.ZeroHash, DROPS),
      ).to.be.revertedWithCustomError(rail, "ZeroReceivingAddressHash");
    });

    it("refuses an invoice with no payment reference", async () => {
      // An invoice created with a zero ref has nothing for the XRPL payment to
      // carry, so there is no way to tie a payment to it.
      const { rail, invoice, merchant, fxrp } = await loadFixture(deployRailFixture);

      await invoice
        .connect(merchant)
        .createInvoice(await fxrp.getAddress(), AMOUNT, await weekFromNow(), ethers.ZeroHash);

      await expect(rail.connect(merchant).bindInvoice(2n, MERCHANT_XRPL, DROPS))
        .to.be.revertedWithCustomError(rail, "MissingPaymentReference")
        .withArgs(2n);
    });

    it("refuses a commitment below the amount the rail would front", async () => {
      // The solvency condition. The rail hands over `invoice.amount` FXRP and is
      // repaid `minimumDrops` of XRP; below parity the operator is subsidising the
      // payment, so the floor is enforced rather than configured.
      const { rail, merchant, invoiceId } = await loadFixture(deployRailFixture);

      await expect(rail.connect(merchant).bindInvoice(invoiceId, MERCHANT_XRPL, AMOUNT - 1n))
        .to.be.revertedWithCustomError(rail, "InsufficientCommitment")
        .withArgs(AMOUNT - 1n, AMOUNT);

      // Parity is fine, and so is asking for more.
      await expect(rail.connect(merchant).bindInvoice(invoiceId, MERCHANT_XRPL, AMOUNT)).to.not
        .be.reverted;
    });

    it("refuses to rebind", async () => {
      // Rebinding would let a merchant redirect an invoice to a different XRPL
      // account after a customer had been shown payment instructions.
      const { rail, merchant, invoiceId } = await loadFixture(boundFixture);

      await expect(rail.connect(merchant).bindInvoice(invoiceId, STRANGER_XRPL, DROPS))
        .to.be.revertedWithCustomError(rail, "AlreadyBound")
        .withArgs(invoiceId);
    });

    it("refuses an invoice payable in anything but the FAsset it fronts", async () => {
      const { rail, invoice, merchant, usdt, fxrp } = await loadFixture(deployRailFixture);

      await invoice
        .connect(merchant)
        .createInvoice(await usdt.getAddress(), AMOUNT, await weekFromNow(), REF_B);

      await expect(rail.connect(merchant).bindInvoice(2n, MERCHANT_XRPL, DROPS))
        .to.be.revertedWithCustomError(rail, "UnsupportedPayToken")
        .withArgs(await usdt.getAddress(), await fxrp.getAddress());
    });

    it("refuses an invoice that is no longer open", async () => {
      const { rail, invoice, merchant, customer, invoiceId } =
        await loadFixture(deployRailFixture);

      await invoice.connect(customer).payInvoice(invoiceId);

      await expect(rail.connect(merchant).bindInvoice(invoiceId, MERCHANT_XRPL, DROPS))
        .to.be.revertedWithCustomError(rail, "InvoiceNotOpen")
        .withArgs(invoiceId, Status.PAID);
    });

    it("refuses a FAsset that is not 6-decimal", async () => {
      // The drops-to-base-units equivalence only holds at 6 decimals. An 18-decimal
      // token would make `minimumDrops >= invoice.amount` compare incompatible
      // units, and the rail would front 10^12 times what it was paid.
      const { owner, registry, invoice, merchant } = await loadFixture(deployRailFixture);

      const wrong = await (
        await ethers.getContractFactory("MockERC20")
      ).deploy("Eighteen", "E18", 18);

      const rail18 = await (
        await ethers.getContractFactory("FluxaFdcPaymentRail")
      ).deploy(
        owner.address,
        await registry.getAddress(),
        await invoice.getAddress(),
        await wrong.getAddress(),
      );

      await invoice.setAcceptedToken(await wrong.getAddress(), true);
      await invoice
        .connect(merchant)
        .createInvoice(await wrong.getAddress(), AMOUNT, await weekFromNow(), REF_B);

      await expect(rail18.connect(merchant).bindInvoice(2n, MERCHANT_XRPL, DROPS))
        .to.be.revertedWithCustomError(rail18, "UnexpectedAssetDecimals")
        .withArgs(18, 6);
    });

    it("cannot be called while paused", async () => {
      const { rail, owner, merchant, invoiceId } = await loadFixture(deployRailFixture);
      await rail.connect(owner).pause();

      await expect(
        rail.connect(merchant).bindInvoice(invoiceId, MERCHANT_XRPL, DROPS),
      ).to.be.revertedWithCustomError(rail, "EnforcedPause");
    });
  });

  // -------------------------------------------------------------------------

  describe("payInvoiceFromXrpl", () => {
    it("pays the invoice from a proven XRPL payment", async () => {
      const { rail, invoice, fxrp, invoiceId } = await loadFixture(boundFixture);

      const railBefore = await fxrp.balanceOf(await rail.getAddress());
      const proof = buildProof({ blockTimestamp: BigInt(await time.latest()) });

      await expect(rail.payInvoiceFromXrpl(invoiceId, proof))
        .to.emit(rail, "XrplPaymentAccepted")
        .withArgs(invoiceId, TXID, CUSTOMER_XRPL, DROPS, AMOUNT, 987_654n)
        .and.to.emit(invoice, "InvoicePaid");

      // The rail's own float paid for it.
      expect(await fxrp.balanceOf(await rail.getAddress())).to.equal(railBefore - AMOUNT);
      expect(await fxrp.balanceOf(await invoice.getAddress())).to.equal(AMOUNT);

      const stored = await invoice.getInvoice(invoiceId);
      expect(stored.status).to.equal(Status.PAID);
      expect(stored.amountPaid).to.equal(AMOUNT);
      expect(await invoice.escrowOf(invoiceId)).to.equal(AMOUNT);
    });

    it("is permissionless — the proof is the authorisation", async () => {
      // A privileged submitter would let an offline operator hold a paid invoice
      // hostage, and would put a trusted party back into a flow whose point is not
      // needing one.
      const { rail, invoice, other, invoiceId } = await loadFixture(boundFixture);

      await rail
        .connect(other)
        .payInvoiceFromXrpl(invoiceId, buildProof({ blockTimestamp: BigInt(await time.latest()) }));

      expect((await invoice.getInvoice(invoiceId)).status).to.equal(Status.PAID);
    });

    it("records the XRPL provenance the invoice itself cannot hold", async () => {
      // The documented cost of not modifying Sprint 2: FluxaInvoice sees an ordinary
      // ERC-20 payment from this contract, so `payer` is the rail and `rail` is
      // FLARE_ERC20 even though a customer paid native XRP on the XRP Ledger.
      // Asserted rather than glossed over, and the real provenance is recorded here.
      const { rail, invoice, invoiceId } = await loadFixture(boundFixture);

      const paidAt = BigInt(await time.latest());
      await rail.payInvoiceFromXrpl(invoiceId, buildProof({ blockTimestamp: paidAt }));

      const stored = await invoice.getInvoice(invoiceId);
      expect(stored.payer).to.equal(await rail.getAddress());
      expect(stored.rail).to.equal(Rail.FLARE_ERC20);

      const record = await rail.recordOf(invoiceId);
      expect(record.transactionId).to.equal(TXID);
      expect(record.sourceAddressHash).to.equal(CUSTOMER_XRPL);
      expect(record.dropsReceived).to.equal(DROPS);
      expect(record.fxrpFronted).to.equal(AMOUNT);
      expect(record.votingRound).to.equal(987_654n);
      expect(record.xrplBlockTimestamp).to.equal(paidAt);
      expect(record.xrplBlockNumber).to.equal(4_242_424n);
    });

    it("leaves the escrow and settlement path completely untouched", async () => {
      // The point of fronting liquidity instead of adding a privileged mark-paid
      // hook: settlement neither knows nor cares that this was a cross-chain
      // payment. If this passes, Sprint 2 did not need to change.
      const { rail, invoice, settlement, fxrp, merchant, invoiceId } =
        await loadFixture(boundFixture);

      await rail.payInvoiceFromXrpl(
        invoiceId,
        buildProof({ blockTimestamp: BigInt(await time.latest()) }),
      );

      const merchantBefore = await fxrp.balanceOf(merchant.address);

      await expect(settlement.settleInvoice(invoiceId))
        .to.emit(settlement, "InvoiceSettled")
        .withArgs(invoiceId, merchant.address, merchant.address, await fxrp.getAddress(), AMOUNT);

      expect(await fxrp.balanceOf(merchant.address)).to.equal(merchantBefore + AMOUNT);
      expect((await invoice.getInvoice(invoiceId)).status).to.equal(Status.SETTLED);
      expect(await fxrp.balanceOf(await invoice.getAddress())).to.equal(0n);
    });

    it("refuses an invoice that was never bound", async () => {
      const { rail, invoice, merchant, fxrp } = await loadFixture(deployRailFixture);

      await invoice
        .connect(merchant)
        .createInvoice(await fxrp.getAddress(), AMOUNT, await weekFromNow(), REF_B);

      await expect(rail.payInvoiceFromXrpl(2n, buildProof()))
        .to.be.revertedWithCustomError(rail, "InvoiceNotBound")
        .withArgs(2n);
    });

    it("refuses a proof of the wrong attestation type", async () => {
      // The check most easily omitted. `verifyPayment` only proves the response was
      // in its round's Merkle root — it says nothing about the response being the
      // type you asked for.
      const { rail, invoiceId } = await loadFixture(boundFixture);

      await expect(
        rail.payInvoiceFromXrpl(
          invoiceId,
          buildProof({ attestationType: TYPE_BALANCE_DECREASING }),
        ),
      )
        .to.be.revertedWithCustomError(rail, "UnexpectedAttestationType")
        .withArgs(TYPE_BALANCE_DECREASING, TYPE_PAYMENT);
    });

    it("refuses a proof from the wrong source chain", async () => {
      // Same class of hole: a genuine, correctly-attested Bitcoin testnet payment
      // would verify here. Only the sourceId comparison keeps it out.
      const { rail, invoiceId } = await loadFixture(boundFixture);

      await expect(
        rail.payInvoiceFromXrpl(invoiceId, buildProof({ sourceId: SOURCE_TEST_BTC })),
      )
        .to.be.revertedWithCustomError(rail, "UnexpectedSource")
        .withArgs(SOURCE_TEST_BTC, SOURCE_TEST_XRP);
    });

    it("refuses a proof the verifier rejects", async () => {
      const { rail, verifier, invoiceId } = await loadFixture(boundFixture);
      await verifier.setShouldVerify(false);

      await expect(rail.payInvoiceFromXrpl(invoiceId, buildProof()))
        .to.be.revertedWithCustomError(rail, "ProofRejected")
        .withArgs(TXID);
    });

    it("refuses a failed XRPL transaction even though it is attestable", async () => {
      // Statuses 1 and 2 record sender-fault and receiver-fault failures. FDC will
      // happily attest that a failure happened; that is not the merchant being paid.
      const { rail, invoiceId } = await loadFixture(boundFixture);

      for (const status of [1n, 2n]) {
        await expect(rail.payInvoiceFromXrpl(invoiceId, buildProof({ status })))
          .to.be.revertedWithCustomError(rail, "XrplPaymentFailed")
          .withArgs(status);
      }
    });

    it("refuses a payment carrying a different invoice's reference", async () => {
      const { rail, invoiceId } = await loadFixture(boundFixture);

      await expect(
        rail.payInvoiceFromXrpl(invoiceId, buildProof({ standardPaymentReference: REF_B })),
      )
        .to.be.revertedWithCustomError(rail, "ReferenceMismatch")
        .withArgs(REF_B, REF_A);
    });

    it("refuses a payment that went to someone else's XRPL account", async () => {
      const { rail, invoiceId } = await loadFixture(boundFixture);

      await expect(
        rail.payInvoiceFromXrpl(invoiceId, buildProof({ receivingAddressHash: STRANGER_XRPL })),
      )
        .to.be.revertedWithCustomError(rail, "RecipientMismatch")
        .withArgs(STRANGER_XRPL, MERCHANT_XRPL);
    });

    it("refuses a non-positive received amount rather than casting it", async () => {
      // `receivedAmount` is int256 in the attestation type. Casting -1 to uint256
      // yields 2^256-1, which would sail past the commitment floor.
      const { rail, invoiceId } = await loadFixture(boundFixture);

      for (const amount of [0n, -1n, -DROPS]) {
        await expect(rail.payInvoiceFromXrpl(invoiceId, buildProof({ receivedAmount: amount })))
          .to.be.revertedWithCustomError(rail, "NonPositiveAmount")
          .withArgs(amount);
      }
    });

    it("refuses a payment short of the committed drops", async () => {
      const { rail, invoiceId } = await loadFixture(boundFixture);

      await expect(rail.payInvoiceFromXrpl(invoiceId, buildProof({ receivedAmount: DROPS - 1n })))
        .to.be.revertedWithCustomError(rail, "AmountBelowCommitment")
        .withArgs(DROPS - 1n, DROPS);
    });

    it("accepts an overpayment without fronting more", async () => {
      // Overpaying is the customer's business. The rail fronts the invoice amount and
      // keeps the surplus XRP, which is the operator's margin.
      const { rail, invoice, fxrp, invoiceId } = await loadFixture(boundFixture);

      const railBefore = await fxrp.balanceOf(await rail.getAddress());
      await rail.payInvoiceFromXrpl(
        invoiceId,
        buildProof({ receivedAmount: DROPS * 2n, blockTimestamp: BigInt(await time.latest()) }),
      );

      expect(await fxrp.balanceOf(await rail.getAddress())).to.equal(railBefore - AMOUNT);
      expect((await rail.recordOf(invoiceId)).dropsReceived).to.equal(DROPS * 2n);
      expect((await invoice.getInvoice(invoiceId)).amountPaid).to.equal(AMOUNT);
    });

    it("refuses a payment that predates the invoice", async () => {
      // An XRPL payment made before the invoice existed cannot be a payment of it.
      const { rail, invoice, invoiceId } = await loadFixture(boundFixture);
      const createdAt = (await invoice.getInvoice(invoiceId)).createdAt;

      await expect(
        rail.payInvoiceFromXrpl(invoiceId, buildProof({ blockTimestamp: createdAt - 1n })),
      )
        .to.be.revertedWithCustomError(rail, "PaymentPredatesInvoice")
        .withArgs(createdAt - 1n, createdAt);

      // The boundary itself is acceptable.
      await expect(rail.payInvoiceFromXrpl(invoiceId, buildProof({ blockTimestamp: createdAt })))
        .to.not.be.reverted;
    });

    it("refuses to spend one XRPL transaction twice", async () => {
      const { rail, invoice, merchant, fxrp, invoiceId } = await loadFixture(boundFixture);

      await rail.payInvoiceFromXrpl(
        invoiceId,
        buildProof({ blockTimestamp: BigInt(await time.latest()) }),
      );
      expect(await rail.transactionUsed(TXID)).to.equal(true);

      // A second invoice, with its own reference, bound to the same merchant — the
      // shape an attacker would use to spend one payment twice.
      await invoice
        .connect(merchant)
        .createInvoice(await fxrp.getAddress(), AMOUNT, await weekFromNow(), REF_B);
      await rail.connect(merchant).bindInvoice(2n, MERCHANT_XRPL, DROPS);

      await expect(
        rail.payInvoiceFromXrpl(
          2n,
          buildProof({ standardPaymentReference: REF_B, blockTimestamp: BigInt(await time.latest()) }),
        ),
      )
        .to.be.revertedWithCustomError(rail, "TransactionAlreadyUsed")
        .withArgs(TXID);

      // A different transaction for the same invoice is fine.
      await expect(
        rail.payInvoiceFromXrpl(
          2n,
          buildProof({
            transactionId: OTHER_TXID,
            standardPaymentReference: REF_B,
            blockTimestamp: BigInt(await time.latest()),
          }),
        ),
      ).to.not.be.reverted;
    });

    it("reverts legibly when the float cannot cover the invoice", async () => {
      const { rail, owner, fxrp, invoiceId } = await loadFixture(boundFixture);

      const available = await fxrp.balanceOf(await rail.getAddress());
      await rail.connect(owner).withdrawLiquidity(owner.address, available - (AMOUNT - 1n));

      await expect(
        rail.payInvoiceFromXrpl(invoiceId, buildProof({ blockTimestamp: BigInt(await time.latest()) })),
      )
        .to.be.revertedWithCustomError(rail, "InsufficientLiquidity")
        .withArgs(AMOUNT, AMOUNT - 1n);

      // Refunding makes the same proof usable again — the failure is recoverable.
      await fxrp.connect(owner).approve(await rail.getAddress(), AMOUNT);
      await rail.connect(owner).depositLiquidity(AMOUNT);
      await expect(
        rail.payInvoiceFromXrpl(invoiceId, buildProof({ blockTimestamp: BigInt(await time.latest()) })),
      ).to.not.be.reverted;
    });

    it("cannot be called while paused", async () => {
      const { rail, owner, invoiceId } = await loadFixture(boundFixture);
      await rail.connect(owner).pause();

      await expect(
        rail.payInvoiceFromXrpl(invoiceId, buildProof()),
      ).to.be.revertedWithCustomError(rail, "EnforcedPause");
    });

    it("cannot pay an invoice past its due date", async () => {
      // Enforced by FluxaInvoice, at proof-submission time rather than payment time.
      // A documented limitation of routing through the ordinary entry point: the
      // revert surfaces from the invoice contract, not the rail, because the rail
      // has no opinion about deadlines.
      const { rail, invoice, invoiceId, dueAt } = await loadFixture(boundFixture);

      const paidAt = BigInt(await time.latest());
      await time.increaseTo(dueAt + 1);

      await expect(
        rail.payInvoiceFromXrpl(invoiceId, buildProof({ blockTimestamp: paidAt })),
      )
        .to.be.revertedWithCustomError(invoice, "InvalidStatus")
        .withArgs(invoiceId, Status.EXPIRED);
    });
  });

  // -------------------------------------------------------------------------

  describe("liquidity", () => {
    it("accepts a deposit from anyone", async () => {
      const { rail, fxrp, customer } = await loadFixture(deployRailFixture);

      await fxrp.connect(customer).approve(await rail.getAddress(), AMOUNT);
      const before = await rail.availableLiquidity();

      await expect(rail.connect(customer).depositLiquidity(AMOUNT))
        .to.emit(rail, "LiquidityDeposited")
        .withArgs(customer.address, AMOUNT);

      expect(await rail.availableLiquidity()).to.equal(before + AMOUNT);
    });

    it("rejects a zero deposit", async () => {
      const { rail, customer } = await loadFixture(deployRailFixture);
      await expect(
        rail.connect(customer).depositLiquidity(0n),
      ).to.be.revertedWithCustomError(rail, "InsufficientLiquidity");
    });

    it("lets only the owner withdraw", async () => {
      const { rail, customer, owner } = await loadFixture(deployRailFixture);

      await expect(
        rail.connect(customer).withdrawLiquidity(customer.address, AMOUNT),
      ).to.be.revertedWithCustomError(rail, "OwnableUnauthorizedAccount");

      await expect(rail.connect(owner).withdrawLiquidity(owner.address, AMOUNT))
        .to.emit(rail, "LiquidityWithdrawn")
        .withArgs(owner.address, AMOUNT);
    });

    it("refuses to withdraw more than it holds, or to the zero address", async () => {
      const { rail, owner } = await loadFixture(deployRailFixture);
      const available = await rail.availableLiquidity();

      await expect(rail.connect(owner).withdrawLiquidity(owner.address, available + 1n))
        .to.be.revertedWithCustomError(rail, "InsufficientLiquidity")
        .withArgs(available + 1n, available);

      await expect(
        rail.connect(owner).withdrawLiquidity(ethers.ZeroAddress, 1n),
      ).to.be.revertedWithCustomError(rail, "ZeroAddress");
    });

    it("still allows withdrawal while paused", async () => {
      // Pausing is the response to something being wrong. Stranding the float behind
      // the same switch would make that worse.
      const { rail, owner } = await loadFixture(deployRailFixture);
      await rail.connect(owner).pause();

      await expect(rail.connect(owner).withdrawLiquidity(owner.address, AMOUNT)).to.not.be
        .reverted;
    });
  });
});
