import { expect } from "chai";
import { ethers } from "hardhat";
import { reset, time } from "@nomicfoundation/hardhat-network-helpers";

import {
  COSTON2_ASSET_MANAGER_FXRP,
  COSTON2_PROTOCOL,
  COSTON2_TOKENS,
  FEED_IDS,
  FLARE_CONTRACT_REGISTRY,
} from "../config/flare";
import { FXRP_HOLDERS, USDT0_HOLDERS } from "../config/coston2Holders";
import {
  deployFluxaOnFork,
  enableAsset,
  erc20As,
  erc20At,
  findFundedHolder,
  forkCoston2,
} from "./forkHelpers";

/**
 * FXRP as a Fluxa payment asset — Sprint 3 §7.4.3.
 *
 * The sprint asks for the path `Wallet → FXRP → Fluxa → Invoice` and for the
 * application to "correctly recognize the supported asset". This suite proves
 * both against real Coston2 state: the real FAssets AssetManager, the real FXRP
 * token, real balances held by real accounts, and prices from the live FTSOv2.
 *
 * Why that distinction is worth the network dependency: every one of these
 * assertions passes trivially against `MockERC20`, because a mock is 6-decimal
 * and fee-free by construction. FXRP is a *diamond-proxied FAsset*. Whether it
 * transfers at face value, reports 6 decimals, and behaves like a plain ERC-20
 * inside Fluxa's escrow are facts about FAssets, and the only way to know them is
 * to use the real thing.
 *
 * Two findings this suite is specifically built to catch:
 *
 *   1. **A transfer fee.** Later FAssets versions can charge one. `payInvoice`
 *      measures the balance delta and rejects anything short of face value, so a
 *      fee would break Rail A for FXRP entirely. `transferFeeMillionths()` and
 *      three sibling getters all revert on this deployment, suggesting the feature
 *      is absent — but a getter that does not exist is weak evidence, so the
 *      transfer is measured directly below.
 *
 *   2. **A decimals mismatch.** 18 is the tutorial default; FXRP is 6. Every
 *      amount in Fluxa is a base-unit figure, so this being wrong is a 10^12
 *      error in what a customer is asked to pay.
 */
describe("FXRP as a Fluxa payment asset, on forked Coston2", () => {
  const MAX_PRICE_AGE = 300n;

  /** $500.000000, at FluxaPriceOracle's 6-decimal USD scale. The doc's example. */
  const INVOICE_USD = 500_000_000n;

  /** Headroom over the ~500 FXRP an invoice needs, so approve/pay never scrapes. */
  const HOLDER_MINIMUM_FXRP = 1_000_000_000n; // 1,000.000000 FXRP

  const FXRP = ethers.getAddress(COSTON2_TOKENS.FXRP.address);
  const USDT0 = ethers.getAddress(COSTON2_TOKENS.USDT0.address);

  let available = false;
  let skipReason = "";

  before(async function () {
    this.timeout(180_000);

    const status = await forkCoston2();
    available = status.available;
    if (!status.available) {
      skipReason = status.reason;
      return;
    }
    console.log(`      forked Coston2 at block ${status.block}`);
  });

  after(async () => {
    // Leave the network as a plain local chain. A fork left in place makes the
    // next suite silently read Coston2.
    await reset();
  });

  beforeEach(function () {
    if (!available) {
      console.log(`      skipped: ${skipReason}`);
      this.skip();
    }
  });

  // -------------------------------------------------------------------
  // Recognition: is this token really the FAsset Fluxa thinks it is?
  // -------------------------------------------------------------------

  it("traces FXRP back to FAssets through the Flare registry", async () => {
    // The provenance chain, each link read from chain rather than from config:
    //   FlareContractRegistry → AssetManagerController → AssetManager → FXRP
    //
    // Checking only `FXRP.symbol() == "FTestXRP"` would prove nothing — anyone can
    // deploy a token with that symbol, and Phase 0 found several plausible USDT0
    // decoys on this very chain. What makes FXRP an *interoperable asset* rather
    // than just an ERC-20 is that the FAssets system issues it, and that is what
    // this walks.
    const registry = await ethers.getContractAt(
      "IFlareContractRegistry",
      FLARE_CONTRACT_REGISTRY,
    );

    const controller = await registry.getContractAddressByName("AssetManagerController");
    expect(controller).to.equal(
      ethers.getAddress(COSTON2_PROTOCOL.AssetManagerController),
      "registry resolves a different AssetManagerController than config records",
    );

    const assetManager = await ethers.getContractAt(
      [
        "function fAsset() view returns (address)",
        "function assetManagerController() view returns (address)",
        "function lotSize() view returns (uint256)",
        "function assetMintingDecimals() view returns (uint256)",
      ],
      COSTON2_ASSET_MANAGER_FXRP,
    );

    // The AssetManager must point back at the controller the registry named,
    // otherwise it is an unrelated deployment that happens to expose fAsset().
    expect(await assetManager.assetManagerController()).to.equal(controller);

    const fAsset = await assetManager.fAsset();
    expect(fAsset).to.equal(
      FXRP,
      "the AssetManager issues a different token than config calls FXRP",
    );

    // Phase 0 decoded these out of getSettings() because lotSizeAMG() reverts on
    // this diamond. lotSize() works directly and is far simpler; recorded here so
    // the next person does not repeat the getSettings() decode.
    const lotSize = await assetManager.lotSize();
    const mintingDecimals = await assetManager.assetMintingDecimals();

    expect(mintingDecimals).to.equal(6n);
    expect(lotSize).to.equal(10_000_000n); // 10 XRP at 6dp, matching FXRP_PARAMS

    console.log(`      AssetManager ${COSTON2_ASSET_MANAGER_FXRP}`);
    console.log(`      issues       ${fAsset}`);
    console.log(`      lot size     ${Number(lotSize) / 1e6} XRP, ${mintingDecimals}dp`);
  });

  it("reads 6 decimals off the live FXRP token, not 18", async () => {
    const fxrp = erc20At(FXRP);

    const decimals = Number(await fxrp.decimals());
    const symbol = await fxrp.symbol();

    expect(decimals).to.equal(
      COSTON2_TOKENS.FXRP.decimals,
      "live FXRP decimals differ from config — every amount in Fluxa is wrong",
    );
    expect(decimals).to.equal(6);
    expect(symbol).to.equal(COSTON2_TOKENS.FXRP.onChainSymbol);

    console.log(`      ${symbol} reports ${decimals} decimals`);
  });

  it("moves FXRP at face value, so escrow's exact-amount check can hold", async () => {
    // payInvoice reverts unless the balance delta equals the invoice amount
    // exactly. If FAssets ever charges a transfer fee, Rail A breaks for FXRP —
    // and it should break *here*, naming the cause, rather than surfacing later as
    // an IncorrectPaymentAmount revert inside a payment test.
    const fxrp = erc20At(FXRP);
    const { signer: holder } = await findFundedHolder(
      FXRP,
      FXRP_HOLDERS,
      HOLDER_MINIMUM_FXRP,
    );

    const sink = ethers.Wallet.createRandom().address;
    const amount = 1_000_000n; // 1.000000 FXRP

    const before: bigint = await fxrp.balanceOf(holder.address);
    await (await erc20As(FXRP, holder).transfer(sink, amount)).wait();
    const after: bigint = await fxrp.balanceOf(holder.address);

    const received: bigint = await fxrp.balanceOf(sink);

    expect(received).to.equal(amount, "FXRP delivered less than face value — transfer fee?");
    expect(before - after).to.equal(amount, "sender lost more than face value");
  });

  it("refuses FXRP until Fluxa has been configured to accept it", async () => {
    // Recognition is a decision Fluxa makes, not a property of the token. Before
    // configuration the real FXRP is rejected exactly like any unknown token —
    // which is what stops a merchant being talked into invoicing in something the
    // system cannot price.
    const contracts = await deployFluxaOnFork(MAX_PRICE_AGE);
    const { invoice, priceOracle, merchant } = contracts;

    expect(await invoice.acceptedToken(FXRP)).to.equal(false);
    expect(await priceOracle.hasFeed(FXRP)).to.equal(false);

    const dueAt = (await time.latest()) + 7 * 24 * 60 * 60;
    await expect(
      invoice.connect(merchant).createInvoice(FXRP, 1_000_000n, dueAt, ethers.ZeroHash),
    )
      .to.be.revertedWithCustomError(invoice, "TokenNotAccepted")
      .withArgs(FXRP);

    await enableAsset(contracts, FXRP, FEED_IDS["XRP/USD"]);

    expect(await invoice.acceptedToken(FXRP)).to.equal(true);
    expect(await priceOracle.hasFeed(FXRP)).to.equal(true);
    expect(await priceOracle.feedIdFor(FXRP)).to.equal(FEED_IDS["XRP/USD"]);

    // And now it prices, from the live feed.
    const [value, decimals] = await priceOracle.getPriceUsd(FXRP);
    expect(value).to.be.greaterThan(0n);
    expect(decimals).to.equal(6n);
  });

  // -------------------------------------------------------------------
  // The sprint's stated path: Wallet → FXRP → Fluxa → Invoice
  // -------------------------------------------------------------------

  it("pays a $500 invoice with real FXRP from a real wallet, and settles it", async () => {
    const contracts = await deployFluxaOnFork(MAX_PRICE_AGE);
    const { invoice, settlement, priceOracle, merchant } = contracts;
    await enableAsset(contracts, FXRP, FEED_IDS["XRP/USD"]);

    const invoiceAddress = await invoice.getAddress();
    const fxrp = erc20At(FXRP);

    // --- Price: the FXRP figure comes from FTSOv2, not from a constant -------
    //
    // This is the §3.6 point made executable. The doc's own worked example uses
    // 1 FXRP = $2.50; the live price is ~$1.00, so a hardcoded constant would ask
    // this customer for less than half of what they owe.
    const [price, priceDecimals] = await priceOracle.getPriceUsd(FXRP);
    const fxrpOwed = await priceOracle.quoteTokenAmount(FXRP, INVOICE_USD);

    const usdPerFxrp = Number(ethers.formatUnits(price, Number(priceDecimals)));
    const fxrpOwedHuman = Number(ethers.formatUnits(fxrpOwed, 6));

    console.log(
      `      $500 invoice → ${fxrpOwedHuman} FXRP at $${usdPerFxrp}/FXRP (live FTSOv2)`,
    );

    // Derived, so it must actually reconstruct the invoice value.
    expect(fxrpOwedHuman * usdPerFxrp).to.be.closeTo(500, 0.01);

    // --- Wallet: a real account that really holds FXRP ----------------------
    const { signer: customer, balance: customerBalanceBefore } = await findFundedHolder(
      FXRP,
      FXRP_HOLDERS,
      HOLDER_MINIMUM_FXRP,
    );
    expect(customer.address).to.not.equal(merchant.address); // MerchantIsPayer

    console.log(
      `      customer ${customer.address} holds ${ethers.formatUnits(customerBalanceBefore, 6)} FXRP`,
    );

    // --- Invoice ------------------------------------------------------------
    const dueAt = (await time.latest()) + 7 * 24 * 60 * 60;
    const paymentRef = ethers.keccak256(ethers.toUtf8Bytes("fluxa-fxrp-500-usd"));

    await (
      await invoice.connect(merchant).createInvoice(FXRP, fxrpOwed, dueAt, paymentRef)
    ).wait();

    const invoiceId = 1n;
    expect(await invoice.isPayable(invoiceId)).to.equal(true);

    // --- Payment: real FXRP crosses into Fluxa's escrow ---------------------
    await (await erc20As(FXRP, customer).approve(invoiceAddress, fxrpOwed)).wait();

    const escrowBalanceBefore: bigint = await fxrp.balanceOf(invoiceAddress);

    await expect(invoice.connect(customer).payInvoice(invoiceId))
      .to.emit(invoice, "InvoicePaid")
      .withArgs(invoiceId, customer.address, FXRP, fxrpOwed, 0n /* Rail.FLARE_ERC20 */);

    // The token really moved — asserted on the token's own ledger, not on Fluxa's
    // record of it. Fluxa saying PAID while no FXRP moved is the failure that
    // matters, and only the token can rule it out.
    expect(await fxrp.balanceOf(customer.address)).to.equal(
      customerBalanceBefore - fxrpOwed,
      "customer's FXRP did not leave their wallet",
    );
    expect(await fxrp.balanceOf(invoiceAddress)).to.equal(
      escrowBalanceBefore + fxrpOwed,
      "FXRP did not arrive in escrow",
    );

    const stored = await invoice.getInvoice(invoiceId);
    expect(stored.status).to.equal(2n); // PAID
    expect(stored.rail).to.equal(0n); // FLARE_ERC20 — no FDC needed, see Phase 0 §2.3
    expect(stored.payer).to.equal(customer.address);
    expect(stored.amountPaid).to.equal(fxrpOwed);
    expect(await invoice.escrowOf(invoiceId)).to.equal(fxrpOwed);

    // --- Settlement: the merchant ends up holding real FXRP -----------------
    const merchantBefore: bigint = await fxrp.balanceOf(merchant.address);

    await expect(settlement.settleInvoice(invoiceId))
      .to.emit(settlement, "InvoiceSettled")
      .withArgs(invoiceId, merchant.address, merchant.address, FXRP, fxrpOwed)
      .and.to.emit(settlement, "SettlementPriceSnapshot");

    expect(await fxrp.balanceOf(merchant.address)).to.equal(
      merchantBefore + fxrpOwed,
      "merchant did not receive the escrowed FXRP",
    );
    expect(await fxrp.balanceOf(invoiceAddress)).to.equal(
      escrowBalanceBefore,
      "escrow was not fully drained",
    );
    expect((await invoice.getInvoice(invoiceId)).status).to.equal(3n); // SETTLED
    expect(await settlement.isSettled(invoiceId)).to.equal(true);

    console.log(
      `      settled ${ethers.formatUnits(fxrpOwed, 6)} FXRP to merchant ${merchant.address}`,
    );
  });

  // -------------------------------------------------------------------
  // Payment asset ≠ settlement asset, priced entirely on-chain (§3.10, §6.18)
  // -------------------------------------------------------------------

  it("computes the FXRP → USDT0 settlement figure from two live FTSO feeds", async () => {
    const contracts = await deployFluxaOnFork(MAX_PRICE_AGE);
    const { priceOracle } = contracts;
    await enableAsset(contracts, FXRP, FEED_IDS["XRP/USD"]);
    await enableAsset(contracts, USDT0, FEED_IDS["USDT/USD"]);

    // The interoperability claim in §3.10: the customer pays FXRP, the merchant
    // wants USDT0, and the conversion needs no DEX and no liquidity pool because
    // both legs are priced by Flare's own oracle. Phase 0 confirmed USDT/USD
    // exists on Coston2, which is what makes this computable on-chain at all.
    const fxrpOwed = await priceOracle.quoteTokenAmount(FXRP, INVOICE_USD);

    // What the escrowed FXRP is worth, then what that buys in USDT0.
    const usdValueOfEscrow = await priceOracle.quoteUsdValue(FXRP, fxrpOwed);
    const usdt0Owed = await priceOracle.quoteTokenAmount(USDT0, usdValueOfEscrow);

    const [fxrpPrice, fxrpDp] = await priceOracle.getPriceUsd(FXRP);
    const [usdtPrice, usdtDp] = await priceOracle.getPriceUsd(USDT0);

    console.log(
      `      pay     ${ethers.formatUnits(fxrpOwed, 6)} FXRP  @ $${ethers.formatUnits(fxrpPrice, Number(fxrpDp))}`,
    );
    console.log(
      `      settle  ${ethers.formatUnits(usdt0Owed, 6)} USDT0 @ $${ethers.formatUnits(usdtPrice, Number(usdtDp))}`,
    );

    // Both legs land on the same $500, within the rounding the quote helpers
    // deliberately introduce (they round down; see FluxaQuote).
    expect(Number(ethers.formatUnits(usdValueOfEscrow, 6))).to.be.closeTo(500, 0.01);
    expect(Number(ethers.formatUnits(usdt0Owed, 6))).to.be.closeTo(500, 1);

    // USDT0 is a stablecoin but not exactly $1.00 — 0.999032 at Phase 0. The
    // settlement figure must reflect that rather than treating USDT0 as par, so
    // it should differ from the naive 500.000000 by a small amount.
    expect(usdt0Owed).to.not.equal(500_000_000n);
  });

  it("recognises USDT0 as a settlement asset with real 6-decimal balances", async () => {
    // The settlement side of the demo scenario needs a real USDT0 holder to exist
    // and to be 6-decimal, otherwise cross-asset settlement in Sprint 4 will be
    // built against an assumption.
    const usdt0 = erc20At(USDT0);

    expect(Number(await usdt0.decimals())).to.equal(COSTON2_TOKENS.USDT0.decimals);
    expect(await usdt0.symbol()).to.equal(COSTON2_TOKENS.USDT0.onChainSymbol);

    const { signer: holder, balance } = await findFundedHolder(
      USDT0,
      USDT0_HOLDERS,
      1_000_000_000n, // 1,000.000000 USDT0
    );

    console.log(
      `      ${await usdt0.symbol()} holder ${holder.address}: ${ethers.formatUnits(balance, 6)}`,
    );
    expect(balance).to.be.greaterThan(0n);
  });

  it("still refuses a live Flare token Fluxa has not allowlisted", async () => {
    // WNat is real, has code, and FTSOv2 can price it. None of that is sufficient:
    // what bounds Fluxa is the allowlist, and this proves the boundary holds
    // against a genuine token rather than a mock.
    const contracts = await deployFluxaOnFork(MAX_PRICE_AGE);
    const { invoice, merchant } = contracts;
    await enableAsset(contracts, FXRP, FEED_IDS["XRP/USD"]);

    const wnat = ethers.getAddress(COSTON2_PROTOCOL.WNat);
    expect(await ethers.provider.getCode(wnat)).to.not.equal("0x");

    const dueAt = (await time.latest()) + 7 * 24 * 60 * 60;
    await expect(
      invoice.connect(merchant).createInvoice(wnat, 1_000_000n, dueAt, ethers.ZeroHash),
    )
      .to.be.revertedWithCustomError(invoice, "TokenNotAccepted")
      .withArgs(wnat);
  });
});
