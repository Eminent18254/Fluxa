// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

import {FluxaTypes} from "./libraries/FluxaTypes.sol";

/**
 * @title FluxaInvoice
 * @notice Invoice registry, escrow and Rail A payment for Fluxa.
 *
 * @dev What this contract is responsible for:
 *
 *      1. Recording an invoice a merchant issued, and its lifecycle.
 *      2. Accepting an ERC-20 payment for it (Rail A) and holding the funds in
 *         escrow until settlement.
 *      3. Refusing every state transition that is not legitimate.
 *
 * Escrow rather than direct forwarding is a deliberate choice. Paying the
 * merchant inline would mean the payment and the settlement are the same event,
 * which removes any point at which a cross-asset conversion could happen and
 * gives the merchant no protection against a partial or malformed payment.
 * Holding the funds separates "the customer has paid" from "the merchant has
 * been paid in the asset they wanted".
 *
 * Amounts are always the token's own base units. FXRP and USDT0 are 6-decimal
 * on Coston2 — confirmed on-chain, not assumed — so this contract never scales
 * by a hardcoded 1e18. It moves the units it is given and measures what
 * actually arrived.
 */
contract FluxaInvoice is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------------
    // Errors
    //
    // Custom errors rather than require strings: cheaper, and each one names a
    // specific rejected condition so a failed call is diagnosable from the
    // revert data alone.
    // ---------------------------------------------------------------------

    error InvoiceNotFound(uint256 invoiceId);
    error NotInvoiceMerchant(uint256 invoiceId, address caller);
    error InvalidStatus(uint256 invoiceId, FluxaTypes.Status actual);
    error TokenNotAccepted(address token);
    error ZeroAmount();
    error ZeroAddress();
    error DueDateInPast(uint64 dueAt, uint64 now_);
    error DueDateTooFar(uint64 dueAt, uint64 maxDueAt);
    error NotYetDue(uint256 invoiceId, uint64 dueAt);
    error AlreadyPaid(uint256 invoiceId, address payer);
    error IncorrectPaymentAmount(uint256 expected, uint256 received);
    error ReferenceAlreadyUsed(bytes32 paymentRef);
    error NotSettlementContract(address caller);
    error SettlementContractNotSet();
    error MerchantIsPayer();

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event InvoiceCreated(
        uint256 indexed invoiceId,
        address indexed merchant,
        address indexed payToken,
        uint256 amount,
        uint64 dueAt,
        bytes32 paymentRef
    );

    event InvoicePaid(
        uint256 indexed invoiceId,
        address indexed payer,
        address indexed payToken,
        uint256 amountPaid,
        FluxaTypes.Rail rail
    );

    event InvoiceCancelled(uint256 indexed invoiceId, address indexed merchant);
    event InvoiceExpired(uint256 indexed invoiceId, address indexed caller);

    event EscrowReleased(
        uint256 indexed invoiceId,
        address indexed recipient,
        address indexed token,
        uint256 amount
    );

    event TokenAcceptanceChanged(address indexed token, bool accepted);
    event SettlementContractChanged(address indexed previous, address indexed current);

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    /// @dev Starts at 1 so that id 0 is unambiguously "no invoice".
    uint256 private _nextInvoiceId = 1;

    mapping(uint256 => FluxaTypes.Invoice) private _invoices;

    /// @dev Escrowed balance per invoice, so a token's total balance in this
    ///      contract can never be misattributed between invoices.
    mapping(uint256 => uint256) private _escrow;

    /**
     * @notice Tokens an invoice may be denominated in.
     * @dev An allowlist, not a free-for-all. Without it a merchant could be
     *      induced to accept a worthless or malicious token, and the settlement
     *      contract would have no basis for pricing it.
     */
    mapping(address => bool) public acceptedToken;

    /**
     * @notice References already used, so one XRPL payment reference cannot be
     *         bound to two invoices.
     * @dev This matters for Rail B: the reference is what ties an off-chain
     *      payment to an on-chain invoice, so it must be unique.
     */
    mapping(bytes32 => bool) public referenceUsed;

    /// @notice The only address permitted to release escrow.
    address public settlementContract;

    /// @dev A due date further out than this is almost certainly a unit error
    ///      (milliseconds for seconds, say). 365 days is generous for an invoice.
    uint64 public constant MAX_INVOICE_DURATION = 365 days;

    // ---------------------------------------------------------------------
    // Construction
    // ---------------------------------------------------------------------

    /// @dev No zero-address check on `initialOwner`. Ownable's own constructor
    ///      runs first and reverts with OwnableInvalidOwner, so a check here
    ///      would be unreachable code that reads like a live guard.
    constructor(address initialOwner) Ownable(initialOwner) {}

    // ---------------------------------------------------------------------
    // Modifiers
    // ---------------------------------------------------------------------

    modifier invoiceExists(uint256 invoiceId) {
        if (_invoices[invoiceId].merchant == address(0)) {
            revert InvoiceNotFound(invoiceId);
        }
        _;
    }

    modifier onlyMerchantOf(uint256 invoiceId) {
        if (_invoices[invoiceId].merchant != msg.sender) {
            revert NotInvoiceMerchant(invoiceId, msg.sender);
        }
        _;
    }

    // ---------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------

    /// @notice Add or remove a token from the invoice-denomination allowlist.
    function setAcceptedToken(address token, bool accepted) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        acceptedToken[token] = accepted;
        emit TokenAcceptanceChanged(token, accepted);
    }

    /**
     * @notice Set the contract permitted to release escrow.
     * @dev Ownable2Step governs this. Escrow release is the only privileged
     *      money movement in the system, so it is restricted to one address
     *      rather than to a role that could be granted broadly.
     */
    function setSettlementContract(address settlement) external onlyOwner {
        if (settlement == address(0)) revert ZeroAddress();
        address previous = settlementContract;
        settlementContract = settlement;
        emit SettlementContractChanged(previous, settlement);
    }

    /// @notice Halt invoice creation and payment. Does not block cancellation,
    ///         expiry, or settlement of invoices already paid — funds already
    ///         escrowed must always be able to reach their merchant.
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ---------------------------------------------------------------------
    // Invoice lifecycle
    // ---------------------------------------------------------------------

    /**
     * @notice Issue an invoice.
     * @param payToken ERC-20 the invoice is denominated in; must be accepted.
     * @param amount Base units of `payToken` owed. Not a USD figure — the USD
     *        price is converted off-chain against FTSOv2 and frozen at creation,
     *        so the customer pays the amount the merchant quoted rather than a
     *        figure that moves with the oracle between quote and payment.
     * @param dueAt Unix seconds after which the invoice may be expired.
     * @param paymentRef 32-byte payment reference, unique across all invoices.
     *        On Rail B this is what an XRPL payment carries to identify the
     *        invoice it settles. `reference` is a reserved word in Solidity, so
     *        the field is named `paymentRef` throughout.
     */
    function createInvoice(
        address payToken,
        uint256 amount,
        uint64 dueAt,
        bytes32 paymentRef
    ) external whenNotPaused returns (uint256 invoiceId) {
        if (!acceptedToken[payToken]) revert TokenNotAccepted(payToken);
        if (amount == 0) revert ZeroAmount();
        if (dueAt <= block.timestamp) {
            revert DueDateInPast(dueAt, uint64(block.timestamp));
        }

        uint64 maxDueAt = uint64(block.timestamp) + MAX_INVOICE_DURATION;
        if (dueAt > maxDueAt) revert DueDateTooFar(dueAt, maxDueAt);

        if (paymentRef != bytes32(0)) {
            if (referenceUsed[paymentRef]) revert ReferenceAlreadyUsed(paymentRef);
            referenceUsed[paymentRef] = true;
        }

        invoiceId = _nextInvoiceId++;

        _invoices[invoiceId] = FluxaTypes.Invoice({
            merchant: msg.sender,
            payToken: payToken,
            amount: amount,
            amountPaid: 0,
            createdAt: uint64(block.timestamp),
            dueAt: dueAt,
            paidAt: 0,
            payer: address(0),
            status: FluxaTypes.Status.CREATED,
            rail: FluxaTypes.Rail.FLARE_ERC20,
            paymentRef: paymentRef
        });

        emit InvoiceCreated(
            invoiceId, msg.sender, payToken, amount, dueAt, paymentRef
        );
    }

    /**
     * @notice Pay an invoice with the ERC-20 it is denominated in (Rail A).
     *
     * @dev No FDC attestation is involved and none is needed: the transfer
     *      lands in this contract's own state, so asking an attestation
     *      protocol to prove it would be proving a fact the verifier already
     *      knows. That was a flaw in the original design; see
     *      docs/PHASE-0-FLARE-VALIDATION.md §2.3.
     *
     *      The balance is measured before and after the transfer rather than
     *      trusting `amount`. A fee-on-transfer or rebasing token would
     *      otherwise let an invoice be marked PAID while less than the full
     *      amount actually arrived, and the merchant would absorb the shortfall
     *      at settlement.
     *
     *      Effects are written before the external transfer and the function is
     *      nonReentrant, so a malicious token's callback finds the invoice
     *      already PAID and cannot pay it twice.
     */
    function payInvoice(uint256 invoiceId)
        external
        nonReentrant
        whenNotPaused
        invoiceExists(invoiceId)
    {
        FluxaTypes.Invoice storage invoice = _invoices[invoiceId];

        if (invoice.status != FluxaTypes.Status.CREATED) {
            // Distinguish "someone already paid this" from a generic bad state,
            // because the payer needs to know their funds are not required.
            if (
                invoice.status == FluxaTypes.Status.PAID
                    || invoice.status == FluxaTypes.Status.SETTLED
            ) {
                revert AlreadyPaid(invoiceId, invoice.payer);
            }
            revert InvalidStatus(invoiceId, invoice.status);
        }

        // An invoice past its due date is not payable, whether or not anyone has
        // called expireInvoice() yet. Relying on the explicit call would make
        // payability depend on whether a keeper happened to run.
        if (block.timestamp > invoice.dueAt) {
            revert InvalidStatus(invoiceId, FluxaTypes.Status.EXPIRED);
        }

        // A merchant paying their own invoice is meaningless and would let them
        // manufacture a settled invoice history.
        if (msg.sender == invoice.merchant) revert MerchantIsPayer();

        IERC20 token = IERC20(invoice.payToken);
        uint256 expected = invoice.amount;

        // Effects first.
        invoice.status = FluxaTypes.Status.PAID;
        invoice.payer = msg.sender;
        invoice.paidAt = uint64(block.timestamp);
        invoice.rail = FluxaTypes.Rail.FLARE_ERC20;

        // Interaction, with the actual delta measured.
        uint256 balanceBefore = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), expected);
        uint256 received = token.balanceOf(address(this)) - balanceBefore;

        // A token that delivers less than face value cannot satisfy an invoice:
        // the merchant is owed `expected`, and accepting less would silently
        // move the loss onto them.
        if (received != expected) {
            revert IncorrectPaymentAmount(expected, received);
        }

        invoice.amountPaid = received;
        _escrow[invoiceId] = received;

        emit InvoicePaid(
            invoiceId,
            msg.sender,
            invoice.payToken,
            received,
            FluxaTypes.Rail.FLARE_ERC20
        );
    }

    /**
     * @notice Cancel an unpaid invoice.
     * @dev Merchant only, and only while nobody has paid. Once funds are
     *      escrowed the invoice is a financial record, not a draft.
     */
    function cancelInvoice(uint256 invoiceId)
        external
        invoiceExists(invoiceId)
        onlyMerchantOf(invoiceId)
    {
        FluxaTypes.Invoice storage invoice = _invoices[invoiceId];

        if (invoice.status != FluxaTypes.Status.CREATED) {
            revert InvalidStatus(invoiceId, invoice.status);
        }

        invoice.status = FluxaTypes.Status.CANCELLED;
        emit InvoiceCancelled(invoiceId, msg.sender);
    }

    /**
     * @notice Mark an overdue, unpaid invoice as expired.
     * @dev Permissionless by design. Expiry is a fact about the clock, not a
     *      privilege, and making it callable by anyone means the on-chain state
     *      can be brought in line with reality without the merchant acting.
     *      A PAID invoice is never expirable — the money arrived in time.
     */
    function expireInvoice(uint256 invoiceId) external invoiceExists(invoiceId) {
        FluxaTypes.Invoice storage invoice = _invoices[invoiceId];

        if (invoice.status != FluxaTypes.Status.CREATED) {
            revert InvalidStatus(invoiceId, invoice.status);
        }
        if (block.timestamp <= invoice.dueAt) {
            revert NotYetDue(invoiceId, invoice.dueAt);
        }

        invoice.status = FluxaTypes.Status.EXPIRED;
        emit InvoiceExpired(invoiceId, msg.sender);
    }

    // ---------------------------------------------------------------------
    // Settlement hook
    // ---------------------------------------------------------------------

    /**
     * @notice Release a paid invoice's escrow and mark it SETTLED.
     * @dev Callable only by the settlement contract. Deliberately not pausable:
     *      once a customer's funds are held, the path to the merchant must stay
     *      open regardless of admin state.
     *
     *      Double settlement is prevented by the status check plus zeroing the
     *      escrow before transferring — a second call finds status SETTLED and
     *      reverts, and even if it did not, the escrow is already zero.
     */
    function releaseEscrow(uint256 invoiceId, address recipient)
        external
        nonReentrant
        invoiceExists(invoiceId)
        returns (address token, uint256 amount)
    {
        if (settlementContract == address(0)) revert SettlementContractNotSet();
        if (msg.sender != settlementContract) {
            revert NotSettlementContract(msg.sender);
        }
        if (recipient == address(0)) revert ZeroAddress();

        FluxaTypes.Invoice storage invoice = _invoices[invoiceId];
        if (invoice.status != FluxaTypes.Status.PAID) {
            revert InvalidStatus(invoiceId, invoice.status);
        }

        token = invoice.payToken;
        amount = _escrow[invoiceId];
        if (amount == 0) revert ZeroAmount();

        // Effects before interaction.
        _escrow[invoiceId] = 0;
        invoice.status = FluxaTypes.Status.SETTLED;

        IERC20(token).safeTransfer(recipient, amount);

        emit EscrowReleased(invoiceId, recipient, token, amount);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function getInvoice(uint256 invoiceId)
        external
        view
        invoiceExists(invoiceId)
        returns (FluxaTypes.Invoice memory)
    {
        return _invoices[invoiceId];
    }

    function exists(uint256 invoiceId) external view returns (bool) {
        return _invoices[invoiceId].merchant != address(0);
    }

    function escrowOf(uint256 invoiceId) external view returns (uint256) {
        return _escrow[invoiceId];
    }

    function nextInvoiceId() external view returns (uint256) {
        return _nextInvoiceId;
    }

    /// @notice True when the invoice is payable right now.
    /// @dev Folds the status and clock checks into one call so the UI does not
    ///      have to reimplement the rule and risk disagreeing with the contract.
    function isPayable(uint256 invoiceId) external view returns (bool) {
        FluxaTypes.Invoice storage invoice = _invoices[invoiceId];
        return invoice.merchant != address(0)
            && invoice.status == FluxaTypes.Status.CREATED
            && block.timestamp <= invoice.dueAt;
    }
}

