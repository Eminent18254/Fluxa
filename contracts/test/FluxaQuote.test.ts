import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

/**
 * FluxaQuote — the arithmetic that decides how much money moves.
 *
 * These tests go through a harness rather than the oracle because the interesting
 * cases are decimal combinations, not oracle states. Reaching "8-decimal feed,
 * 18-decimal token, negative exponent" through `FluxaPriceOracle` would mean
 * deploying a token and publishing a feed for each one; here each is a single
 * call, which is the difference between covering them and skipping them.
 *
 * The numbers are checked against hand arithmetic in comments, not against a
 * second implementation of the same formula — a mirrored formula in TypeScript
 * would agree with a wrong Solidity formula on every case where both share the
 * same misunderstanding.
 */
describe("FluxaQuote", () => {
  async function harnessFixture() {
    const QuoteHarness = await ethers.getContractFactory("QuoteHarness");
    const quote = await QuoteHarness.deploy();
    return { quote };
  }

  describe("USD to token", () => {
    it("prices a 6-decimal token against a 6-decimal feed", async () => {
      const { quote } = await loadFixture(harnessFixture);

      // $500.000000 / $2.50 = 200.000000 FXRP. The FXRP/USDT0 case: both the
      // token and the XRP/USD feed are 6dp on Coston2.
      expect(
        await quote.tokenAmountForUsd(500_000_000n, 6, 2_500_000n, 6, 6),
      ).to.equal(200_000_000n);
    });

    it("prices an 18-decimal token against an 8-decimal feed", async () => {
      const { quote } = await loadFixture(harnessFixture);

      // FLR/USD publishes at 8dp: 2_100_000 is $0.021.
      // $500 / $0.021 = 23,809.523809523809523809... FLR, rounded up at the
      // eighteenth decimal.
      expect(
        await quote.tokenAmountForUsd(500_000_000n, 6, 2_100_000n, 8, 18),
      ).to.equal(23_809_523_809_523_809_523_810n);
    });

    it("prices a 0-decimal token", async () => {
      const { quote } = await loadFixture(harnessFixture);

      // $500 / $2.50 = 200 whole units, with no fractional part to hold a
      // remainder. The scale that breaks a formula written assuming 10**n > 1.
      expect(
        await quote.tokenAmountForUsd(500_000_000n, 6, 2_500_000n, 6, 0),
      ).to.equal(200n);
    });

    it("handles a negative price exponent", async () => {
      const { quote } = await loadFixture(harnessFixture);

      // FTSOv2 returns decimals as int8, and a feed whose value is large may
      // publish a negative exponent: value 25 at -1 decimals is $250.
      // $500 / $250 = 2.000000 tokens.
      expect(
        await quote.tokenAmountForUsd(500_000_000n, 6, 25n, -1, 6),
      ).to.equal(2_000_000n);
    });

    it("rounds up, so an invoice never settles short", async () => {
      const { quote } = await loadFixture(harnessFixture);

      // $1.000000 / $3.00 = 0.333333... The exact value is unrepresentable, and
      // rounding it down would leave every such invoice a base unit light.
      expect(
        await quote.tokenAmountForUsd(1_000_000n, 6, 3_000_000n, 6, 6),
      ).to.equal(333_334n);
    });

    it("does not round up when the division is exact", async () => {
      const { quote } = await loadFixture(harnessFixture);

      // Ceiling division implemented as `(a + b - 1) / b` on an exact quotient
      // is the classic place to gain a spurious unit.
      expect(
        await quote.tokenAmountForUsd(1_000_000n, 6, 2_000_000n, 6, 6),
      ).to.equal(500_000n);
      expect(
        await quote.tokenAmountForUsd(0n, 6, 2_000_000n, 6, 6),
      ).to.equal(0n);
    });

    it("survives an intermediate that does not fit in 256 bits", async () => {
      const { quote } = await loadFixture(harnessFixture);

      // 10**30 * 10**(24 + 24) is 10**78, past uint256's ~1.16 * 10**77 — so a
      // hand-rolled `a * b / c` reverts here. The answer, 10**72, fits, and
      // Math.mulDiv forms the product in 512 bits to reach it. This is the case
      // the library's structure exists for.
      expect(
        await quote.tokenAmountForUsd(10n ** 30n, 0, 10n ** 6n, 24, 24),
      ).to.equal(10n ** 72n);
    });

    it("rejects a zero price", async () => {
      const { quote } = await loadFixture(harnessFixture);

      // Zero is an oracle saying it has no data. Dividing by it is the bug this
      // catches; treating the token as free is the bug it prevents.
      await expect(
        quote.tokenAmountForUsd(500_000_000n, 6, 0n, 6, 6),
      ).to.be.revertedWithCustomError(quote, "ZeroPrice");
    });

    it("rejects decimal scales it will not reason about", async () => {
      const { quote } = await loadFixture(harnessFixture);

      for (const [args, offender] of [
        [[500_000_000n, 25, 2_500_000n, 6, 6], 25n],
        [[500_000_000n, 6, 2_500_000n, 6, 25], 25n],
        [[500_000_000n, 6, 2_500_000n, 25, 6], 25n],
        [[500_000_000n, 6, 2_500_000n, -25, 6], -25n],
      ] as const) {
        await expect(
          quote.tokenAmountForUsd(
            ...(args as [bigint, number, bigint, number, number]),
          ),
        )
          .to.be.revertedWithCustomError(quote, "DecimalsOutOfRange")
          .withArgs(offender);
      }
    });
  });

  describe("token to USD", () => {
    it("values a 6-decimal balance against a 6-decimal feed", async () => {
      const { quote } = await loadFixture(harnessFixture);

      // 200.000000 FXRP at $2.50 = $500.000000.
      expect(
        await quote.usdValueOfToken(200_000_000n, 6, 2_500_000n, 6, 6),
      ).to.equal(500_000_000n);
    });

    it("values an 18-decimal balance against an 8-decimal feed", async () => {
      const { quote } = await loadFixture(harnessFixture);

      // 1,000 FLR at $0.021 = $21.000000.
      expect(
        await quote.usdValueOfToken(1_000n * 10n ** 18n, 18, 2_100_000n, 8, 6),
      ).to.equal(21_000_000n);
    });

    it("handles a negative price exponent", async () => {
      const { quote } = await loadFixture(harnessFixture);

      // 2.000000 tokens at value 25, exponent -1, so $250 each: $500.000000.
      // Here the negative exponent lands on the other side of the expression
      // than in tokenAmountForUsd, which is where a copied sign goes wrong.
      expect(
        await quote.usdValueOfToken(2_000_000n, 6, 25n, -1, 6),
      ).to.equal(500_000_000n);
    });

    it("rounds down, because this direction is evidence and not an obligation", async () => {
      const { quote } = await loadFixture(harnessFixture);

      // 1 base unit of a 6dp token at $2.50 is $0.0000025 — half a USD unit at
      // 6dp. Rounding a displayed figure up would overstate what is held.
      expect(await quote.usdValueOfToken(1n, 6, 2_500_000n, 6, 6)).to.equal(2n);
      expect(await quote.usdValueOfToken(0n, 6, 2_500_000n, 6, 6)).to.equal(0n);
    });

    it("rejects a zero price and out-of-range decimals", async () => {
      const { quote } = await loadFixture(harnessFixture);

      await expect(
        quote.usdValueOfToken(200_000_000n, 6, 0n, 6, 6),
      ).to.be.revertedWithCustomError(quote, "ZeroPrice");

      await expect(quote.usdValueOfToken(200_000_000n, 6, 2_500_000n, -25, 6))
        .to.be.revertedWithCustomError(quote, "DecimalsOutOfRange")
        .withArgs(-25n);
    });
  });

  describe("round-tripping", () => {
    it("returns at least the original USD when a token base unit is worth more than a USD unit", async () => {
      const { quote } = await loadFixture(harnessFixture);

      // $1.00 at $3.00/token. The conversion rounds up by a fraction of a base
      // unit; that overshoot is worth $0.000003, which survives the floor on the
      // way back. So the round trip lands slightly high, never low.
      const usd = 1_000_000n;
      const tokens = await quote.tokenAmountForUsd(usd, 6, 3_000_000n, 6, 6);
      const back = await quote.usdValueOfToken(tokens, 6, 3_000_000n, 6, 6);

      expect(tokens).to.equal(333_334n);
      expect(back).to.equal(1_000_002n);

      // Bounded by the USD value of one token base unit: $0.000003 here.
      expect(back).to.be.greaterThanOrEqual(usd);
      expect(back - usd).to.be.lessThanOrEqual(3n);
    });

    it("may land a hair low for a token cheaper than a USD unit", async () => {
      const { quote } = await loadFixture(harnessFixture);

      // The asymmetry is real and worth pinning rather than papering over. One
      // base unit of an 18dp token at $0.021 is worth far less than $0.000001,
      // so the round-up on the way out is invisible at 6dp USD, and the floor on
      // the way back can shave the last unit.
      const usd = 1_000_001n;
      const tokens = await quote.tokenAmountForUsd(usd, 6, 2_100_000n, 8, 18);
      const back = await quote.usdValueOfToken(tokens, 18, 2_100_000n, 8, 6);

      // Asserting equality here would be asserting something false.
      const drift = back > usd ? back - usd : usd - back;
      expect(drift).to.be.lessThanOrEqual(1n);
    });

    it("is exact for a stablecoin at parity", async () => {
      const { quote } = await loadFixture(harnessFixture);

      // USDT0: 6dp token, 6dp feed, price 1.000000. The case where a scaling bug
      // would be invisible in one direction, so it is worth checking both.
      const usd = 123_456_789n;
      const tokens = await quote.tokenAmountForUsd(usd, 6, 1_000_000n, 6, 6);
      expect(tokens).to.equal(usd);
      expect(await quote.usdValueOfToken(tokens, 6, 1_000_000n, 6, 6)).to.equal(
        usd,
      );
    });
  });
});
