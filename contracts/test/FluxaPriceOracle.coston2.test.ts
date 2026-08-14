import { expect } from "chai";
import { ethers } from "hardhat";
import { reset } from "@nomicfoundation/hardhat-network-helpers";

import {
  COSTON2,
  COSTON2_PROTOCOL,
  COSTON2_TOKENS,
  FEED_IDS,
  FLARE_CONTRACT_REGISTRY,
} from "../config/flare";

/**
 * FluxaPriceOracle against live Coston2 state.
 *
 * The offline suite proves the oracle's logic is right. It cannot prove the
 * integration is right: mocks agree with whatever assumption is built into them,
 * so a wrong feed id, a wrong registry key, or a decimal count that differs from
 * what Phase 0 recorded would all pass every test in `FluxaPriceOracle.test.ts`.
 *
 * This file forks Coston2 and deploys the real contract against the real
 * registry, so the FTSOv2 address, the feed ids, the per-feed decimals and the
 * fee are all read from the network rather than asserted from a config file.
 *
 * The central assertion is a cross-check: the oracle's answer must equal a direct
 * read of FTSOv2 through an independently constructed contract object. Comparing
 * the oracle against a number this repo hardcoded would only prove the config is
 * self-consistent.
 *
 * A fork needs network access, so the suite skips itself with a visible reason
 * when the RPC is unreachable rather than failing the offline test run.
 */
describe("FluxaPriceOracle on forked Coston2", () => {
  const MAX_PRICE_AGE = 300n;

  /** Phase 0 read these off-chain; here they are re-derived from the fork. */
  const EXPECTED_DECIMALS: Record<string, number> = {
    "XRP/USD": 6,
    "USDT/USD": 6,
    "USDC/USD": 6,
    "FLR/USD": 8,
  };

  let available = false;
  let skipReason = "";
  let forkBlock = 0;

  before(async function () {
    this.timeout(120_000);

    try {
      // The helpers' `reset` rather than a raw hardhat_reset: it also clears
      // loadFixture's snapshot registry. A bare hardhat_reset silently
      // invalidates every snapshot the other test files took, so whichever file
      // mocha loads next fails with InvalidSnapshotError — a failure that points
      // at the wrong test entirely.
      await reset(COSTON2.rpcUrl);

      // A fork that connects but has no registry code is not a Coston2 fork.
      const code = await ethers.provider.getCode(FLARE_CONTRACT_REGISTRY);
      if (code === "0x") {
        skipReason = `no registry code at ${FLARE_CONTRACT_REGISTRY} on the fork`;
        return;
      }

      forkBlock = await ethers.provider.getBlockNumber();
      available = true;
    } catch (error) {
      skipReason = `could not fork ${COSTON2.rpcUrl}: ${(error as Error).message}`;
    }
  });

  after(async () => {
    // Return the in-process network to a plain local chain, so a fork left in
    // place cannot make an unrelated test read Coston2 state — or pay for it.
    await reset();
  });

  beforeEach(function () {
    if (!available) {
      console.log(`      skipped: ${skipReason}`);
      this.skip();
    }
  });

  async function deployAgainstLiveRegistry() {
    const [deployer] = await ethers.getSigners();

    const FluxaPriceOracle = await ethers.getContractFactory("FluxaPriceOracle");
    const oracle = await FluxaPriceOracle.deploy(
      deployer.address,
      FLARE_CONTRACT_REGISTRY,
      MAX_PRICE_AGE,
    );
    await oracle.waitForDeployment();

    return { oracle, deployer };
  }

  it("forks a chain that identifies itself as Coston2", async () => {
    const chainId = Number((await ethers.provider.getNetwork()).chainId);

    // hardhat_reset keeps the local chainId, so assert on something that can only
    // come from the forked state: the registry's own code.
    expect(await ethers.provider.getCode(FLARE_CONTRACT_REGISTRY)).to.not.equal("0x");
    expect(forkBlock).to.be.greaterThan(0);
    console.log(`      forked at block ${forkBlock} (local chainId ${chainId})`);
  });

  it("resolves the same FtsoV2 address Phase 0 recorded", async () => {
    const { oracle } = await deployAgainstLiveRegistry();

    const resolved = await oracle.ftsoV2Address();
    const feeCalculator = await oracle.feeCalculatorAddress();

    console.log(`      FtsoV2        ${resolved}`);
    console.log(`      FeeCalculator ${feeCalculator}`);

    // If these ever drift, the config is stale and the comment in flare.ts that
    // calls them "reference only" is doing real work — the contract resolves
    // through the registry and keeps working, which is the point.
    expect(resolved).to.equal(
      ethers.getAddress(COSTON2_PROTOCOL.FtsoV2),
      "registry resolves a different FtsoV2 than config records",
    );
    expect(feeCalculator).to.equal(
      ethers.getAddress(COSTON2_PROTOCOL.FeeCalculator),
      "registry resolves a different FeeCalculator than config records",
    );
    expect(await ethers.provider.getCode(resolved)).to.not.equal("0x");
  });

  it("agrees with a direct read of FTSOv2 for every feed Fluxa uses", async () => {
    const { oracle, deployer } = await deployAgainstLiveRegistry();

    // The independent path: a contract object built from the address the registry
    // gave us, called directly. If the oracle and this disagree, the oracle is
    // transforming the price somewhere it should not.
    const ftso = await ethers.getContractAt(
      "TestFtsoV2Interface",
      await oracle.ftsoV2Address(),
    );

    // A throwaway 6-decimal token per feed, so quoteTokenAmount has something to
    // read decimals() from without depending on a real token's balance.
    const MockERC20 = await ethers.getContractFactory("MockERC20");

    for (const [feedName, feedId] of Object.entries(FEED_IDS)) {
      const token = await MockERC20.deploy(`Proxy ${feedName}`, "PXY", 6);
      await token.waitForDeployment();
      const tokenAddress = await token.getAddress();

      await (await oracle.connect(deployer).setFeed(tokenAddress, feedId)).wait();

      const [direct, directDecimals, directTimestamp] = await ftso.getFeedById(feedId);
      const [value, decimals, timestamp] = await oracle.getPriceUsd(tokenAddress);

      expect(value).to.equal(direct, `${feedName} value differs from a direct read`);
      expect(decimals).to.equal(
        directDecimals,
        `${feedName} decimals differ from a direct read`,
      );
      expect(timestamp).to.equal(
        directTimestamp,
        `${feedName} timestamp differs from a direct read`,
      );

      // Live data, so assert shape rather than an exact price.
      expect(value).to.be.greaterThan(0n, `${feedName} published a zero price`);
      expect(decimals).to.equal(
        EXPECTED_DECIMALS[feedName],
        `${feedName} decimals changed from what Phase 0 recorded`,
      );

      const usd = ethers.formatUnits(value, Number(decimals));
      console.log(`      ${feedName.padEnd(9)} $${usd} (${decimals}dp)`);
    }
  });

  it("proves the decimals really do differ between feeds", async () => {
    const { oracle, deployer } = await deployAgainstLiveRegistry();
    const ftso = await ethers.getContractAt(
      "TestFtsoV2Interface",
      await oracle.ftsoV2Address(),
    );

    // The single most likely mispricing in this system is treating one feed's
    // exponent as global. This asserts, against live data, that the two feeds
    // Fluxa cares most about genuinely publish at different scales — so any code
    // that hardcodes one of them is provably wrong rather than arguably wrong.
    const [, xrpDecimals] = await ftso.getFeedById(FEED_IDS["XRP/USD"]);
    const [, flrDecimals] = await ftso.getFeedById(FEED_IDS["FLR/USD"]);

    expect(xrpDecimals).to.equal(6);
    expect(flrDecimals).to.equal(8);
    expect(xrpDecimals).to.not.equal(flrDecimals);
    void deployer;
  });

  it("returns a price fresh enough to pass its own staleness check", async () => {
    const { oracle, deployer } = await deployAgainstLiveRegistry();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const token = await MockERC20.deploy("Proxy XRP", "PXRP", 6);
    await token.waitForDeployment();
    await (
      await oracle.connect(deployer).setFeed(await token.getAddress(), FEED_IDS["XRP/USD"])
    ).wait();

    // FTSOv2 publishes on ~90s voting rounds. That the read succeeds at all is
    // the assertion: getPriceUsd reverts with PriceIsStale otherwise, so a
    // returned value means the live feed is inside the 300s window.
    const [, , timestamp] = await oracle.getPriceUsd(await token.getAddress());
    const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
    const age = now - timestamp;

    console.log(`      XRP/USD is ${age}s old, window is ${MAX_PRICE_AGE}s`);
    expect(age).to.be.lessThanOrEqual(MAX_PRICE_AGE);
  });

  it("reads a zero fee from the live FeeCalculator, and still works via the paying path", async () => {
    const { oracle, deployer } = await deployAgainstLiveRegistry();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const token = await MockERC20.deploy("Proxy XRP", "PXRP", 6);
    await token.waitForDeployment();
    const tokenAddress = await token.getAddress();
    await (await oracle.connect(deployer).setFeed(tokenAddress, FEED_IDS["XRP/USD"])).wait();

    // This is what justifies reading through the view interface at all. If the
    // live fee were non-zero, getPriceUsd would revert and settlement's snapshot
    // would silently stop recording — so the zero is checked, not assumed.
    const fee = await oracle.feeForToken(tokenAddress);
    console.log(`      live FeeCalculator fee for XRP/USD: ${fee} wei`);
    expect(fee).to.equal(0n);

    // And the fee-forwarding path works against the real contract too, so it is
    // exercised code rather than a claim about what would happen.
    const [viaView] = await oracle.getPriceUsd(tokenAddress);
    const [viaPaying] = await oracle.getPriceUsdPaying.staticCall(tokenAddress, {
      value: fee,
    });
    expect(viaPaying).to.equal(viaView);
  });

  it("quotes real FXRP and USDT0 using their on-chain decimals", async () => {
    const { oracle, deployer } = await deployAgainstLiveRegistry();

    const ONE_HUNDRED_USD = 100_000_000n; // $100.000000

    for (const meta of Object.values(COSTON2_TOKENS)) {
      const token = await ethers.getContractAt("MockERC20", meta.address);

      // Read decimals off the live token rather than trusting the config. FXRP
      // and USDT0 are both 6dp — the assumption that FAssets are 18dp is the one
      // that would break every amount in the system.
      const onChainDecimals = Number(await token.decimals());
      expect(onChainDecimals).to.equal(
        meta.decimals,
        `${meta.symbol} on-chain decimals differ from config`,
      );

      await (
        await oracle
          .connect(deployer)
          .setFeed(meta.address, FEED_IDS[meta.feedId])
      ).wait();

      const [price, priceDecimals] = await oracle.getPriceUsd(meta.address);
      const quote = await oracle.quoteTokenAmount(meta.address, ONE_HUNDRED_USD);
      const back = await oracle.quoteUsdValue(meta.address, quote);

      const usdPerToken = Number(ethers.formatUnits(price, Number(priceDecimals)));
      const quoted = Number(ethers.formatUnits(quote, onChainDecimals));

      console.log(
        `      $100 = ${quoted} ${meta.symbol} at $${usdPerToken} (${onChainDecimals}dp token, ${priceDecimals}dp feed)`,
      );

      expect(quote).to.be.greaterThan(0n);

      // Sanity-check the quote against the price independently of the contract's
      // own arithmetic: quantity times unit price should come back to $100, give
      // or take the rounding this deliberately introduces.
      expect(quoted * usdPerToken).to.be.closeTo(100, 0.01);

      // And the round trip lands back at $100 within a base unit's worth.
      expect(Number(ethers.formatUnits(back, 6))).to.be.closeTo(100, 0.01);
    }
  });

  it("refuses a token the registry can price but Fluxa has not mapped", async () => {
    const { oracle } = await deployAgainstLiveRegistry();

    // Live FTSOv2 has a WNat feed; Fluxa still will not price a token it has not
    // been told about. Coverage against real infrastructure of the fact that the
    // mapping, not the oracle's reach, is what bounds what Fluxa will quote.
    await expect(oracle.getPriceUsd(COSTON2_PROTOCOL.WNat))
      .to.be.revertedWithCustomError(oracle, "FeedNotConfigured")
      .withArgs(ethers.getAddress(COSTON2_PROTOCOL.WNat));
  });
});
