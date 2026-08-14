import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

import {
  AMOUNT,
  MINT,
  ONE_YEAR,
  REF_A,
  REF_B,
  Rail,
  Status,
  TOKEN_DECIMALS,
  ZERO_REF,
  createdInvoiceFixture,
  deployFluxaFixture,
  paidInvoiceFixture,
  weekFromNow,
} from "./fixtures";

describe("FluxaInvoice", () => {
  describe("deployment and admin", () => {
    it("assigns ownership to the address given at construction", async () => {
      const { invoice, owner } = await loadFixture(deployFluxaFixture);
      expect(await invoice.owner()).to.equal(owner.address);
    });

    it("rejects a zero owner via Ownable, not a local check", async () => {
      const FluxaInvoice = await ethers.getContractFactory("FluxaInvoice");
      await expect(FluxaInvoice.deploy(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(FluxaInvoice, "OwnableInvalidOwner")
        .withArgs(ethers.ZeroAddress);
    });

    it("starts invoice ids at 1 so zero means no invoice", async () => {
      const { invoice } = await loadFixture(deployFluxaFixture);
      expect(await invoice.nextInvoiceId()).to.equal(1n);
      expect(await invoice.exists(0n)).to.equal(false);
    });

    it("lets only the owner change token acceptance", async () => {
      const { invoice, merchant, stray } = await loadFixture(deployFluxaFixture);
      await expect(
        invoice.connect(merchant).setAcceptedToken(await stray.getAddress(), true),
      )
        .to.be.revertedWithCustomError(invoice, "OwnableUnauthorizedAccount")
        .withArgs(merchant.address);
    });

    it("toggles token acceptance and emits the change", async () => {
      const { invoice, owner, stray } = await loadFixture(deployFluxaFixture);
      const token = await stray.getAddress();

      await expect(invoice.connect(owner).setAcceptedToken(token, true))
        .to.emit(invoice, "TokenAcceptanceChanged")
        .withArgs(token, true);
      expect(await invoice.acceptedToken(token)).to.equal(true);

      await expect(invoice.connect(owner).setAcceptedToken(token, false))
        .to.emit(invoice, "TokenAcceptanceChanged")
        .withArgs(token, false);
      expect(await invoice.acceptedToken(token)).to.equal(false);
    });

    it("refuses the zero address as an accepted token", async () => {
      const { invoice, owner } = await loadFixture(deployFluxaFixture);
      await expect(
        invoice.connect(owner).setAcceptedToken(ethers.ZeroAddress, true),
      ).to.be.revertedWithCustomError(invoice, "ZeroAddress");
    });

    it("lets only the owner set the settlement contract", async () => {
      const { invoice, merchant, other } = await loadFixture(deployFluxaFixture);
      await expect(
        invoice.connect(merchant).setSettlementContract(other.address),
      ).to.be.revertedWithCustomError(invoice, "OwnableUnauthorizedAccount");
    });

    it("emits the previous and current settlement contract", async () => {
      const { invoice, owner, settlement, other } =
        await loadFixture(deployFluxaFixture);
      await expect(invoice.connect(owner).setSettlementContract(other.address))
        .to.emit(invoice, "SettlementContractChanged")
        .withArgs(await settlement.getAddress(), other.address);
    });

    it("lets only the owner pause", async () => {
      const { invoice, merchant } = await loadFixture(deployFluxaFixture);
      await expect(
        invoice.connect(merchant).pause(),
      ).to.be.revertedWithCustomError(invoice, "OwnableUnauthorizedAccount");
    });

    it("lets only the owner unpause", async () => {
      const { invoice, owner, merchant } = await loadFixture(deployFluxaFixture);
      await invoice.connect(owner).pause();
      await expect(
        invoice.connect(merchant).unpause(),
      ).to.be.revertedWithCustomError(invoice, "OwnableUnauthorizedAccount");
    });

    it("resumes normal operation after unpausing", async () => {
      const { invoice, owner, merchant, usdt } =
        await loadFixture(deployFluxaFixture);
      await invoice.connect(owner).pause();
      expect(await invoice.paused()).to.equal(true);

      await invoice.connect(owner).unpause();
      expect(await invoice.paused()).to.equal(false);

      await expect(
        invoice
          .connect(merchant)
          .createInvoice(await usdt.getAddress(), AMOUNT, await weekFromNow(), REF_A),
      ).to.emit(invoice, "InvoiceCreated");
    });
  });

  describe("createInvoice", () => {
    it("stores every field it was given", async () => {
      const { invoice, merchant, usdt } = await loadFixture(deployFluxaFixture);
      const dueAt = await weekFromNow();
      const token = await usdt.getAddress();

      await invoice.connect(merchant).createInvoice(token, AMOUNT, dueAt, REF_A);
      const stored = await invoice.getInvoice(1n);

      expect(stored.merchant).to.equal(merchant.address);
      expect(stored.payToken).to.equal(token);
      expect(stored.amount).to.equal(AMOUNT);
      expect(stored.amountPaid).to.equal(0n);
      expect(stored.dueAt).to.equal(BigInt(dueAt));
      expect(stored.paidAt).to.equal(0n);
      expect(stored.payer).to.equal(ethers.ZeroAddress);
      expect(stored.status).to.equal(Status.CREATED);
      expect(stored.rail).to.equal(Rail.FLARE_ERC20);
      expect(stored.paymentRef).to.equal(REF_A);
      expect(stored.createdAt).to.equal(BigInt(await time.latest()));
    });

    it("emits InvoiceCreated", async () => {
      const { invoice, merchant, usdt } = await loadFixture(deployFluxaFixture);
      const dueAt = await weekFromNow();
      const token = await usdt.getAddress();

      await expect(
        invoice.connect(merchant).createInvoice(token, AMOUNT, dueAt, REF_A),
      )
        .to.emit(invoice, "InvoiceCreated")
        .withArgs(1n, merchant.address, token, AMOUNT, dueAt, REF_A);
    });

    it("increments ids across merchants", async () => {
      const { invoice, merchant, other, usdt } =
        await loadFixture(deployFluxaFixture);
      const dueAt = await weekFromNow();
      const token = await usdt.getAddress();

      await invoice.connect(merchant).createInvoice(token, AMOUNT, dueAt, REF_A);
      await invoice.connect(other).createInvoice(token, AMOUNT, dueAt, REF_B);

      expect(await invoice.nextInvoiceId()).to.equal(3n);
      expect((await invoice.getInvoice(1n)).merchant).to.equal(merchant.address);
      expect((await invoice.getInvoice(2n)).merchant).to.equal(other.address);
    });

    it("rejects a token that is not on the allowlist", async () => {
      const { invoice, merchant, stray } = await loadFixture(deployFluxaFixture);
      const token = await stray.getAddress();
      await expect(
        invoice
          .connect(merchant)
          .createInvoice(token, AMOUNT, await weekFromNow(), REF_A),
      )
        .to.be.revertedWithCustomError(invoice, "TokenNotAccepted")
        .withArgs(token);
    });

    it("rejects a zero amount", async () => {
      const { invoice, merchant, usdt } = await loadFixture(deployFluxaFixture);
      await expect(
        invoice
          .connect(merchant)
          .createInvoice(await usdt.getAddress(), 0n, await weekFromNow(), REF_A),
      ).to.be.revertedWithCustomError(invoice, "ZeroAmount");
    });

    it("rejects a due date in the past", async () => {
      const { invoice, merchant, usdt } = await loadFixture(deployFluxaFixture);
      const past = (await time.latest()) - 1;
      await expect(
        invoice
          .connect(merchant)
          .createInvoice(await usdt.getAddress(), AMOUNT, past, REF_A),
      ).to.be.revertedWithCustomError(invoice, "DueDateInPast");
    });

    it("rejects a due date more than the maximum duration out", async () => {
      const { invoice, merchant, usdt } = await loadFixture(deployFluxaFixture);
      const tooFar = (await time.latest()) + ONE_YEAR + 60;
      await expect(
        invoice
          .connect(merchant)
          .createInvoice(await usdt.getAddress(), AMOUNT, tooFar, REF_A),
      ).to.be.revertedWithCustomError(invoice, "DueDateTooFar");
    });

    it("refuses to bind one payment reference to two invoices", async () => {
      const { invoice, merchant, usdt } = await loadFixture(deployFluxaFixture);
      const dueAt = await weekFromNow();
      const token = await usdt.getAddress();

      await invoice.connect(merchant).createInvoice(token, AMOUNT, dueAt, REF_A);
      await expect(
        invoice.connect(merchant).createInvoice(token, AMOUNT, dueAt, REF_A),
      )
        .to.be.revertedWithCustomError(invoice, "ReferenceAlreadyUsed")
        .withArgs(REF_A);
    });

    it("treats an empty reference as opting out of uniqueness", async () => {
      const { invoice, merchant, usdt } = await loadFixture(deployFluxaFixture);
      const dueAt = await weekFromNow();
      const token = await usdt.getAddress();

      await invoice.connect(merchant).createInvoice(token, AMOUNT, dueAt, ZERO_REF);
      await invoice.connect(merchant).createInvoice(token, AMOUNT, dueAt, ZERO_REF);

      expect(await invoice.referenceUsed(ZERO_REF)).to.equal(false);
      expect(await invoice.nextInvoiceId()).to.equal(3n);
    });

    it("cannot be called while paused", async () => {
      const { invoice, owner, merchant, usdt } =
        await loadFixture(deployFluxaFixture);
      await invoice.connect(owner).pause();
      await expect(
        invoice
          .connect(merchant)
          .createInvoice(await usdt.getAddress(), AMOUNT, await weekFromNow(), REF_A),
      ).to.be.revertedWithCustomError(invoice, "EnforcedPause");
    });
  });

  describe("payInvoice", () => {
    it("escrows the funds and marks the invoice paid", async () => {
      const { invoice, customer, usdt, invoiceId } =
        await loadFixture(createdInvoiceFixture);
      const escrowAddress = await invoice.getAddress();

      await expect(
        invoice.connect(customer).payInvoice(invoiceId),
      ).to.changeTokenBalances(
        usdt,
        [customer, escrowAddress],
        [-AMOUNT, AMOUNT],
      );

      const stored = await invoice.getInvoice(invoiceId);
      expect(stored.status).to.equal(Status.PAID);
      expect(stored.payer).to.equal(customer.address);
      expect(stored.amountPaid).to.equal(AMOUNT);
      expect(stored.rail).to.equal(Rail.FLARE_ERC20);
      expect(stored.paidAt).to.equal(BigInt(await time.latest()));
      expect(await invoice.escrowOf(invoiceId)).to.equal(AMOUNT);
    });

    it("emits InvoicePaid with the rail it arrived on", async () => {
      const { invoice, customer, usdt, invoiceId } =
        await loadFixture(createdInvoiceFixture);
      await expect(invoice.connect(customer).payInvoice(invoiceId))
        .to.emit(invoice, "InvoicePaid")
        .withArgs(
          invoiceId,
          customer.address,
          await usdt.getAddress(),
          AMOUNT,
          Rail.FLARE_ERC20,
        );
    });

    it("moves exactly the base units asked for on a 6-decimal token", async () => {
      // The guard against an 18-decimal assumption: 100 USDT0 is 100_000_000
      // base units, and a 1e18-scaled transfer would be 10^12 times too large.
      const { invoice, customer, usdt, invoiceId } =
        await loadFixture(createdInvoiceFixture);

      expect(await usdt.decimals()).to.equal(TOKEN_DECIMALS);
      await invoice.connect(customer).payInvoice(invoiceId);

      expect(await usdt.balanceOf(await invoice.getAddress())).to.equal(AMOUNT);
      expect(await usdt.balanceOf(customer.address)).to.equal(MINT - AMOUNT);
    });

    it("rejects payment of an unknown invoice", async () => {
      const { invoice, customer } = await loadFixture(createdInvoiceFixture);
      await expect(invoice.connect(customer).payInvoice(999n))
        .to.be.revertedWithCustomError(invoice, "InvoiceNotFound")
        .withArgs(999n);
    });

    it("tells a second payer the invoice is already paid", async () => {
      const { invoice, customer, other, invoiceId } =
        await loadFixture(paidInvoiceFixture);
      await expect(invoice.connect(other).payInvoice(invoiceId))
        .to.be.revertedWithCustomError(invoice, "AlreadyPaid")
        .withArgs(invoiceId, customer.address);
    });

    it("refuses payment of a cancelled invoice", async () => {
      const { invoice, merchant, customer, invoiceId } =
        await loadFixture(createdInvoiceFixture);
      await invoice.connect(merchant).cancelInvoice(invoiceId);

      await expect(invoice.connect(customer).payInvoice(invoiceId))
        .to.be.revertedWithCustomError(invoice, "InvalidStatus")
        .withArgs(invoiceId, Status.CANCELLED);
    });

    it("refuses payment past the due date even before expiry is recorded", async () => {
      const { invoice, customer, invoiceId, dueAt } =
        await loadFixture(createdInvoiceFixture);
      await time.increaseTo(dueAt + 1);

      // Status is still CREATED on-chain; payability is decided by the clock,
      // not by whether a keeper has called expireInvoice yet.
      expect((await invoice.getInvoice(invoiceId)).status).to.equal(Status.CREATED);
      await expect(invoice.connect(customer).payInvoice(invoiceId))
        .to.be.revertedWithCustomError(invoice, "InvalidStatus")
        .withArgs(invoiceId, Status.EXPIRED);
    });

    it("stops a merchant paying their own invoice", async () => {
      const { invoice, merchant, invoiceId } =
        await loadFixture(createdInvoiceFixture);
      await expect(
        invoice.connect(merchant).payInvoice(invoiceId),
      ).to.be.revertedWithCustomError(invoice, "MerchantIsPayer");
    });

    it("cannot be called while paused", async () => {
      const { invoice, owner, customer, invoiceId } =
        await loadFixture(createdInvoiceFixture);
      await invoice.connect(owner).pause();
      await expect(
        invoice.connect(customer).payInvoice(invoiceId),
      ).to.be.revertedWithCustomError(invoice, "EnforcedPause");
    });

    it("reverts without allowance", async () => {
      const { invoice, customer, usdt, invoiceId } =
        await loadFixture(createdInvoiceFixture);
      await usdt.connect(customer).approve(await invoice.getAddress(), 0n);

      await expect(
        invoice.connect(customer).payInvoice(invoiceId),
      ).to.be.revertedWithCustomError(usdt, "ERC20InsufficientAllowance");
    });
  });

  describe("payInvoice against hostile tokens", () => {
    it("rejects a fee-on-transfer token that delivers less than face value", async () => {
      const { invoice, owner, merchant, customer } =
        await loadFixture(deployFluxaFixture);

      const Fee = await ethers.getContractFactory("FeeOnTransferERC20");
      const fee = await Fee.deploy("Fee Token", "FEE", TOKEN_DECIMALS, 100n); // 1%
      const feeAddress = await fee.getAddress();

      await fee.mint(customer.address, MINT);
      await fee.connect(customer).approve(await invoice.getAddress(), MINT);
      await invoice.connect(owner).setAcceptedToken(feeAddress, true);
      await invoice
        .connect(merchant)
        .createInvoice(feeAddress, AMOUNT, await weekFromNow(), REF_A);

      const expectedDelta = AMOUNT - AMOUNT / 100n;
      await expect(invoice.connect(customer).payInvoice(1n))
        .to.be.revertedWithCustomError(invoice, "IncorrectPaymentAmount")
        .withArgs(AMOUNT, expectedDelta);
    });

    it("leaves no trace of a shortfall payment that reverted", async () => {
      // The state writes happen before the transfer, so the whole-transaction
      // revert is what undoes them. Worth asserting rather than assuming: a
      // half-applied payment would leave an invoice PAID with empty escrow.
      const { invoice, owner, merchant, customer } =
        await loadFixture(deployFluxaFixture);

      const Fee = await ethers.getContractFactory("FeeOnTransferERC20");
      const fee = await Fee.deploy("Fee Token", "FEE", TOKEN_DECIMALS, 100n);
      const feeAddress = await fee.getAddress();

      await fee.mint(customer.address, MINT);
      await fee.connect(customer).approve(await invoice.getAddress(), MINT);
      await invoice.connect(owner).setAcceptedToken(feeAddress, true);
      await invoice
        .connect(merchant)
        .createInvoice(feeAddress, AMOUNT, await weekFromNow(), REF_A);

      await expect(invoice.connect(customer).payInvoice(1n)).to.be.reverted;

      const stored = await invoice.getInvoice(1n);
      expect(stored.status).to.equal(Status.CREATED);
      expect(stored.payer).to.equal(ethers.ZeroAddress);
      expect(stored.amountPaid).to.equal(0n);
      expect(await invoice.escrowOf(1n)).to.equal(0n);
      expect(await fee.balanceOf(await invoice.getAddress())).to.equal(0n);
    });

    it("blocks a token that re-enters payInvoice mid-transfer", async () => {
      const { invoice, owner, merchant, customer } =
        await loadFixture(deployFluxaFixture);

      const Reentrant = await ethers.getContractFactory("ReentrantERC20");
      const evil = await Reentrant.deploy("Evil", "EVIL", TOKEN_DECIMALS);
      const evilAddress = await evil.getAddress();

      await evil.mint(customer.address, MINT);
      await evil.connect(customer).approve(await invoice.getAddress(), MINT);
      await invoice.connect(owner).setAcceptedToken(evilAddress, true);
      await invoice
        .connect(merchant)
        .createInvoice(evilAddress, AMOUNT, await weekFromNow(), REF_A);

      await evil.arm(await invoice.getAddress(), 1n);
      await invoice.connect(customer).payInvoice(1n);

      // The outer payment succeeded and the re-entrant one was rejected.
      expect(await evil.reentrancyReverted()).to.equal(true);
      expect(await invoice.escrowOf(1n)).to.equal(AMOUNT);
      expect(await evil.balanceOf(await invoice.getAddress())).to.equal(AMOUNT);

      // ReentrancyGuard is what stopped it, not a status check further in.
      const guardSelector = invoice.interface.getError("ReentrancyGuardReentrantCall")!
        .selector;
      expect(await evil.lastRevertData()).to.equal(guardSelector);
    });
  });

  describe("cancelInvoice", () => {
    it("lets the merchant cancel an unpaid invoice", async () => {
      const { invoice, merchant, invoiceId } =
        await loadFixture(createdInvoiceFixture);

      await expect(invoice.connect(merchant).cancelInvoice(invoiceId))
        .to.emit(invoice, "InvoiceCancelled")
        .withArgs(invoiceId, merchant.address);
      expect((await invoice.getInvoice(invoiceId)).status).to.equal(
        Status.CANCELLED,
      );
    });

    it("refuses anyone who is not the merchant", async () => {
      const { invoice, customer, other, invoiceId } =
        await loadFixture(createdInvoiceFixture);

      for (const signer of [customer, other]) {
        await expect(invoice.connect(signer).cancelInvoice(invoiceId))
          .to.be.revertedWithCustomError(invoice, "NotInvoiceMerchant")
          .withArgs(invoiceId, signer.address);
      }
    });

    it("refuses the contract owner, who is not a party to the invoice", async () => {
      const { invoice, owner, invoiceId } =
        await loadFixture(createdInvoiceFixture);
      await expect(
        invoice.connect(owner).cancelInvoice(invoiceId),
      ).to.be.revertedWithCustomError(invoice, "NotInvoiceMerchant");
    });

    it("will not cancel an invoice that has been paid", async () => {
      const { invoice, merchant, invoiceId } =
        await loadFixture(paidInvoiceFixture);
      await expect(invoice.connect(merchant).cancelInvoice(invoiceId))
        .to.be.revertedWithCustomError(invoice, "InvalidStatus")
        .withArgs(invoiceId, Status.PAID);
    });

    it("cannot be cancelled twice", async () => {
      const { invoice, merchant, invoiceId } =
        await loadFixture(createdInvoiceFixture);
      await invoice.connect(merchant).cancelInvoice(invoiceId);
      await expect(invoice.connect(merchant).cancelInvoice(invoiceId))
        .to.be.revertedWithCustomError(invoice, "InvalidStatus")
        .withArgs(invoiceId, Status.CANCELLED);
    });

    it("stays available while paused, so a merchant is never trapped", async () => {
      const { invoice, owner, merchant, invoiceId } =
        await loadFixture(createdInvoiceFixture);
      await invoice.connect(owner).pause();
      await expect(invoice.connect(merchant).cancelInvoice(invoiceId)).to.emit(
        invoice,
        "InvoiceCancelled",
      );
    });
  });

  describe("expireInvoice", () => {
    it("can be called by anyone once the due date has passed", async () => {
      const { invoice, keeper, invoiceId, dueAt } =
        await loadFixture(createdInvoiceFixture);
      await time.increaseTo(dueAt + 1);

      await expect(invoice.connect(keeper).expireInvoice(invoiceId))
        .to.emit(invoice, "InvoiceExpired")
        .withArgs(invoiceId, keeper.address);
      expect((await invoice.getInvoice(invoiceId)).status).to.equal(Status.EXPIRED);
    });

    it("refuses to expire an invoice that is not yet due", async () => {
      const { invoice, keeper, invoiceId, dueAt } =
        await loadFixture(createdInvoiceFixture);
      await expect(invoice.connect(keeper).expireInvoice(invoiceId))
        .to.be.revertedWithCustomError(invoice, "NotYetDue")
        .withArgs(invoiceId, dueAt);
    });

    it("treats the due second itself as still payable", async () => {
      // dueAt is inclusive: `block.timestamp <= dueAt` is not yet expired.
      const { invoice, keeper, invoiceId, dueAt } =
        await loadFixture(createdInvoiceFixture);
      await time.setNextBlockTimestamp(dueAt);
      await expect(
        invoice.connect(keeper).expireInvoice(invoiceId),
      ).to.be.revertedWithCustomError(invoice, "NotYetDue");
    });

    it("never expires an invoice that was paid in time", async () => {
      const { invoice, keeper, invoiceId, dueAt } =
        await loadFixture(paidInvoiceFixture);
      await time.increaseTo(dueAt + 1);

      await expect(invoice.connect(keeper).expireInvoice(invoiceId))
        .to.be.revertedWithCustomError(invoice, "InvalidStatus")
        .withArgs(invoiceId, Status.PAID);
    });

    it("will not expire a cancelled invoice", async () => {
      const { invoice, merchant, keeper, invoiceId, dueAt } =
        await loadFixture(createdInvoiceFixture);
      await invoice.connect(merchant).cancelInvoice(invoiceId);
      await time.increaseTo(dueAt + 1);

      await expect(invoice.connect(keeper).expireInvoice(invoiceId))
        .to.be.revertedWithCustomError(invoice, "InvalidStatus")
        .withArgs(invoiceId, Status.CANCELLED);
    });

    it("cannot be expired twice", async () => {
      const { invoice, keeper, invoiceId, dueAt } =
        await loadFixture(createdInvoiceFixture);
      await time.increaseTo(dueAt + 1);
      await invoice.connect(keeper).expireInvoice(invoiceId);

      await expect(invoice.connect(keeper).expireInvoice(invoiceId))
        .to.be.revertedWithCustomError(invoice, "InvalidStatus")
        .withArgs(invoiceId, Status.EXPIRED);
    });
  });

  describe("releaseEscrow", () => {
    it("refuses every caller except the settlement contract", async () => {
      const { invoice, owner, merchant, customer, invoiceId } =
        await loadFixture(paidInvoiceFixture);

      for (const signer of [owner, merchant, customer]) {
        await expect(
          invoice.connect(signer).releaseEscrow(invoiceId, merchant.address),
        )
          .to.be.revertedWithCustomError(invoice, "NotSettlementContract")
          .withArgs(signer.address);
      }
    });

    it("refuses when no settlement contract has been configured", async () => {
      const FluxaInvoice = await ethers.getContractFactory("FluxaInvoice");
      const { owner, merchant, customer, usdt } =
        await loadFixture(deployFluxaFixture);

      const fresh = await FluxaInvoice.deploy(owner.address);
      const token = await usdt.getAddress();
      await fresh.connect(owner).setAcceptedToken(token, true);
      await fresh
        .connect(merchant)
        .createInvoice(token, AMOUNT, await weekFromNow(), REF_A);
      await usdt.connect(customer).approve(await fresh.getAddress(), MINT);
      await fresh.connect(customer).payInvoice(1n);

      await expect(
        fresh.connect(owner).releaseEscrow(1n, merchant.address),
      ).to.be.revertedWithCustomError(fresh, "SettlementContractNotSet");
    });

    it("refuses to release an invoice that was never paid", async () => {
      const { invoice, owner, merchant, other, invoiceId } =
        await loadFixture(createdInvoiceFixture);
      // Point settlement at an EOA so the call can be made directly.
      await invoice.connect(owner).setSettlementContract(other.address);

      await expect(
        invoice.connect(other).releaseEscrow(invoiceId, merchant.address),
      )
        .to.be.revertedWithCustomError(invoice, "InvalidStatus")
        .withArgs(invoiceId, Status.CREATED);
    });

    it("refuses a zero recipient", async () => {
      const { invoice, owner, other, invoiceId } =
        await loadFixture(paidInvoiceFixture);
      await invoice.connect(owner).setSettlementContract(other.address);

      await expect(
        invoice.connect(other).releaseEscrow(invoiceId, ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(invoice, "ZeroAddress");
    });

    it("works while the contract is paused", async () => {
      // Once a customer's funds are held, the route to the merchant must stay
      // open regardless of admin state — pausing must not strand escrow.
      const { invoice, owner, merchant, other, usdt, invoiceId } =
        await loadFixture(paidInvoiceFixture);
      await invoice.connect(owner).setSettlementContract(other.address);
      await invoice.connect(owner).pause();

      await expect(
        invoice.connect(other).releaseEscrow(invoiceId, merchant.address),
      ).to.changeTokenBalances(usdt, [await invoice.getAddress(), merchant], [
        -AMOUNT,
        AMOUNT,
      ]);
      expect((await invoice.getInvoice(invoiceId)).status).to.equal(Status.SETTLED);
    });

    it("cannot release the same escrow twice", async () => {
      const { invoice, owner, merchant, other, invoiceId } =
        await loadFixture(paidInvoiceFixture);
      await invoice.connect(owner).setSettlementContract(other.address);
      await invoice.connect(other).releaseEscrow(invoiceId, merchant.address);

      expect(await invoice.escrowOf(invoiceId)).to.equal(0n);
      await expect(
        invoice.connect(other).releaseEscrow(invoiceId, merchant.address),
      )
        .to.be.revertedWithCustomError(invoice, "InvalidStatus")
        .withArgs(invoiceId, Status.SETTLED);
    });
  });

  describe("views", () => {
    it("reverts rather than returning an empty invoice for an unknown id", async () => {
      const { invoice } = await loadFixture(deployFluxaFixture);
      await expect(invoice.getInvoice(42n))
        .to.be.revertedWithCustomError(invoice, "InvoiceNotFound")
        .withArgs(42n);
    });

    it("reports payability across the whole lifecycle", async () => {
      const { invoice, customer, invoiceId } =
        await loadFixture(createdInvoiceFixture);

      expect(await invoice.isPayable(invoiceId)).to.equal(true);
      await invoice.connect(customer).payInvoice(invoiceId);
      expect(await invoice.isPayable(invoiceId)).to.equal(false);
    });

    it("reports an overdue invoice as unpayable before anyone expires it", async () => {
      const { invoice, invoiceId, dueAt } =
        await loadFixture(createdInvoiceFixture);
      await time.increaseTo(dueAt + 1);
      expect(await invoice.isPayable(invoiceId)).to.equal(false);
    });

    it("reports a nonexistent invoice as unpayable", async () => {
      const { invoice } = await loadFixture(deployFluxaFixture);
      expect(await invoice.isPayable(1n)).to.equal(false);
    });

    it("keeps escrow attributed per invoice", async () => {
      // Two invoices funded in the same token: the contract's total balance is
      // the sum, but neither invoice may claim the other's share.
      const { invoice, merchant, customer, other, usdt, keeper } =
        await loadFixture(deployFluxaFixture);
      const token = await usdt.getAddress();
      const dueAt = await weekFromNow();

      await invoice.connect(merchant).createInvoice(token, AMOUNT, dueAt, REF_A);
      await invoice.connect(keeper).createInvoice(token, AMOUNT * 2n, dueAt, REF_B);
      await invoice.connect(customer).payInvoice(1n);
      await invoice.connect(other).payInvoice(2n);

      expect(await invoice.escrowOf(1n)).to.equal(AMOUNT);
      expect(await invoice.escrowOf(2n)).to.equal(AMOUNT * 2n);
      expect(await usdt.balanceOf(await invoice.getAddress())).to.equal(
        AMOUNT * 3n,
      );
    });
  });
});
