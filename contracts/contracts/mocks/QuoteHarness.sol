// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {FluxaQuote} from "../libraries/FluxaQuote.sol";

/**
 * @title QuoteHarness
 * @notice Exposes {FluxaQuote}'s internal functions for direct testing.
 *
 * @dev `FluxaQuote` is an internal-only library, so its functions are inlined
 *      into callers and have no ABI of their own. Testing conversion only
 *      through `FluxaPriceOracle` would mean every arithmetic case had to be
 *      reached by first configuring a feed and a mock price — which makes the
 *      decimal edge cases (negative `priceDecimals`, mismatched scales,
 *      rounding boundaries) tedious enough that they would get skipped. This
 *      harness makes them one call each.
 */
contract QuoteHarness {
    function tokenAmountForUsd(
        uint256 usdAmount,
        uint8 usdDecimals,
        uint256 price,
        int8 priceDecimals,
        uint8 tokenDecimals
    ) external pure returns (uint256) {
        return FluxaQuote.tokenAmountForUsd(
            usdAmount, usdDecimals, price, priceDecimals, tokenDecimals
        );
    }

    function usdValueOfToken(
        uint256 amount,
        uint8 tokenDecimals,
        uint256 price,
        int8 priceDecimals,
        uint8 usdDecimals
    ) external pure returns (uint256) {
        return FluxaQuote.usdValueOfToken(
            amount, tokenDecimals, price, priceDecimals, usdDecimals
        );
    }
}
