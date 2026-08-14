import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

import { FEED_IDS, encodeFeedId } from "../config/flare";
import {
  AMOUNT,
  MAX_PRICE_AGE,
  PRICE_FLR,
  PRICE_USDT,
  PRICE_XRP,
  TOKEN_DECIMALS,
  USD_DECIMALS,
  deployOracleFixture,
} from "./fixtures";

/**
 * FluxaPriceOracle and FluxaQuote.
 *
 * The doc's Sprint 3 acceptance list for price retrieval is four items: price
 * retrieval, price conversion, invalid price handling, and stale/invalid data
 * handling. Each has its own describe block below. Three things are tested
 * beyond that list because they are where this contract can actually be wrong:
 *
 *   - per-feed decimals, since FTSOv2's scale differs between feeds and a
 *     single hardcoded scale would pass every test that only used one token;
 *   - the registry indirection, since a cached or misresolved FtsoV2 address
 *     fails silently rather than loudly;
 *   - the fee-paying path, since Coston2's fee is zero and the live network
 *     therefore cannot exercise the branch that matters if it ever isn't.
 */
describe("FluxaPriceOracle", () => {
  const CANONICAL_REGISTRY = "0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019";

  describe("deployment and configuration", () => {
    it("records the registry as immutable and the staleness threshold", async () => {
      const { priceOracle, registry, owner } =
        await loadFixture(deployOracleFixture);

      expect(await priceOracle.registry()).to.equal(await registry.getAddress());
      expect(await priceOracle.maxPriceAge()).to.equal(MAX_PRICE_AGE);
      expect(await priceOracle.owner()).to.equal(owner.address);
      expect(await priceOracle.USD_DECIMALS()).to.equal(USD_DECIMALS);
    });

    it("exposes the canonical registry address for a deployment to assert against", async () => {
      const { priceOracle } = await loadFixture(deployOracleFixture);

      // The value the deploy script checks the constructor argument against, so
      // a wrong registry is caught at deploy time rather than at first read.
      expect(await priceOracle.CANONICAL_FLARE_REGISTRY()).to.equal(
        CANONICAL_REGISTRY,
      );
    });

    it("rejects a zero registry and a zero staleness threshold", async () => {
      const { owner } = await loadFixture(deployOracleFixture);
      const FluxaPriceOracle =
        await ethers.getContractFactory("FluxaPriceOracle");

      await expect(
        FluxaPriceOracle.deploy(owner.address, ethers.ZeroAddress, MAX_PRICE_AGE),
      ).to.be.revertedWithCustomError(FluxaPriceOracle, "ZeroAddress");

      await expect(
        FluxaPriceOracle.deploy(
          owner.address,
          CANONICAL_REGISTRY,
          0,
        ),
      ).to.be.revertedWithCustomError(FluxaPriceOracle, "ZeroMaxPriceAge");
    });

    it("rejects a zero owner via Ownable, not a check of its own", async () => {
      const { registry } = await loadFixture(deployOracleFixture);
      const FluxaPriceOracle =
        await ethers.getContractFactory("FluxaPriceOracle");

      await expect(
        FluxaPriceOracle.deploy(
          ethers.ZeroAddress,
          await registry.getAddress(),
          MAX_PRICE_AGE,
        ),
      ).to.be.revertedWithCustomError(FluxaPriceOracle, "OwnableInvalidOwner");
    });

    it("resolves FtsoV2 and FeeCalculator through the registry", async () => {
      const { priceOracle, ftso, feeCalculator } =
        await loadFixture(deployOracleFixture);

      expect(await priceOracle.ftsoV2Address()).to.equal(
        await ftso.getAddress(),
      );
      expect(await priceOracle.feeCalculatorAddress()).to.equal(
        await feeCalculator.getAddress(),
      );
    });

    it("follows the registry when it is repointed, rather than caching", async () => {
      const { priceOracle, registry, fxrp } =
        await loadFixture(deployOracleFixture);

      // Flare redeploys protocol contracts and updates the registry; that is
      // what the registry is for. An oracle that cached the address at
      // construction would keep reading an abandoned contract.
      const MockFtsoV2 = await ethers.getContractFactory("MockFtsoV2");
      const replacement = await MockFtsoV2.deploy();
      await replacement.setFeed(
        FEED_IDS["XRP/USD"],
        9_990_000n,
        6,
        BigInt(await time.latest()),
      );
      await registry.setAddress("FtsoV2", await replacement.getAddress());

      expect(await priceOracle.ftsoV2Address()).to.equal(
        await replacement.getAddress(),
      );

      const [value] = await priceOracle.getPriceUsd(await fxrp.getAddress());
      expect(value).to.equal(9_990_000n);
    });

    it("reverts with the missing key when the registry has no such contract", async () => {
      const { priceOracle, registry, fxrp } =
        await loadFixture(deployOracleFixture);

      // The real registry returns address(0) for an unknown name rather than
      // reverting, so an unchecked result becomes a call to the zero address —
      // which fails with no revert data and nothing to debug.
      await registry.setAddress("FtsoV2", ethers.ZeroAddress);

      await expect(priceOracle.getPriceUsd(await fxrp.getAddress()))
        .to.be.revertedWithCustomError(priceOracle, "RegistryLookupFailed")
        .withArgs(ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["string"], ["FtsoV2"])));
    });
  });

  describe("feed configuration", () => {
    it("maps a token to a feed id and emits", async () => {
      const { priceOracle, owner, stray } =
        await loadFixture(deployOracleFixture);
      const token = await stray.getAddress();

      await expect(
        priceOracle.connect(owner).setFeed(token, FEED_IDS["FLR/USD"]),
      )
        .to.emit(priceOracle, "FeedConfigured")
        .withArgs(token, FEED_IDS["FLR/USD"]);

      expect(await priceOracle.feedIdFor(token)).to.equal(FEED_IDS["FLR/USD"]);
      expect(await priceOracle.hasFeed(token)).to.equal(true);
    });

    it("derives the same feed ids the config file hardcodes", async () => {
      // Guards the mapping itself: if encodeFeedId and the literals disagree,
      // every price in this suite is being read from the wrong feed.
      expect(encodeFeedId("XRP/USD")).to.equal(FEED_IDS["XRP/USD"]);
      expect(encodeFeedId("USDT/USD")).to.equal(FEED_IDS["USDT/USD"]);
      expect(encodeFeedId("FLR/USD")).to.equal(FEED_IDS["FLR/USD"]);
    });

    it("rejects a zero token or a zero feed id", async () => {
      const { priceOracle, owner, stray } =
        await loadFixture(deployOracleFixture);

      await expect(
        priceOracle.connect(owner).setFeed(ethers.ZeroAddress, FEED_IDS["XRP/USD"]),
      ).to.be.revertedWithCustomError(priceOracle, "ZeroAddress");

      await expect(
        priceOracle
          .connect(owner)
          .setFeed(await stray.getAddress(), ethers.zeroPadValue("0x", 21)),
      ).to.be.revertedWithCustomError(priceOracle, "ZeroFeedId");
    });

    it("removes a feed and then refuses to price that token", async () => {
      const { priceOracle, owner, fxrp } =
        await loadFixture(deployOracleFixture);
      const token = await fxrp.getAddress();

      await expect(priceOracle.connect(owner).removeFeed(token))
        .to.emit(priceOracle, "FeedRemoved")
        .withArgs(token);

      expect(await priceOracle.hasFeed(token)).to.equal(false);
      await expect(priceOracle.getPriceUsd(token))
        .to.be.revertedWithCustomError(priceOracle, "FeedNotConfigured")
        .withArgs(token);
    });

    it("will not remove a feed that was never configured", async () => {
      const { priceOracle, owner, stray } =
        await loadFixture(deployOracleFixture);

      await expect(priceOracle.connect(owner).removeFeed(await stray.getAddress()))
        .to.be.revertedWithCustomError(priceOracle, "FeedNotConfigured")
        .withArgs(await stray.getAddress());
    });

    it("changes the staleness threshold and emits both values", async () => {
      const { priceOracle, owner } = await loadFixture(deployOracleFixture);

      await expect(priceOracle.connect(owner).setMaxPriceAge(300))
        .to.emit(priceOracle, "MaxPriceAgeChanged")
        .withArgs(MAX_PRICE_AGE, 300);

      expect(await priceOracle.maxPriceAge()).to.equal(300);

      await expect(
        priceOracle.connect(owner).setMaxPriceAge(0),
      ).to.be.revertedWithCustomError(priceOracle, "ZeroMaxPriceAge");
    });

    it("restricts every configuration call to the owner", async () => {
      const { priceOracle, other, fxrp } =
        await loadFixture(deployOracleFixture);
      const token = await fxrp.getAddress();

      for (const call of [
        priceOracle.connect(other).setFeed(token, FEED_IDS["FLR/USD"]),
        priceOracle.connect(other).removeFeed(token),
        priceOracle.connect(other).setMaxPriceAge(300),
      ]) {
        await expect(call)
          .to.be.revertedWithCustomError(priceOracle, "OwnableUnauthorizedAccount")
          .withArgs(other.address);
      }
    });
  });

  describe("price retrieval", () => {
    it("returns value, decimals and timestamp from FTSOv2", async () => {
      const { priceOracle, fxrp, publishedAt } =
        await loadFixture(deployOracleFixture);

      const [value, decimals, timestamp] = await priceOracle.getPriceUsd(
        await fxrp.getAddress(),
      );

      expect(value).to.equal(PRICE_XRP.value);
      expect(decimals).to.equal(PRICE_XRP.decimals);
      expect(timestamp).to.equal(publishedAt);
    });

    it("reads a payable FTSOv2 through the view interface", async () => {
      const { priceOracle, fxrp } = await loadFixture(deployOracleFixture);

      // The design hinges on this. FtsoV2Interface.getFeedById is payable, so a
      // view function cannot call it — that is a compile error, not a runtime
      // nuance. TestFtsoV2Interface declares the identical read as view and the
      // registry resolves both under keccak256(abi.encode("FtsoV2")), so the two
      // address the same deployed contract. This asserts the staticcall really
      // does reach a payable implementation, which is what lets getPriceUsd
      // satisfy an interface settlement calls from a view context.
      const asView = priceOracle.interface.getFunction("getPriceUsd");
      expect(asView.stateMutability).to.equal("view");

      // A genuine eth_call with no transaction behind it.
      const result = await ethers.provider.call({
        to: await priceOracle.getAddress(),
        data: priceOracle.interface.encodeFunctionData("getPriceUsd", [
          await fxrp.getAddress(),
        ]),
      });
      const [value] = priceOracle.interface.decodeFunctionResult(
        "getPriceUsd",
        result,
      );
      expect(value).to.equal(PRICE_XRP.value);
    });

    it("keeps each feed's own decimals rather than one global scale", async () => {
      const { priceOracle, owner, ftso, fxrp, stray } =
        await loadFixture(deployOracleFixture);

      // XRP/USD publishes at 6dp and FLR/USD at 8dp on Coston2. An oracle that
      // assumed one scale would misprice the other by 100x.
      await priceOracle
        .connect(owner)
        .setFeed(await stray.getAddress(), FEED_IDS["FLR/USD"]);
      await ftso.setFeed(
        FEED_IDS["FLR/USD"],
        PRICE_FLR.value,
        PRICE_FLR.decimals,
        BigInt(await time.latest()),
      );

      const [, xrpDecimals] = await priceOracle.getPriceUsd(
        await fxrp.getAddress(),
      );
      const [flrValue, flrDecimals] = await priceOracle.getPriceUsd(
        await stray.getAddress(),
      );

      expect(xrpDecimals).to.equal(6);
      expect(flrDecimals).to.equal(8);
      expect(flrValue).to.equal(PRICE_FLR.value);
    });
  });

  describe("invalid price handling", () => {
    it("rejects a token with no feed", async () => {
      const { priceOracle, stray } = await loadFixture(deployOracleFixture);

      await expect(priceOracle.getPriceUsd(await stray.getAddress()))
        .to.be.revertedWithCustomError(priceOracle, "FeedNotConfigured")
        .withArgs(await stray.getAddress());
    });

    it("rejects a zero price rather than treating it as free", async () => {
      const { priceOracle, ftso, fxrp } = await loadFixture(deployOracleFixture);

      // Zero means "no data" in every oracle Fluxa reads. Passing it through
      // would make quoteTokenAmount divide by zero, or worse, succeed.
      await ftso.setFeed(FEED_IDS["XRP/USD"], 0, 6, BigInt(await time.latest()));

      await expect(priceOracle.getPriceUsd(await fxrp.getAddress()))
        .to.be.revertedWithCustomError(priceOracle, "PriceIsZero")
        .withArgs(await fxrp.getAddress());
    });

    it("propagates an FTSOv2 failure instead of substituting a value", async () => {
      const { priceOracle, ftso, fxrp } = await loadFixture(deployOracleFixture);

      await ftso.setShouldRevert(true);

      await expect(
        priceOracle.getPriceUsd(await fxrp.getAddress()),
      ).to.be.revertedWithCustomError(ftso, "MockOracleDown");
    });

    it("propagates an unknown feed id from FTSOv2", async () => {
      const { priceOracle, owner, ftso, stray } =
        await loadFixture(deployOracleFixture);

      // Configured on Fluxa's side but never published on FTSOv2's — the shape
      // of a typo in a feed id.
      await priceOracle
        .connect(owner)
        .setFeed(await stray.getAddress(), encodeFeedId("NOPE/USD"));

      await expect(priceOracle.getPriceUsd(await stray.getAddress()))
        .to.be.revertedWithCustomError(ftso, "FeedUnavailable")
        .withArgs(encodeFeedId("NOPE/USD"));
    });
  });

  describe("stale data handling", () => {
    it("accepts a price at the edge of the window", async () => {
      const { priceOracle, fxrp, publishedAt } =
        await loadFixture(deployOracleFixture);

      // Exactly maxPriceAge old is still inside the window; the check is
      // strictly-older-than, and off-by-one here would reject fresh prices
      // roughly every other block.
      await time.increaseTo(publishedAt + MAX_PRICE_AGE);

      const [value] = await priceOracle.getPriceUsd(await fxrp.getAddress());
      expect(value).to.equal(PRICE_XRP.value);
    });

    it("rejects a price one second past the window", async () => {
      const { priceOracle, fxrp, publishedAt } =
        await loadFixture(deployOracleFixture);

      await time.increaseTo(publishedAt + MAX_PRICE_AGE + 1n);

      await expect(priceOracle.getPriceUsd(await fxrp.getAddress()))
        .to.be.revertedWithCustomError(priceOracle, "PriceIsStale")
        .withArgs(
          await fxrp.getAddress(),
          publishedAt,
          publishedAt + 1n,
        );
    });

    it("accepts the same price again once the threshold is widened", async () => {
      const { priceOracle, owner, fxrp, publishedAt } =
        await loadFixture(deployOracleFixture);

      await time.increaseTo(publishedAt + 600n);
      await expect(
        priceOracle.getPriceUsd(await fxrp.getAddress()),
      ).to.be.revertedWithCustomError(priceOracle, "PriceIsStale");

      await priceOracle.connect(owner).setMaxPriceAge(3600);

      const [value] = await priceOracle.getPriceUsd(await fxrp.getAddress());
      expect(value).to.equal(PRICE_XRP.value);
    });

    it("does not underflow when the chain is younger than the window", async () => {
      const { owner, registry, ftso, fxrp } =
        await loadFixture(deployOracleFixture);

      // block.timestamp - maxPriceAge underflows if the threshold exceeds the
      // chain's age. Unreachable on Coston2, trivially reachable on a fresh
      // local chain, and an unchecked subtraction would revert with a panic
      // rather than a price.
      const FluxaPriceOracle =
        await ethers.getContractFactory("FluxaPriceOracle");
      const wide = await FluxaPriceOracle.deploy(
        owner.address,
        await registry.getAddress(),
        10n ** 12n,
      );
      await wide.connect(owner).setFeed(await fxrp.getAddress(), FEED_IDS["XRP/USD"]);
      await ftso.setFeed(FEED_IDS["XRP/USD"], PRICE_XRP.value, 6, 1);

      const [value] = await wide.getPriceUsd(await fxrp.getAddress());
      expect(value).to.equal(PRICE_XRP.value);
    });
  });

  describe("price conversion", () => {
    it("converts a USD invoice total to token base units", async () => {
      const { priceOracle, fxrp } = await loadFixture(deployOracleFixture);

      // $500.000000 at $2.50/XRP is 200.000000 FXRP.
      const amount = await priceOracle.quoteTokenAmount(
        await fxrp.getAddress(),
        500_000_000n,
      );
      expect(amount).to.equal(200_000_000n);
    });

    it("converts a stablecoin one-for-one", async () => {
      const { priceOracle, usdt } = await loadFixture(deployOracleFixture);

      // USDT/USD at 1.000000 and a 6dp token: the USD figure and the token
      // figure are the same number. Worth asserting, because it is the case
      // where a scaling bug is invisible.
      const amount = await priceOracle.quoteTokenAmount(
        await usdt.getAddress(),
        AMOUNT,
      );
      expect(amount).to.equal(AMOUNT);
      expect(PRICE_USDT.value).to.equal(1_000_000n);
    });

    it("reads the token's own decimals rather than assuming", async () => {
      const { priceOracle, owner, ftso } = await loadFixture(deployOracleFixture);

      // An 18dp token on a 6dp feed. If quoteTokenAmount assumed 6dp it would
      // return a number 10^12 too small — and the merchant would be paid a
      // millionth of a millionth of what the invoice says.
      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const wrapped = await MockERC20.deploy("Wrapped XRP", "WXRP", 18);
      const token = await wrapped.getAddress();

      await priceOracle.connect(owner).setFeed(token, FEED_IDS["XRP/USD"]);
      await ftso.setFeed(
        FEED_IDS["XRP/USD"],
        PRICE_XRP.value,
        6,
        BigInt(await time.latest()),
      );

      expect(await wrapped.decimals()).to.equal(18);
      expect(await priceOracle.quoteTokenAmount(token, 500_000_000n)).to.equal(
        200n * 10n ** 18n,
      );
    });

    it("converts a token balance back to USD", async () => {
      const { priceOracle, fxrp } = await loadFixture(deployOracleFixture);

      // 200.000000 FXRP at $2.50 is $500.000000.
      expect(
        await priceOracle.quoteUsdValue(await fxrp.getAddress(), 200_000_000n),
      ).to.equal(500_000_000n);
    });

    it("refuses to quote a stale or zero price", async () => {
      const { priceOracle, ftso, fxrp, publishedAt } =
        await loadFixture(deployOracleFixture);
      const token = await fxrp.getAddress();

      // Conversion is not a second, softer path to a price: it goes through the
      // same validation, so a stale feed cannot set an invoice amount.
      await ftso.setFeed(FEED_IDS["XRP/USD"], 0, 6, BigInt(await time.latest()));
      await expect(
        priceOracle.quoteTokenAmount(token, 500_000_000n),
      ).to.be.revertedWithCustomError(priceOracle, "PriceIsZero");
      await expect(
        priceOracle.quoteUsdValue(token, 200_000_000n),
      ).to.be.revertedWithCustomError(priceOracle, "PriceIsZero");

      await ftso.setFeed(FEED_IDS["XRP/USD"], PRICE_XRP.value, 6, publishedAt);
      await time.increaseTo(publishedAt + MAX_PRICE_AGE + 60n);
      await expect(
        priceOracle.quoteTokenAmount(token, 500_000_000n),
      ).to.be.revertedWithCustomError(priceOracle, "PriceIsStale");
      await expect(
        priceOracle.quoteUsdValue(token, 200_000_000n),
      ).to.be.revertedWithCustomError(priceOracle, "PriceIsStale");
    });

    it("refuses to quote a token with no feed", async () => {
      const { priceOracle, stray } = await loadFixture(deployOracleFixture);

      await expect(
        priceOracle.quoteTokenAmount(await stray.getAddress(), 500_000_000n),
      ).to.be.revertedWithCustomError(priceOracle, "FeedNotConfigured");
    });
  });

  describe("the fee-paying path", () => {
    it("reports a zero fee when FTSOv2 charges nothing", async () => {
      const { priceOracle, fxrp } = await loadFixture(deployOracleFixture);

      // Zero on Coston2 today. Exposed so it is checked rather than assumed.
      expect(await priceOracle.feeForToken(await fxrp.getAddress())).to.equal(0);
    });

    it("reports the FeeCalculator's fee for a configured feed", async () => {
      const { priceOracle, feeCalculator, fxrp } =
        await loadFixture(deployOracleFixture);

      await feeCalculator.setFeePerFeed(1_000n);
      expect(await priceOracle.feeForToken(await fxrp.getAddress())).to.equal(
        1_000n,
      );
    });

    it("reads through the payable interface when a fee applies", async () => {
      const { priceOracle, feeCalculator, ftso, fxrp, customer } =
        await loadFixture(deployOracleFixture);

      await feeCalculator.setFeePerFeed(1_000n);

      const [value, decimals] = await priceOracle
        .connect(customer)
        .getPriceUsdPaying.staticCall(await fxrp.getAddress(), {
          value: 1_000n,
        });

      expect(value).to.equal(PRICE_XRP.value);
      expect(decimals).to.equal(PRICE_XRP.decimals);

      // And the fee actually reaches FTSOv2 rather than being held here.
      await priceOracle
        .connect(customer)
        .getPriceUsdPaying(await fxrp.getAddress(), { value: 1_000n });

      expect(await ethers.provider.getBalance(await ftso.getAddress())).to.equal(
        1_000n,
      );
      expect(
        await ethers.provider.getBalance(await priceOracle.getAddress()),
      ).to.equal(0);
    });

    it("rejects an underpaid fee", async () => {
      const { priceOracle, feeCalculator, fxrp, customer } =
        await loadFixture(deployOracleFixture);

      await feeCalculator.setFeePerFeed(1_000n);

      await expect(
        priceOracle
          .connect(customer)
          .getPriceUsdPaying(await fxrp.getAddress(), { value: 999n }),
      )
        .to.be.revertedWithCustomError(priceOracle, "FeeNotCovered")
        .withArgs(1_000n, 999n);
    });

    it("refunds the surplus rather than keeping it", async () => {
      const { priceOracle, feeCalculator, ftso, fxrp, customer } =
        await loadFixture(deployOracleFixture);

      await feeCalculator.setFeePerFeed(1_000n);

      const before = await ethers.provider.getBalance(customer.address);
      const tx = await priceOracle
        .connect(customer)
        .getPriceUsdPaying(await fxrp.getAddress(), { value: 5_000n });
      const receipt = await tx.wait();
      const gas = receipt!.gasUsed * receipt!.gasPrice;
      const after = await ethers.provider.getBalance(customer.address);

      // Paid the fee and the gas; the other 4,000 came back.
      expect(before - after - gas).to.equal(1_000n);
      expect(await ethers.provider.getBalance(await ftso.getAddress())).to.equal(
        1_000n,
      );
      expect(
        await ethers.provider.getBalance(await priceOracle.getAddress()),
      ).to.equal(0);
    });

    it("reverts rather than keeping a refund the caller cannot accept", async () => {
      const { priceOracle, feeCalculator, fxrp } =
        await loadFixture(deployOracleFixture);

      await feeCalculator.setFeePerFeed(1_000n);

      // A contract caller with no receive function. The alternative to reverting
      // here is this oracle silently accumulating other people's surplus.
      const RefundRejector = await ethers.getContractFactory("RefundRejector");
      const rejector = await RefundRejector.deploy({ value: 10_000n });

      await expect(
        rejector.read(
          await priceOracle.getAddress(),
          await fxrp.getAddress(),
          5_000n,
        ),
      )
        .to.be.revertedWithCustomError(priceOracle, "RefundFailed")
        .withArgs(await rejector.getAddress(), 4_000n);

      // An exact payment needs no refund, so the same caller succeeds.
      await expect(
        rejector.read(
          await priceOracle.getAddress(),
          await fxrp.getAddress(),
          1_000n,
        ),
      ).to.not.be.reverted;
    });

    it("validates the price on the paying path too", async () => {
      const { priceOracle, ftso, fxrp, customer, publishedAt } =
        await loadFixture(deployOracleFixture);

      await ftso.setFeed(FEED_IDS["XRP/USD"], 0, 6, publishedAt);
      await expect(
        priceOracle
          .connect(customer)
          .getPriceUsdPaying(await fxrp.getAddress()),
      ).to.be.revertedWithCustomError(priceOracle, "PriceIsZero");

      await ftso.setFeed(FEED_IDS["XRP/USD"], PRICE_XRP.value, 6, publishedAt);
      await time.increaseTo(publishedAt + MAX_PRICE_AGE + 60n);
      await expect(
        priceOracle
          .connect(customer)
          .getPriceUsdPaying(await fxrp.getAddress()),
      ).to.be.revertedWithCustomError(priceOracle, "PriceIsStale");
    });

    it("refuses a token with no feed before touching the fee calculator", async () => {
      const { priceOracle, stray, customer } =
        await loadFixture(deployOracleFixture);

      await expect(
        priceOracle
          .connect(customer)
          .getPriceUsdPaying(await stray.getAddress()),
      )
        .to.be.revertedWithCustomError(priceOracle, "FeedNotConfigured")
        .withArgs(await stray.getAddress());

      await expect(
        priceOracle.feeForToken(await stray.getAddress()),
      ).to.be.revertedWithCustomError(priceOracle, "FeedNotConfigured");
    });
  });

  describe("settlement reads real prices through the Sprint 2 seam", () => {
    it("snapshots the live FTSOv2 price when an invoice settles", async () => {
      const fixture = await loadFixture(deployOracleFixture);
      const { priceOracle, settlement, invoice, owner, merchant, customer, usdt } =
        fixture;

      // The whole point of the IPriceOracle seam: settlement gains real prices
      // by having its oracle address set, with no settlement code changing.
      await settlement
        .connect(owner)
        .setPriceOracle(await priceOracle.getAddress());

      const dueAt = (await time.latest()) + 7 * 24 * 60 * 60;
      await invoice
        .connect(merchant)
        .createInvoice(
          await usdt.getAddress(),
          AMOUNT,
          dueAt,
          ethers.keccak256(ethers.toUtf8Bytes("oracle-settle")),
        );
      await invoice.connect(customer).payInvoice(1n);

      await expect(settlement.connect(merchant).settleInvoice(1n))
        .to.emit(settlement, "SettlementPriceSnapshot")
        .withArgs(
          1n,
          await usdt.getAddress(),
          PRICE_USDT.value,
          PRICE_USDT.decimals,
          fixture.publishedAt,
        );

      expect(await usdt.balanceOf(merchant.address)).to.be.greaterThan(0);
    });

    it("still settles when the price is stale, because the snapshot is evidence", async () => {
      const { priceOracle, settlement, invoice, owner, merchant, customer, usdt } =
        await loadFixture(deployOracleFixture);

      await settlement
        .connect(owner)
        .setPriceOracle(await priceOracle.getAddress());

      const dueAt = (await time.latest()) + 30 * 24 * 60 * 60;
      await invoice
        .connect(merchant)
        .createInvoice(
          await usdt.getAddress(),
          AMOUNT,
          dueAt,
          ethers.keccak256(ethers.toUtf8Bytes("stale-settle")),
        );
      await invoice.connect(customer).payInvoice(1n);

      // Push past the staleness window so the oracle reverts.
      await time.increase(MAX_PRICE_AGE + 60n);
      await expect(
        priceOracle.getPriceUsd(await usdt.getAddress()),
      ).to.be.revertedWithCustomError(priceOracle, "PriceIsStale");

      // Settlement moves escrow that is already sitting there in a token the
      // invoice named; the price is recorded alongside it, not used to compute
      // it. A price Fluxa will not vouch for means no snapshot, not a merchant
      // locked out of their own money.
      const before = await usdt.balanceOf(merchant.address);
      await expect(settlement.connect(merchant).settleInvoice(1n)).to.not.emit(
        settlement,
        "SettlementPriceSnapshot",
      );
      expect(await usdt.balanceOf(merchant.address)).to.equal(before + AMOUNT);
    });

    it("quotes the token amount a USD-denominated invoice would need", async () => {
      const { priceOracle, fxrp, usdt } = await loadFixture(deployOracleFixture);

      // What the frontend will call before creating an invoice: the amount is
      // derived from a price the contract read itself, so a client that quotes
      // the wrong number produces a payment the contract rejects rather than a
      // merchant who is quietly underpaid.
      const usdTotal = 1_234_560_000n; // $1,234.56
      const inXrp = await priceOracle.quoteTokenAmount(
        await fxrp.getAddress(),
        usdTotal,
      );
      const inUsdt = await priceOracle.quoteTokenAmount(
        await usdt.getAddress(),
        usdTotal,
      );

      expect(inXrp).to.equal(493_824_000n); // 1234.56 / 2.50
      expect(inUsdt).to.equal(usdTotal);
      expect(TOKEN_DECIMALS).to.equal(6);
    });
  });
});
