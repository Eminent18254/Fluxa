// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IPriceOracle} from "../interfaces/IFluxa.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {FluxaQuote} from "../libraries/FluxaQuote.sol";

/**
 * @title MockPriceOracle
 * @notice Deterministic IPriceOracle for tests.
 *
 * @dev Per-token decimals, not a global constant, because that is how FTSOv2
 *      actually behaves: XRP/USD reports 6 and FLR/USD reports 8. A mock that
 *      normalised every feed to one exponent would let a scaling bug pass the
 *      suite and fail on Coston2.
 *
 *      `shouldRevert` exists to test the try/catch in
 *      FluxaSettlement._snapshotPrice. That branch is the difference between a
 *      missing log line and a merchant not getting paid, so it needs a way to
 *      be triggered on purpose.
 */
contract MockPriceOracle is IPriceOracle {
    struct Feed {
        uint256 value;
        int8 decimals;
        uint64 timestamp;
        bool set;
    }

    mapping(address => Feed) private _feeds;
    bool public shouldRevert;

    error NoFeed(address token);
    error Forced();

    function setPrice(address token, uint256 value, int8 decimals_, uint64 timestamp)
        external
    {
        _feeds[token] = Feed(value, decimals_, timestamp, true);
    }

    function setShouldRevert(bool value) external {
        shouldRevert = value;
    }

    function getPriceUsd(address token)
        external
        view
        override
        returns (uint256 value, int8 decimals, uint64 timestamp)
    {
        if (shouldRevert) revert Forced();
        Feed memory feed = _feeds[token];
        if (!feed.set) revert NoFeed(token);
        return (feed.value, feed.decimals, feed.timestamp);
    }

    function quoteTokenAmount(address token, uint256 usdAmount)
        external
        view
        returns (uint256)
    {
        if (shouldRevert) revert Forced();
        Feed memory feed = _feeds[token];
        if (!feed.set) revert NoFeed(token);
        return FluxaQuote.tokenAmountForUsd(
            usdAmount, 6, feed.value, feed.decimals, IERC20Metadata(token).decimals()
        );
    }
}
