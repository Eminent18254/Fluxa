// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title FluxaQuote
 * @notice Conversion between a USD invoice amount and a token amount, given an
 *         FTSOv2 price.
 *
 * @dev This library is deliberately `pure` and knows nothing about oracles.
 *      Conversion is where the money is decided, so it should be the part of
 *      the system that can be tested without a chain, a fork, or a mock: every
 *      branch here is reachable from a plain unit test with literal inputs.
 *
 *      Three independent decimal scales meet in this file, and conflating any
 *      two of them silently misprices an invoice by orders of magnitude:
 *
 *        - `usdDecimals`   the fixed-point scale Fluxa stores invoice totals in
 *        - `priceDecimals` FTSOv2's scale, which is *per feed* and arrives as
 *                          part of the feed response — XRP/USD is 6dp, FLR/USD
 *                          is 8dp. It is `int8` and may legitimately be negative
 *                          for feeds whose value is large.
 *        - `tokenDecimals` the ERC-20's own scale — FXRP and USDT0 are both 6dp,
 *                          not the 18 that gets assumed by default.
 *
 *      Rather than build a numerator and denominator out of all three, each
 *      function folds them into a single signed net exponent. That cancels the
 *      common powers of ten before any multiplication happens, so the only
 *      division is by the price (or by a clean power of ten) and there is no
 *      intermediate large enough to overflow for inputs the result can hold.
 *      Where a division does occur it goes through `Math.mulDiv`, which forms
 *      the product in 512 bits, so precision is not lost to operand ordering.
 */
library FluxaQuote {
    /// @notice A price of zero cannot be inverted, and means "no data" rather
    ///         than "free" in every oracle Fluxa reads.
    error ZeroPrice();

    /// @notice Decimal scale outside the range this library will reason about.
    error DecimalsOutOfRange(int256 decimals);

    /**
     * @dev Any real feed or token sits far inside this bound; 6, 8 and 18 are
     *      the values that actually occur. The check exists so that absurd input
     *      fails with a named error naming the offending scale, rather than as a
     *      bare arithmetic panic from `10 ** n` several frames deeper where the
     *      cause is no longer visible. It also keeps the worst-case exponent
     *      (three scales summed) inside `uint256`, which is what makes the
     *      overflow argument above hold.
     */
    int256 internal constant MAX_DECIMALS = 24;

    /**
     * @notice Token base units needed to settle `usdAmount`.
     *
     * @param usdAmount     USD owed, scaled by `10 ** usdDecimals`.
     * @param usdDecimals   Fixed-point scale of `usdAmount`.
     * @param price         Token price in USD, from FTSOv2.
     * @param priceDecimals Fixed-point scale of `price`, from the same FTSOv2
     *                      response. Per-feed, and may be negative.
     * @param tokenDecimals The ERC-20's `decimals()`.
     * @return amount       Token base units to transfer.
     *
     * @dev Rounds **up**. The remainder is at most one base unit — a millionth
     *      of an FXRP — and rounding it the other way would let every invoice
     *      settle a hair short of what it says it is owed. A merchant overpaid
     *      by 0.000001 XRP does not have a problem; one whose invoices
     *      systematically underpay does.
     */
    function tokenAmountForUsd(
        uint256 usdAmount,
        uint8 usdDecimals,
        uint256 price,
        int8 priceDecimals,
        uint8 tokenDecimals
    ) internal pure returns (uint256 amount) {
        if (price == 0) revert ZeroPrice();
        _checkDecimals(int256(uint256(usdDecimals)));
        _checkDecimals(int256(uint256(tokenDecimals)));
        _checkDecimals(int256(priceDecimals));

        // tokens = (usdAmount / 10**usdDecimals) / (price / 10**priceDecimals)
        // base   = tokens * 10**tokenDecimals
        //        = usdAmount * 10**(tokenDecimals + priceDecimals - usdDecimals)
        //          / price
        int256 e = int256(uint256(tokenDecimals)) + int256(priceDecimals) - int256(uint256(usdDecimals));

        if (e >= 0) {
            amount = Math.mulDiv(usdAmount, 10 ** uint256(e), price, Math.Rounding.Ceil);
        } else {
            amount = Math.mulDiv(usdAmount, 1, price * 10 ** uint256(-e), Math.Rounding.Ceil);
        }
    }

    /**
     * @notice USD value of `amount` token base units.
     *
     * @dev The inverse of {tokenAmountForUsd}, and rounds **down** rather than
     *      up. This direction produces evidence — what an already-settled
     *      invoice was worth, what a dashboard displays — not an obligation, so
     *      the reason to round up does not apply. Understating by a millionth of
     *      a cent is the conservative direction for a figure someone reads.
     *
     *      Round-tripping a value through both functions is therefore not the
     *      identity. The tests assert a bound on the difference rather than
     *      equality, because asserting equality would be asserting something
     *      false.
     */
    function usdValueOfToken(
        uint256 amount,
        uint8 tokenDecimals,
        uint256 price,
        int8 priceDecimals,
        uint8 usdDecimals
    ) internal pure returns (uint256 usdAmount) {
        if (price == 0) revert ZeroPrice();
        _checkDecimals(int256(uint256(usdDecimals)));
        _checkDecimals(int256(uint256(tokenDecimals)));
        _checkDecimals(int256(priceDecimals));

        // usd = (amount / 10**tokenDecimals) * (price / 10**priceDecimals),
        //       restated at 10**usdDecimals
        //     = amount * price * 10**(usdDecimals - tokenDecimals - priceDecimals)
        int256 e = int256(uint256(usdDecimals)) - int256(uint256(tokenDecimals)) - int256(priceDecimals);

        if (e >= 0) {
            // No division, so there is no intermediate distinct from the result:
            // a plain product is exact, and overflows only if the answer itself
            // does not fit — which is the correct failure.
            usdAmount = amount * price * 10 ** uint256(e);
        } else {
            usdAmount = Math.mulDiv(amount, price, 10 ** uint256(-e), Math.Rounding.Floor);
        }
    }

    function _checkDecimals(int256 decimals) private pure {
        if (decimals > MAX_DECIMALS || decimals < -MAX_DECIMALS) {
            revert DecimalsOutOfRange(decimals);
        }
    }
}
