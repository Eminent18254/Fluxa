import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

import {
  AMOUNT,
  REF_A,
  Status,
  createdInvoiceFixture,
  deployFluxaFixture,
  paidInvoiceFixture,
  weekFromNow,
} from "./fixtures";

describe("FluxaSettlement", () => {
  describe("deployment and configuration", () => {
    it("binds to the invoice contract permanently", async () => {
      const { settlement, invoice } = await loadFixture(deployFluxaFixture);
      expect(await settlement.invoiceContract()).to.equal(
        await invoice.getAddress(),
      );
    });

    it("refuses a zero invoice contract", async () => {
      const { owner } = await loadFixture(deployFluxaFixture);
      const Settlement = await ethers.getContractFactory("FluxaSettlement");
      await expect(
        Settlement.deploy(owner.address, ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(Settlement, "ZeroAddress");
    });

    it("lets only the owner set the price oracle", async () => {
      const { settlement, merchant, oracle } =
        await loadFixture(deployFluxaFixture);
      await expect(
        settlement.connect(merchant).setPriceOracle(await oracle.getAddress()),
      ).to.be.revertedWithCustomError(settlement, "OwnableUnauthorizedAccount");
    });

    it("allows the oracle to be removed, so a bad feed cannot brick settlement", async () => {
      const { settlement, owner, oracle } = await loadFixture(deployFluxaFixture);
      const oracleAddress = await oracle.getAddress();

      await settlement.connect(owner).setPriceOracle(oracleAddress);
      expect(await settlement.priceOracle()).to.equal(oracleAddress);

      await expect(settlement.connect(owner).setPriceOracle(ethers.ZeroAddress))
        .to.emit(settlement, "PriceOracleChanged")
        .withArgs(oracleAddress, ethers.ZeroAddress);
      expect(await settlement.priceOracle()).to.equal(ethers.ZeroAddress);
    });
  });

  describe("payout nomination", () => {
    it("defaults to paying the merchant directly", async () => {
      const { settlement, merchant } = await loadFixture(deployFluxaFixture);
      expect(await settlement.payoutAddress(merchant.address)).to.equal(
        ethers.ZeroAddress,
      );
      expect(await settlement.effectivePayoutAddress(merchant.address)).to.equal(
        merchant.address,
      );
    });

    it("lets a merchant nominate their own destination", async () => {
      const { settlement, merchant, other } =
        await loadFixture(deployFluxaFixture);
      await expect(settlement.connect(merchant).setPayoutAddress(other.address))
        .to.emit(settlement, "PayoutAddressChanged")
        .withArgs(merchant.address, ethers.ZeroAddress, other.address);

      expect(await settlement.effectivePayoutAddress(merchant.address)).to.equal(
        other.address,
      );
    });

    it("scopes the nomination to the caller, so nobody can redirect another merchant", async () => {
      // Including the owner. Owner compromise must not equal theft of every
      // future settlement.
      const { settlement, owner, merchant, other } =
        await loadFixture(deployFluxaFixture);

      await settlement.connect(owner).setPayoutAddress(other.address);
      expect(await settlement.effectivePayoutAddress(merchant.address)).to.equal(
        merchant.address,
      );
      expect(await settlement.effectivePayoutAddress(owner.address)).to.equal(
        other.address,
      );
    });
  });

  describe("settleInvoice", () => {
    it("moves escrow to the merchant and marks the invoice settled", async () => {
      const { settlement, invoice, merchant, usdt, invoiceId } =
        await loadFixture(paidInvoiceFixture);

      await expect(
        settlement.connect(merchant).settleInvoice(invoiceId),
      ).to.changeTokenBalances(
        usdt,
        [await invoice.getAddress(), merchant],
        [-AMOUNT, AMOUNT],
      );

      expect((await invoice.getInvoice(invoiceId)).status).to.equal(Status.SETTLED);
      expect(await invoice.escrowOf(invoiceId)).to.equal(0n);
      expect(await settlement.isSettled(invoiceId)).to.equal(true);
    });

    it("records what actually moved", async () => {
      const { settlement, merchant, usdt, invoiceId } =
        await loadFixture(paidInvoiceFixture);
      await settlement.connect(merchant).settleInvoice(invoiceId);

      const record = await settlement.getSettlement(invoiceId);
      expect(record.settledTo).to.equal(merchant.address);
      expect(record.settleToken).to.equal(await usdt.getAddress());
      expect(record.amountOut).to.equal(AMOUNT);
      expect(record.settledAt).to.equal(BigInt(await time.latest()));
    });

    it("emits InvoiceSettled", async () => {
      const { settlement, merchant, usdt, invoiceId } =
        await loadFixture(paidInvoiceFixture);

      await expect(settlement.connect(merchant).settleInvoice(invoiceId))
        .to.emit(settlement, "InvoiceSettled")
        .withArgs(
          invoiceId,
          merchant.address,
          merchant.address,
          await usdt.getAddress(),
          AMOUNT,
        );
    });

    it("can be called by anyone, and still pays the merchant", async () => {
      // Permissionless finalisation: a keeper or the customer can push the
      // funds, so the merchant does not need to hold gas to get paid. The
      // destination comes from the invoice, never from the caller.
      const { settlement, invoice, merchant, keeper, usdt, invoiceId } =
        await loadFixture(paidInvoiceFixture);

      await expect(
        settlement.connect(keeper).settleInvoice(invoiceId),
      ).to.changeTokenBalances(
        usdt,
        [await invoice.getAddress(), merchant, keeper],
        [-AMOUNT, AMOUNT, 0n],
      );
    });

    it("honours the merchant's nominated payout address", async () => {
      const { settlement, invoice, merchant, other, keeper, usdt, invoiceId } =
        await loadFixture(paidInvoiceFixture);
      await settlement.connect(merchant).setPayoutAddress(other.address);

      await expect(
        settlement.connect(keeper).settleInvoice(invoiceId),
      ).to.changeTokenBalances(
        usdt,
        [await invoice.getAddress(), other, merchant],
        [-AMOUNT, AMOUNT, 0n],
      );
      expect((await settlement.getSettlement(invoiceId)).settledTo).to.equal(
        other.address,
      );
    });

    it("refuses to settle an invoice nobody has paid", async () => {
      const { settlement, merchant, invoiceId } =
        await loadFixture(createdInvoiceFixture);
      await expect(settlement.connect(merchant).settleInvoice(invoiceId))
        .to.be.revertedWithCustomError(settlement, "InvoiceNotPaid")
        .withArgs(invoiceId, Status.CREATED);
    });

    it("refuses to settle a cancelled invoice", async () => {
      const { settlement, invoice, merchant, invoiceId } =
        await loadFixture(createdInvoiceFixture);
      await invoice.connect(merchant).cancelInvoice(invoiceId);

      await expect(settlement.connect(merchant).settleInvoice(invoiceId))
        .to.be.revertedWithCustomError(settlement, "InvoiceNotPaid")
        .withArgs(invoiceId, Status.CANCELLED);
    });

    it("refuses to settle an expired invoice", async () => {
      const { settlement, invoice, merchant, keeper, invoiceId, dueAt } =
        await loadFixture(createdInvoiceFixture);
      await time.increaseTo(dueAt + 1);
      await invoice.connect(keeper).expireInvoice(invoiceId);

      await expect(settlement.connect(merchant).settleInvoice(invoiceId))
        .to.be.revertedWithCustomError(settlement, "InvoiceNotPaid")
        .withArgs(invoiceId, Status.EXPIRED);
    });

    it("propagates the invoice contract's error for an unknown invoice", async () => {
      const { settlement, invoice, merchant } =
        await loadFixture(deployFluxaFixture);
      await expect(settlement.connect(merchant).settleInvoice(7n))
        .to.be.revertedWithCustomError(invoice, "InvoiceNotFound")
        .withArgs(7n);
    });

    it("cannot settle the same invoice twice", async () => {
      const { settlement, merchant, keeper, invoiceId } =
        await loadFixture(paidInvoiceFixture);
      await settlement.connect(merchant).settleInvoice(invoiceId);
      const settledAt = (await settlement.getSettlement(invoiceId)).settledAt;

      await expect(settlement.connect(keeper).settleInvoice(invoiceId))
        .to.be.revertedWithCustomError(settlement, "AlreadySettled")
        .withArgs(invoiceId, settledAt);
    });

    it("is blocked by the invoice contract if settlement is repointed", async () => {
      // Defence in depth: even holding a settlement record, this contract
      // cannot release escrow once it is no longer the registered settler.
      const { settlement, invoice, owner, merchant, other, invoiceId } =
        await loadFixture(paidInvoiceFixture);
      await invoice.connect(owner).setSettlementContract(other.address);

      await expect(settlement.connect(merchant).settleInvoice(invoiceId))
        .to.be.revertedWithCustomError(invoice, "NotSettlementContract")
        .withArgs(await settlement.getAddress());
    });
  });

  describe("settleInvoiceTo", () => {
    it("lets the merchant name a one-off destination", async () => {
      const { settlement, invoice, merchant, other, usdt, invoiceId } =
        await loadFixture(paidInvoiceFixture);

      await expect(
        settlement.connect(merchant).settleInvoiceTo(invoiceId, other.address),
      ).to.changeTokenBalances(
        usdt,
        [await invoice.getAddress(), other],
        [-AMOUNT, AMOUNT],
      );
      expect((await settlement.getSettlement(invoiceId)).settledTo).to.equal(
        other.address,
      );
    });

    it("refuses anyone but the merchant, because the caller picks the destination", async () => {
      const { settlement, customer, keeper, other, invoiceId } =
        await loadFixture(paidInvoiceFixture);

      for (const signer of [customer, keeper]) {
        await expect(
          settlement.connect(signer).settleInvoiceTo(invoiceId, other.address),
        )
          .to.be.revertedWithCustomError(settlement, "NotInvoiceMerchant")
          .withArgs(invoiceId, signer.address);
      }
    });

    it("refuses the owner too", async () => {
      const { settlement, owner, other, invoiceId } =
        await loadFixture(paidInvoiceFixture);
      await expect(
        settlement.connect(owner).settleInvoiceTo(invoiceId, other.address),
      ).to.be.revertedWithCustomError(settlement, "NotInvoiceMerchant");
    });

    it("refuses a zero destination", async () => {
      const { settlement, merchant, invoiceId } =
        await loadFixture(paidInvoiceFixture);
      await expect(
        settlement.connect(merchant).settleInvoiceTo(invoiceId, ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(settlement, "ZeroAddress");
    });

    it("refuses an invoice nobody has paid", async () => {
      const { settlement, merchant, other, invoiceId } =
        await loadFixture(createdInvoiceFixture);
      await expect(
        settlement.connect(merchant).settleInvoiceTo(invoiceId, other.address),
      )
        .to.be.revertedWithCustomError(settlement, "InvoiceNotPaid")
        .withArgs(invoiceId, Status.CREATED);
    });

    it("shares the double-settlement guard with settleInvoice", async () => {
      const { settlement, merchant, other, invoiceId } =
        await loadFixture(paidInvoiceFixture);
      await settlement.connect(merchant).settleInvoice(invoiceId);

      await expect(
        settlement.connect(merchant).settleInvoiceTo(invoiceId, other.address),
      ).to.be.revertedWithCustomError(settlement, "AlreadySettled");
    });
  });

  describe("price snapshot", () => {
    it("records the oracle reading with its own exponent", async () => {
      // XRP/USD reports 6 decimals on FTSOv2 while FLR/USD reports 8, so the
      // exponent travels with the value or the value is meaningless.
      const { settlement, owner, merchant, usdt, oracle, invoiceId } =
        await loadFixture(paidInvoiceFixture);
      const token = await usdt.getAddress();

      await settlement.connect(owner).setPriceOracle(await oracle.getAddress());
      await oracle.setPrice(token, 1_000_500n, 6, 1_700_000_000n);

      await expect(settlement.connect(merchant).settleInvoice(invoiceId))
        .to.emit(settlement, "SettlementPriceSnapshot")
        .withArgs(invoiceId, token, 1_000_500n, 6, 1_700_000_000n);
    });

    it("emits no snapshot when no oracle is configured", async () => {
      const { settlement, merchant, invoiceId } =
        await loadFixture(paidInvoiceFixture);
      await expect(
        settlement.connect(merchant).settleInvoice(invoiceId),
      ).to.not.emit(settlement, "SettlementPriceSnapshot");
    });

    it("still pays the merchant when the oracle reverts", async () => {
      // The money has already moved by the time the snapshot is attempted.
      // Reverting here would undo a completed payment over a missing log line.
      const { settlement, invoice, owner, merchant, usdt, oracle, invoiceId } =
        await loadFixture(paidInvoiceFixture);

      await settlement.connect(owner).setPriceOracle(await oracle.getAddress());
      await oracle.setShouldRevert(true);

      await expect(
        settlement.connect(merchant).settleInvoice(invoiceId),
      ).to.changeTokenBalances(
        usdt,
        [await invoice.getAddress(), merchant],
        [-AMOUNT, AMOUNT],
      );
      expect(await settlement.isSettled(invoiceId)).to.equal(true);
    });

    it("still pays the merchant when the token has no feed", async () => {
      const { settlement, owner, merchant, oracle, invoiceId } =
        await loadFixture(paidInvoiceFixture);
      await settlement.connect(owner).setPriceOracle(await oracle.getAddress());

      await expect(settlement.connect(merchant).settleInvoice(invoiceId))
        .to.emit(settlement, "InvoiceSettled")
        .and.to.not.emit(settlement, "SettlementPriceSnapshot");
    });
  });

  describe("sweep", () => {
    it("recovers tokens sent here by mistake", async () => {
      const { settlement, owner, other, usdt, keeper } =
        await loadFixture(deployFluxaFixture);
      const settlementAddress = await settlement.getAddress();

      await usdt.connect(keeper).transfer(settlementAddress, AMOUNT);
      await expect(
        settlement.connect(owner).sweep(await usdt.getAddress(), other.address, AMOUNT),
      ).to.changeTokenBalances(usdt, [settlementAddress, other], [-AMOUNT, AMOUNT]);
    });

    it("is owner only", async () => {
      const { settlement, merchant, usdt } = await loadFixture(deployFluxaFixture);
      await expect(
        settlement
          .connect(merchant)
          .sweep(await usdt.getAddress(), merchant.address, AMOUNT),
      ).to.be.revertedWithCustomError(settlement, "OwnableUnauthorizedAccount");
    });

    it("cannot reach escrow, which lives in the invoice contract", async () => {
      const { settlement, invoice, owner, other, usdt, invoiceId } =
        await loadFixture(paidInvoiceFixture);

      expect(await usdt.balanceOf(await settlement.getAddress())).to.equal(0n);
      await expect(
        settlement.connect(owner).sweep(await usdt.getAddress(), other.address, AMOUNT),
      ).to.be.revertedWithCustomError(usdt, "ERC20InsufficientBalance");

      expect(await invoice.escrowOf(invoiceId)).to.equal(AMOUNT);
    });
  });

  describe("end to end", () => {
    it("carries an invoice from creation to a settled merchant balance", async () => {
      const { invoice, settlement, merchant, customer, keeper, usdt, owner, oracle } =
        await loadFixture(deployFluxaFixture);
      const token = await usdt.getAddress();

      await settlement.connect(owner).setPriceOracle(await oracle.getAddress());
      await oracle.setPrice(token, 1_000_000n, 6, 1_700_000_000n);

      const merchantBefore = await usdt.balanceOf(merchant.address);

      await invoice
        .connect(merchant)
        .createInvoice(token, AMOUNT, await weekFromNow(), REF_A);
      expect(await invoice.isPayable(1n)).to.equal(true);

      await invoice.connect(customer).payInvoice(1n);
      expect(await invoice.escrowOf(1n)).to.equal(AMOUNT);

      await settlement.connect(keeper).settleInvoice(1n);

      expect((await invoice.getInvoice(1n)).status).to.equal(Status.SETTLED);
      expect(await usdt.balanceOf(merchant.address)).to.equal(
        merchantBefore + AMOUNT,
      );
      expect(await usdt.balanceOf(await invoice.getAddress())).to.equal(0n);
      expect(await settlement.isSettled(1n)).to.equal(true);
    });
  });
});
