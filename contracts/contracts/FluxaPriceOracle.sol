// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IFlareContractRegistry} from
    "@flarenetwork/flare-periphery-contracts/coston2/IFlareContractRegistry.sol";
import {FtsoV2Interface} from "@flarenetwork/flare-periphery-contracts/coston2/FtsoV2Interface.sol";
import {TestFtsoV2Interface} from
    "@flarenetwork/flare-periphery-contracts/coston2/TestFtsoV2Interface.sol";
import {IFeeCalculator} from "@flarenetwork/flare-periphery-contracts/coston2/IFeeCalculator.sol";

import {IPriceOracle} from "./interfaces/IFluxa.sol";
import {FluxaQuote} from "./libraries/FluxaQuote.sol";

/**
 * @title FluxaPriceOracle
 * @notice Fluxa's price source: FTSOv2, read live, resolved through the Flare
 *         Contract Registry.
 *
 * @dev Implements the {IPriceOracle} seam that Sprint 2 left behind, so
 *      `FluxaSettlement` gains real prices by having its oracle address set —
 *      no settlement code changes.
 *
 *      Four decisions here are worth stating, because each one has a plausible
 *      alternative that is worse:
 *
 *      1. **The FtsoV2 address is resolved on every call, not cached.** Flare
 *         redeploys protocol contracts and repoints the registry; that is what
 *         the registry is *for*. A constructor-cached address would keep working
 *         right up until it silently didn't, returning prices from an abandoned
 *         contract. The cost is one extra `staticcall` per read.
 *
 *      2. **The registry address is a constructor argument, not a hardcode.**
 *         The official `ContractRegistry` library hardcodes it, which makes this
 *         contract untestable anywhere but a fork — the address holds no code on
 *         a local chain, so every read reverts. It is `immutable`, so it cannot
 *         be repointed after deploy, and {CANONICAL_FLARE_REGISTRY} records the
 *         real value so the deploy script can assert the two agree rather than
 *         trusting whatever was passed.
 *
 *      3. **`getPriceUsd` reads through `TestFtsoV2Interface`.** Not because
 *         this is test code. `FtsoV2Interface.getFeedById` is `payable`, since a
 *         fee computed by `FeeCalculator` may apply, and a `view` function
 *         cannot call a non-`view` one — that is a compile error, not a runtime
 *         nuance. `TestFtsoV2Interface` declares the identical reads as `view`,
 *         and `ContractRegistry` resolves both under the same key
 *         (`keccak256(abi.encode("FtsoV2"))`), so the two interfaces address the
 *         *same deployed contract* and differ only in compile-time mutability.
 *         Reading through the `view` one is what lets `getPriceUsd` satisfy an
 *         interface that settlement calls from a `view` context.
 *
 *         That works while the fee for these feeds is zero, which is a fact
 *         about Coston2 rather than a guarantee. So {feeForToken} exposes the
 *         `FeeCalculator`'s own answer — the zero gets asserted, by both the
 *         deploy script and a live test, instead of assumed — and
 *         {getPriceUsdPaying} exists as the non-`view`, fee-forwarding path that
 *         keeps working if it ever stops being zero.
 *
 *      4. **Staleness is rejected, not reported.** FTSOv2 updates roughly every
 *         90 seconds. A caller handed a stale price alongside a timestamp is a
 *         caller that will forget to check the timestamp. Reverting puts the
 *         decision in one place, and {maxPriceAge} makes the threshold visible
 *         and adjustable rather than a magic number.
 */
contract FluxaPriceOracle is IPriceOracle, Ownable2Step {
    /// @notice The Flare Contract Registry address, identical on every Flare
    ///         network. Recorded so a deployment can be checked against it; see
    ///         decision 2 in the contract notes.
    address public constant CANONICAL_FLARE_REGISTRY = 0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019;

    /// @dev The registry keys the official `ContractRegistry` library uses.
    ///      Looking up by hash rather than by name matches that library exactly
    ///      and avoids hashing a string on every read.
    bytes32 private constant FTSO_V2_KEY = keccak256(abi.encode("FtsoV2"));
    bytes32 private constant FEE_CALCULATOR_KEY = keccak256(abi.encode("FeeCalculator"));

    /// @notice Scale Fluxa states USD amounts in. Six decimals, matching the
    ///         stablecoins it settles in, so a USD total and a USDT0 total are
    ///         the same number and cannot be swapped by accident.
    uint8 public constant USD_DECIMALS = 6;

    /// @notice Where FTSOv2 and FeeCalculator get resolved from.
    IFlareContractRegistry public immutable registry;

    /// @notice Oldest price this oracle will return, in seconds.
    uint64 public maxPriceAge;

    /// @dev token => FTSOv2 feed id. Structured feed ids are 21 bytes: one byte
    ///      of category, then the space-padded name.
    mapping(address token => bytes21 feedId) private _feedIds;

    /// @notice A token with no configured feed. Named separately from a zero
    ///         price so the two failures are distinguishable in a trace.
    error FeedNotConfigured(address token);
    error PriceIsZero(address token);
    error PriceIsStale(address token, uint64 timestamp, uint64 oldestAllowed);
    error ZeroAddress();
    error ZeroFeedId();
    error ZeroMaxPriceAge();
    error RegistryLookupFailed(bytes32 key);
    error FeeNotCovered(uint256 required, uint256 supplied);
    error RefundFailed(address recipient, uint256 amount);

    event FeedConfigured(address indexed token, bytes21 feedId);
    event FeedRemoved(address indexed token);
    event MaxPriceAgeChanged(uint64 previous, uint64 current);

    /**
     * @param initialOwner Owner, able to configure feeds and staleness.
     * @param registry_    Flare Contract Registry. Must equal
     *                     {CANONICAL_FLARE_REGISTRY} on a real network; the
     *                     deploy script enforces that.
     * @param maxPriceAge_ Initial staleness threshold in seconds.
     *
     * @dev No zero-address check on `initialOwner`: `Ownable`'s constructor runs
     *      first and reverts with `OwnableInvalidOwner`, so a check here would be
     *      unreachable code that reads like a live guard.
     */
    constructor(address initialOwner, address registry_, uint64 maxPriceAge_)
        Ownable(initialOwner)
    {
        if (registry_ == address(0)) revert ZeroAddress();
        if (maxPriceAge_ == 0) revert ZeroMaxPriceAge();

        registry = IFlareContractRegistry(registry_);
        maxPriceAge = maxPriceAge_;
        emit MaxPriceAgeChanged(0, maxPriceAge_);
    }

    // ---------------------------------------------------------------------
    // Configuration
    // ---------------------------------------------------------------------

    /**
     * @notice Map a token to an FTSOv2 feed.
     *
     * @dev Owner-only and deliberately not validated against the feed's own
     *      metadata: FTSOv2 has no on-chain way to ask "is this feed about this
     *      token", so any such check would be theatre. What protects this is that
     *      `FluxaInvoice` independently allowlists which tokens can be invoiced
     *      at all, so a wrong mapping here cannot introduce a token the system
     *      would otherwise reject — it can only misprice one it already accepts,
     *      which the live Coston2 test is what actually catches.
     */
    function setFeed(address token, bytes21 feedId) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        if (feedId == bytes21(0)) revert ZeroFeedId();

        _feedIds[token] = feedId;
        emit FeedConfigured(token, feedId);
    }

    function removeFeed(address token) external onlyOwner {
        if (_feedIds[token] == bytes21(0)) revert FeedNotConfigured(token);

        delete _feedIds[token];
        emit FeedRemoved(token);
    }

    function setMaxPriceAge(uint64 newMaxPriceAge) external onlyOwner {
        if (newMaxPriceAge == 0) revert ZeroMaxPriceAge();

        uint64 previous = maxPriceAge;
        maxPriceAge = newMaxPriceAge;
        emit MaxPriceAgeChanged(previous, newMaxPriceAge);
    }

    // ---------------------------------------------------------------------
    // Price reads
    // ---------------------------------------------------------------------

    /// @inheritdoc IPriceOracle
    function getPriceUsd(address token)
        external
        view
        returns (uint256 value, int8 decimals, uint64 timestamp)
    {
        return _readPrice(token);
    }

    /**
     * @notice Same read as {getPriceUsd}, forwarding a FeeCalculator fee.
     *
     * @dev The path that stays correct if these feeds ever stop being free. It
     *      cannot be `view` — `FtsoV2Interface.getFeedById` is `payable`, which
     *      is the whole reason {getPriceUsd} goes through the `view` interface
     *      instead — so it is unusable from settlement's `view` context and is
     *      not what {IPriceOracle} routes to. It exists so that the fee-paying
     *      path is real code that runs in tests, rather than a paragraph
     *      claiming Fluxa would handle a fee.
     *
     *      Any excess above the required fee is refunded rather than kept: an
     *      oracle that silently pockets overpayment is a slow leak.
     */
    function getPriceUsdPaying(address token)
        external
        payable
        returns (uint256 value, int8 decimals, uint64 timestamp)
    {
        bytes21 feedId = _requireFeed(token);

        uint256 fee = _feeFor(feedId);
        if (msg.value < fee) revert FeeNotCovered(fee, msg.value);

        (value, decimals, timestamp) = _ftsoV2().getFeedById{value: fee}(feedId);
        _validate(token, value, timestamp);

        uint256 refund = msg.value - fee;
        if (refund > 0) {
            // The caller is the payer, so returning their own surplus to them
            // cannot be a griefing vector. A failed refund fails the whole read
            // rather than being swallowed: the alternative is this contract
            // quietly accumulating other people's money.
            (bool ok,) = msg.sender.call{value: refund}("");
            if (!ok) revert RefundFailed(msg.sender, refund);
        }
    }

    /**
     * @notice What FTSOv2 charges for this token's feed, per read.
     *
     * @dev Zero on Coston2 today. Exposed so that "zero" is something Fluxa
     *      checks rather than something it assumes: the deploy script asserts it,
     *      and if it ever becomes non-zero the `view` read in {getPriceUsd}
     *      starts reverting and {getPriceUsdPaying} is the answer.
     */
    function feeForToken(address token) external view returns (uint256) {
        return _feeFor(_requireFeed(token));
    }

    // ---------------------------------------------------------------------
    // Quotes
    // ---------------------------------------------------------------------

    /**
     * @notice Token base units needed to settle `usdAmount` (at
     *         {USD_DECIMALS}).
     *
     * @dev The point of doing this on-chain: the amount an invoice demands is
     *      derived from a price the contract read itself, not taken on trust
     *      from whatever the client computed. A frontend that quotes the wrong
     *      number produces a payment this contract rejects, instead of a
     *      merchant who is quietly underpaid.
     *
     *      `decimals()` is read from the token rather than stored, so a
     *      mis-recorded decimal count cannot be the source of a mispricing.
     */
    function quoteTokenAmount(address token, uint256 usdAmount)
        external
        view
        returns (uint256 amount)
    {
        (uint256 value, int8 decimals,) = _readPrice(token);

        return FluxaQuote.tokenAmountForUsd(
            usdAmount, USD_DECIMALS, value, decimals, IERC20Metadata(token).decimals()
        );
    }

    /**
     * @notice USD value (at {USD_DECIMALS}) of `amount` token base units.
     *
     * @dev The display direction: what a held or settled balance is worth now.
     *      Rounds down, and is not an exact inverse of {quoteTokenAmount}; see
     *      {FluxaQuote}.
     */
    function quoteUsdValue(address token, uint256 amount)
        external
        view
        returns (uint256 usdAmount)
    {
        (uint256 value, int8 decimals,) = _readPrice(token);

        return FluxaQuote.usdValueOfToken(
            amount, IERC20Metadata(token).decimals(), value, decimals, USD_DECIMALS
        );
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function feedIdFor(address token) external view returns (bytes21) {
        return _feedIds[token];
    }

    function hasFeed(address token) external view returns (bool) {
        return _feedIds[token] != bytes21(0);
    }

    /// @notice The FtsoV2 address the registry currently resolves to.
    /// @dev Exposed so a deployment can be checked against the address
    ///      `scripts/checkFlare.ts` reads independently, rather than both sides
    ///      trusting the same lookup.
    function ftsoV2Address() external view returns (address) {
        return _resolve(FTSO_V2_KEY);
    }

    function feeCalculatorAddress() external view returns (address) {
        return _resolve(FEE_CALCULATOR_KEY);
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    function _readPrice(address token)
        private
        view
        returns (uint256 value, int8 decimals, uint64 timestamp)
    {
        bytes21 feedId = _requireFeed(token);

        (value, decimals, timestamp) = _testFtsoV2().getFeedById(feedId);
        _validate(token, value, timestamp);
    }

    /**
     * @dev Both failures are hard reverts. A zero price is FTSOv2 saying it has
     *      nothing, and a stale one is it saying what it has is old; either way,
     *      continuing means pricing an invoice off a number nobody stands behind.
     */
    function _validate(address token, uint256 value, uint64 timestamp) private view {
        if (value == 0) revert PriceIsZero(token);

        uint64 oldestAllowed =
            block.timestamp > maxPriceAge ? uint64(block.timestamp) - maxPriceAge : 0;

        if (timestamp < oldestAllowed) {
            revert PriceIsStale(token, timestamp, oldestAllowed);
        }
    }

    function _requireFeed(address token) private view returns (bytes21 feedId) {
        feedId = _feedIds[token];
        if (feedId == bytes21(0)) revert FeedNotConfigured(token);
    }

    function _feeFor(bytes21 feedId) private view returns (uint256) {
        bytes21[] memory ids = new bytes21[](1);
        ids[0] = feedId;

        // `IFeeCalculator` has no singular by-id variant — only the array forms.
        return IFeeCalculator(_resolve(FEE_CALCULATOR_KEY)).calculateFeeByIds(ids);
    }

    function _ftsoV2() private view returns (FtsoV2Interface) {
        return FtsoV2Interface(_resolve(FTSO_V2_KEY));
    }

    function _testFtsoV2() private view returns (TestFtsoV2Interface) {
        return TestFtsoV2Interface(_resolve(FTSO_V2_KEY));
    }

    /**
     * @dev The registry returns `address(0)` for an unknown name rather than
     *      reverting, so an unchecked result turns into a call to the zero
     *      address — which fails with no revert data and nothing to debug.
     */
    function _resolve(bytes32 key) private view returns (address resolved) {
        resolved = registry.getContractAddressByHash(key);
        if (resolved == address(0)) revert RegistryLookupFailed(key);
    }
}
