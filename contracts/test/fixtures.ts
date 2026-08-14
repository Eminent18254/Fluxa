import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

import { FEED_IDS } from "../config/flare";

/**
 * Shared deployment for the contract tests.
 *
 * Tokens are 6-decimal on purpose. FXRP and USDT0 on Coston2 are both 6-decimal
 * — confirmed on-chain in Phase 0, not assumed — so a suite that only ever
 * exercised an 18-decimal token would leave the real decimal path untested and
 * a 10^12 scaling error would pass green.
 */

/** 6 decimals, matching FXRP and USDT0 on Coston2. */
export const TOKEN_DECIMALS = 6;

/** 100.000000 tokens, in base units. */
export const AMOUNT = 100_000_000n;

/** 1,000,000.000000 tokens, in base units. */
export const MINT = 1_000_000_000_000n;

export const ONE_DAY = 24 * 60 * 60;
export const ONE_WEEK = 7 * ONE_DAY;
export const ONE_YEAR = 365 * ONE_DAY;

export const REF_A = ethers.keccak256(ethers.toUtf8Bytes("fluxa-ref-a"));
export const REF_B = ethers.keccak256(ethers.toUtf8Bytes("fluxa-ref-b"));
export const ZERO_REF = ethers.ZeroHash;

/** Mirrors FluxaTypes.Status. */
export const Status = {
  CREATED: 0n,
  PENDING: 1n,
  PAID: 2n,
  SETTLED: 3n,
  CANCELLED: 4n,
  EXPIRED: 5n,
} as const;

/** Mirrors FluxaTypes.Rail. */
export const Rail = {
  FLARE_ERC20: 0n,
  XRPL_NATIVE: 1n,
} as const;

/** A due date comfortably inside MAX_INVOICE_DURATION. */
export async function weekFromNow(): Promise<number> {
  return (await time.latest()) + ONE_WEEK;
}

export async function deployFluxaFixture() {
  const [owner, merchant, customer, other, keeper] = await ethers.getSigners();

  const MockERC20 = await ethers.getContractFactory("MockERC20");
  const usdt = await MockERC20.deploy("Fluxa USDT0", "USDT0", TOKEN_DECIMALS);
  const fxrp = await MockERC20.deploy("Fluxa FXRP", "FXRP", TOKEN_DECIMALS);
  const stray = await MockERC20.deploy("Not Accepted", "NOPE", TOKEN_DECIMALS);

  const FluxaInvoice = await ethers.getContractFactory("FluxaInvoice");
  const invoice = await FluxaInvoice.deploy(owner.address);

  const FluxaSettlement = await ethers.getContractFactory("FluxaSettlement");
  const settlement = await FluxaSettlement.deploy(
    owner.address,
    await invoice.getAddress(),
  );

  const MockPriceOracle = await ethers.getContractFactory("MockPriceOracle");
  const oracle = await MockPriceOracle.deploy();

  await invoice.connect(owner).setAcceptedToken(await usdt.getAddress(), true);
  await invoice.connect(owner).setAcceptedToken(await fxrp.getAddress(), true);
  await invoice
    .connect(owner)
    .setSettlementContract(await settlement.getAddress());

  // Everyone who might pay gets funded and approved, so a test that fails does
  // so because of the behaviour under test and not a missing allowance.
  for (const signer of [customer, other, keeper, merchant]) {
    await usdt.mint(signer.address, MINT);
    await fxrp.mint(signer.address, MINT);
    await usdt.connect(signer).approve(await invoice.getAddress(), MINT);
    await fxrp.connect(signer).approve(await invoice.getAddress(), MINT);
  }

  return {
    owner,
    merchant,
    customer,
    other,
    keeper,
    usdt,
    fxrp,
    stray,
    invoice,
    settlement,
    oracle,
  };
}

/** Fixture plus one CREATED invoice from `merchant` for AMOUNT of USDT0. */
export async function createdInvoiceFixture() {
  const base = await deployFluxaFixture();
  const dueAt = await weekFromNow();

  await base.invoice
    .connect(base.merchant)
    .createInvoice(await base.usdt.getAddress(), AMOUNT, dueAt, REF_A);

  return { ...base, invoiceId: 1n, dueAt };
}

/** Fixture plus one PAID invoice, paid by `customer`. */
export async function paidInvoiceFixture() {
  const base = await createdInvoiceFixture();
  await base.invoice.connect(base.customer).payInvoice(base.invoiceId);
  return base;
}

/**
 * Real FTSOv2 prices, at the decimals those feeds actually publish.
 *
 * XRP/USD is 6-decimal and FLR/USD is 8-decimal on Coston2 — confirmed in Phase
 * 0. Hardcoding one scale for both is the mistake these tests exist to catch, so
 * the fixture carries the difference.
 */
export const PRICE_XRP = { value: 2_500_000n, decimals: 6 };
export const PRICE_USDT = { value: 1_000_000n, decimals: 6 };
export const PRICE_FLR = { value: 2_100_000n, decimals: 8 };

/** FluxaPriceOracle's fixed USD scale. */
export const USD_DECIMALS = 6;

/** Two minutes. FTSOv2 publishes about every 90 seconds. */
export const MAX_PRICE_AGE = 120n;

/**
 * FluxaPriceOracle wired to a mock registry, FTSOv2 and FeeCalculator.
 *
 * The registry indirection is the point: the oracle resolves FtsoV2 by name on
 * every read, exactly as it will on Coston2, so these tests exercise the real
 * lookup path rather than a shortcut that only exists offline.
 */
export async function deployOracleFixture() {
  const base = await deployFluxaFixture();

  const MockFtsoV2 = await ethers.getContractFactory("MockFtsoV2");
  const ftso = await MockFtsoV2.deploy();

  const MockFeeCalculator = await ethers.getContractFactory("MockFeeCalculator");
  const feeCalculator = await MockFeeCalculator.deploy();

  const MockContractRegistry =
    await ethers.getContractFactory("MockContractRegistry");
  const registry = await MockContractRegistry.deploy();

  await registry.setAddress("FtsoV2", await ftso.getAddress());
  await registry.setAddress(
    "FeeCalculator",
    await feeCalculator.getAddress(),
  );

  const FluxaPriceOracle = await ethers.getContractFactory("FluxaPriceOracle");
  const priceOracle = await FluxaPriceOracle.deploy(
    base.owner.address,
    await registry.getAddress(),
    MAX_PRICE_AGE,
  );

  await priceOracle
    .connect(base.owner)
    .setFeed(await base.fxrp.getAddress(), FEED_IDS["XRP/USD"]);
  await priceOracle
    .connect(base.owner)
    .setFeed(await base.usdt.getAddress(), FEED_IDS["USDT/USD"]);

  // Publish both feeds as of now, so reads are fresh unless a test ages them.
  const now = BigInt(await time.latest());
  await ftso.setFeed(
    FEED_IDS["XRP/USD"],
    PRICE_XRP.value,
    PRICE_XRP.decimals,
    now,
  );
  await ftso.setFeed(
    FEED_IDS["USDT/USD"],
    PRICE_USDT.value,
    PRICE_USDT.decimals,
    now,
  );

  return { ...base, ftso, feeCalculator, registry, priceOracle, publishedAt: now };
}

