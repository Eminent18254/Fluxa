// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";

import {FluxaTypes} from "./libraries/FluxaTypes.sol";
import {IFluxaInvoice, IPriceOracle} from "./interfaces/IFluxa.sol";

/**
 * @title FluxaSettlement
 * @notice Moves a paid invoice's escrow to the merchant and records the result.
 *
 * @dev This is the second half of the split that makes Fluxa a payments system
 *      rather than a transfer helper. FluxaInvoice answers "has the customer
 *      paid?"; this contract answers "has the merchant been paid, in what, and
 *      at what price?". Keeping them apart means the asset the customer sends
 *      and the asset the merchant receives are separate concerns, which is the
 *      whole premise of a cross-asset product.
 *
 *      Sprint 2 settles same-asset: escrow is released to the merchant in the
 *      token the invoice was denominated in. The price snapshot and the
 *      IPriceOracle seam are wired now so Sprint 3 can add conversion without
 *      restructuring the money path. The snapshot is recorded rather than
 *      enforced — see _snapshotPrice.
 */
contract FluxaSettlement is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error ZeroAddress();
    error AlreadySettled(uint256 invoiceId, uint64 settledAt);
    error InvoiceNotPaid(uint256 invoiceId, FluxaTypes.Status status);
    error NotInvoiceMerchant(uint256 invoiceId, address caller);
    error NothingReleased(uint256 invoiceId);

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event InvoiceSettled(
        uint256 indexed invoiceId,
        address indexed merchant,
        address indexed recipient,
        address token,
        uint256 amountOut
    );

    /**
     * @notice The oracle reading taken at settlement.
     * @dev Emitted separately from InvoiceSettled because it is evidence, not
     *      control flow: a settlement is valid whether or not the oracle
     *      answered. `priceDecimals` is carried because FTSOv2 exponents differ
     *      per feed, so a value without its exponent is not a price.
     */
    event SettlementPriceSnapshot(
        uint256 indexed invoiceId,
        address indexed token,
        uint256 priceValue,
        int8 priceDecimals,
        uint64 priceTimestamp
    );

    event PayoutAddressChanged(
        address indexed merchant, address indexed previous, address indexed current
    );
    event PriceOracleChanged(address indexed previous, address indexed current);

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    /// @notice The invoice registry this contract settles for. Immutable: a
    ///         settlement contract that could be repointed at a different
    ///         registry could be made to release escrow it never accounted for.
    IFluxaInvoice public immutable invoiceContract;

    /// @notice FTSOv2-backed price source. Optional in Sprint 2.
    IPriceOracle public priceOracle;

    mapping(uint256 => FluxaTypes.Settlement) private _settlements;

    /**
     * @notice Where a merchant wants funds delivered.
     * @dev Zero means "the merchant address itself". Stored per merchant rather
     *      than per invoice so a merchant can move their treasury without
     *      reissuing outstanding invoices.
     */
    mapping(address => address) public payoutAddress;

    // ---------------------------------------------------------------------
    // Construction
    // ---------------------------------------------------------------------

    /// @dev `initialOwner` is validated by Ownable's constructor, which runs
    ///      first; repeating the check here would be unreachable.
    constructor(address initialOwner, address invoiceContract_) Ownable(initialOwner) {
        if (invoiceContract_ == address(0)) revert ZeroAddress();
        invoiceContract = IFluxaInvoice(invoiceContract_);
    }

    // ---------------------------------------------------------------------
    // Configuration
    // ---------------------------------------------------------------------

    /**
     * @notice Point settlement at a price oracle.
     * @dev Settable to the zero address on purpose: an oracle that starts
     *      misbehaving must be removable without bricking settlement, because
     *      the price is evidence and the payout is not conditional on it.
     */
    function setPriceOracle(address oracle) external onlyOwner {
        address previous = address(priceOracle);
        priceOracle = IPriceOracle(oracle);
        emit PriceOracleChanged(previous, oracle);
    }

    /**
     * @notice Nominate where this merchant's settlements are delivered.
     * @dev Merchant-only, and it is their own key that sets it. Nobody — not
     *      even the owner — can redirect another account's payouts; that would
     *      make owner compromise equal to theft of every future settlement.
     */
    function setPayoutAddress(address recipient) external {
        address previous = payoutAddress[msg.sender];
        payoutAddress[msg.sender] = recipient;
        emit PayoutAddressChanged(msg.sender, previous, recipient);
    }

    // ---------------------------------------------------------------------
    // Settlement
    // ---------------------------------------------------------------------

    /**
     * @notice Settle a paid invoice: release its escrow to the merchant.
     *
     * @dev Permissionless by design. The destination is derived from the
     *      invoice's merchant and that merchant's own payout nomination, never
     *      from the caller, so an arbitrary caller can only push money to where
     *      it was already owed. Making it open means a merchant is not required
     *      to send a transaction (and hold gas) to receive funds, and a keeper
     *      or the customer can finalise on their behalf.
     *
     *      Ordering: the local record is written before the external release, so
     *      a token with a transfer callback re-entering this function finds the
     *      invoice already settled. nonReentrant is belt to that braces, and the
     *      invoice contract independently refuses a second release.
     *
     *      `amountOut` is what FluxaInvoice reports actually left escrow, not
     *      what the invoice said was owed. On a fee-on-transfer token those
     *      differ, and the record should say what moved.
     */
    function settleInvoice(uint256 invoiceId)
        external
        nonReentrant
        returns (address token, uint256 amountOut)
    {
        FluxaTypes.Settlement storage existing = _settlements[invoiceId];
        if (existing.settledAt != 0) {
            revert AlreadySettled(invoiceId, existing.settledAt);
        }

        FluxaTypes.Invoice memory invoice = invoiceContract.getInvoice(invoiceId);
        if (invoice.status != FluxaTypes.Status.PAID) {
            revert InvoiceNotPaid(invoiceId, invoice.status);
        }

        address recipient = payoutAddress[invoice.merchant];
        if (recipient == address(0)) recipient = invoice.merchant;

        // Effects: claim the slot before any external call. settledAt is the
        // guard, so it must be non-zero even in the same block as creation —
        // block.timestamp is never 0 on a live chain, and the tests pin this.
        existing.settledAt = uint64(block.timestamp);
        existing.settledTo = recipient;

        (token, amountOut) = invoiceContract.releaseEscrow(invoiceId, recipient);
        if (amountOut == 0) revert NothingReleased(invoiceId);

        existing.settleToken = token;
        existing.amountOut = amountOut;

        emit InvoiceSettled(invoiceId, invoice.merchant, recipient, token, amountOut);

        _snapshotPrice(invoiceId, token);
    }

    /**
     * @notice Settle to an address the merchant names in this call.
     * @dev Merchant-only, unlike settleInvoice. A caller who can choose the
     *      destination can redirect the money, so that power is restricted to
     *      the party the money belongs to. Useful when a merchant wants a
     *      one-off destination without changing their standing nomination.
     */
    function settleInvoiceTo(uint256 invoiceId, address recipient)
        external
        nonReentrant
        returns (address token, uint256 amountOut)
    {
        if (recipient == address(0)) revert ZeroAddress();

        FluxaTypes.Settlement storage existing = _settlements[invoiceId];
        if (existing.settledAt != 0) {
            revert AlreadySettled(invoiceId, existing.settledAt);
        }

        FluxaTypes.Invoice memory invoice = invoiceContract.getInvoice(invoiceId);
        if (msg.sender != invoice.merchant) {
            revert NotInvoiceMerchant(invoiceId, msg.sender);
        }
        if (invoice.status != FluxaTypes.Status.PAID) {
            revert InvoiceNotPaid(invoiceId, invoice.status);
        }

        existing.settledAt = uint64(block.timestamp);
        existing.settledTo = recipient;

        (token, amountOut) = invoiceContract.releaseEscrow(invoiceId, recipient);
        if (amountOut == 0) revert NothingReleased(invoiceId);

        existing.settleToken = token;
        existing.amountOut = amountOut;

        emit InvoiceSettled(invoiceId, invoice.merchant, recipient, token, amountOut);

        _snapshotPrice(invoiceId, token);
    }

    /**
     * @notice Record the oracle's view of the settled token, if an oracle is set.
     *
     * @dev try/catch, and failure is silent. This is the one place where being
     *      lenient is correct: the funds have already reached the merchant by
     *      the time this runs, so reverting on an oracle failure would undo a
     *      completed payment because a price feed was unavailable. An absent
     *      snapshot is a missing log line; a reverted settlement is a merchant
     *      who did not get paid.
     *
     *      When Sprint 3 introduces actual conversion, the price moves from
     *      evidence to input and must be read *before* the release, with
     *      staleness enforced. That is a different function, not a loosening of
     *      this one.
     */
    function _snapshotPrice(uint256 invoiceId, address token) private {
        if (address(priceOracle) == address(0)) return;

        try priceOracle.getPriceUsd(token) returns (
            uint256 value, int8 decimals, uint64 timestamp
        ) {
            emit SettlementPriceSnapshot(invoiceId, token, value, decimals, timestamp);
        } catch {
            // Deliberately ignored; see the note above.
        }
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function getSettlement(uint256 invoiceId)
        external
        view
        returns (FluxaTypes.Settlement memory)
    {
        return _settlements[invoiceId];
    }

    /// @notice True once the invoice has been settled through this contract.
    function isSettled(uint256 invoiceId) external view returns (bool) {
        return _settlements[invoiceId].settledAt != 0;
    }

    /// @notice Where a settlement for this merchant would currently be sent.
    function effectivePayoutAddress(address merchant) external view returns (address) {
        address nominated = payoutAddress[merchant];
        return nominated == address(0) ? merchant : nominated;
    }

    // ---------------------------------------------------------------------
    // Recovery
    // ---------------------------------------------------------------------

    /**
     * @notice Sweep tokens sent directly to this contract.
     * @dev This contract is a conduit — escrow lives in FluxaInvoice and every
     *      release transfers straight to the recipient, so a balance here can
     *      only come from someone transferring in by mistake. Sweeping it
     *      therefore cannot touch customer or merchant funds. The invoice
     *      contract has no equivalent function, and must not: its balance *is*
     *      the escrow.
     */
    function sweep(address token, address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        IERC20(token).safeTransfer(to, amount);
    }
}
