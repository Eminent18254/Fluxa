// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title MockFtsoV2
 * @notice Stand-in for Flare's FTSOv2 feed publisher.
 *
 * @dev `getFeedById` is declared `payable` here, matching the production
 *      `FtsoV2Interface`, and that single implementation is also what
 *      `TestFtsoV2Interface`'s `view` declaration reaches. That is not a
 *      shortcut — it is the actual arrangement on Flare, where one deployed
 *      contract sits behind two interfaces that differ only in mutability. The
 *      function reads storage and never writes, so a `staticcall` through the
 *      `view` interface succeeds, exactly as it does on Coston2.
 *
 *      Feeds are stored per id with their own `decimals`, because FTSOv2's
 *      decimals are per-feed (XRP/USD is 6dp, FLR/USD is 8dp) and a mock with
 *      one global scale would make the most likely real bug untestable.
 */
contract MockFtsoV2 {
    struct Feed {
        uint256 value;
        int8 decimals;
        uint64 timestamp;
        bool set;
    }

    mapping(bytes21 feedId => Feed) private _feeds;

    /// @notice When true, every read reverts — the "oracle is down" case that
    ///         callers must survive rather than treat as a zero price.
    bool public shouldRevert;

    error FeedUnavailable(bytes21 feedId);
    error MockOracleDown();

    function setFeed(bytes21 feedId, uint256 value, int8 decimals, uint64 timestamp) external {
        _feeds[feedId] = Feed(value, decimals, timestamp, true);
    }

    function setShouldRevert(bool value) external {
        shouldRevert = value;
    }

    function getFeedById(bytes21 feedId)
        external
        payable
        returns (uint256 value, int8 decimals, uint64 timestamp)
    {
        if (shouldRevert) revert MockOracleDown();

        Feed memory feed = _feeds[feedId];
        if (!feed.set) revert FeedUnavailable(feedId);

        return (feed.value, feed.decimals, feed.timestamp);
    }
}
