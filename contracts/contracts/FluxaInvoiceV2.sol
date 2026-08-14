// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IFluxaQuoteOracle {
    function quoteTokenAmount(address token, uint256 usdAmount) external view returns (uint256);
}

interface IFluxaSettlementReservation {
    function reserveSettlement(uint256 invoiceId) external;
}

contract FluxaInvoiceV2 is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // Ordinals deliberately mirror FluxaTypes.Status for indexer compatibility.
    enum Status { CREATED, PENDING, PAID, SETTLED, CANCELLED, EXPIRED }
    struct Invoice {
        address merchant;
        address settlementToken;
        uint256 usdAmount;
        uint64 createdAt;
        uint64 dueAt;
        uint64 paidAt;
        address payer;
        address paidToken;
        uint256 amountPaid;
        Status status;
        bytes32 paymentRef;
    }

    error InvalidInvoice(uint256 invoiceId);
    error InvalidConfiguration();
    error UnsupportedPaymentToken(address token);
    error InvalidStatus(uint256 invoiceId, Status status);
    error MerchantIsPayer();
    error NotSettlement(address caller);
    error SettlementNotConfigured();
    error QuoteExceeded(uint256 quoted, uint256 maximum);
    error IncorrectPaymentAmount(uint256 expected, uint256 received);
    error NotInvoiceMerchant(uint256 invoiceId, address caller);
    error NotYetDue(uint256 invoiceId, uint64 dueAt);

    event InvoiceCreatedV2(uint256 indexed invoiceId, address indexed merchant, address indexed settlementToken, uint256 usdAmount, uint64 dueAt, bytes32 paymentRef);
    event PaymentOptionSet(uint256 indexed invoiceId, address indexed token);
    event InvoicePaid(uint256 indexed invoiceId, address indexed payer, address indexed payToken, uint256 amountPaid, uint8 rail);
    event EscrowReleased(uint256 indexed invoiceId, address indexed settlement, address indexed token, uint256 amount);
    event InvoiceSettled(uint256 indexed invoiceId);
    event InvoiceCancelled(uint256 indexed invoiceId, address indexed merchant);
    event InvoiceExpired(uint256 indexed invoiceId, address indexed caller);

    uint256 private _nextInvoiceId = 1;
    mapping(uint256 => Invoice) private _invoices;
    mapping(uint256 => mapping(address => bool)) private _paymentOptions;
    mapping(uint256 => address[]) private _paymentTokens;
    mapping(bytes32 => bool) public referenceUsed;
    mapping(address => bool) public acceptedToken;
    address public settlementContract;
    IFluxaQuoteOracle public immutable priceOracle;

    constructor(address owner_, address oracle_) Ownable(owner_) {
        if (oracle_ == address(0)) revert InvalidConfiguration();
        priceOracle = IFluxaQuoteOracle(oracle_);
    }

    function setAcceptedToken(address token, bool accepted) external onlyOwner {
        if (token == address(0)) revert InvalidConfiguration();
        acceptedToken[token] = accepted;
    }

    function setSettlementContract(address settlement) external onlyOwner {
        if (settlement == address(0)) revert InvalidConfiguration();
        settlementContract = settlement;
    }

    function createInvoice(address[] calldata payTokens, address settlementToken, uint256 usdAmount, uint64 dueAt, bytes32 paymentRef) external returns (uint256 id) {
        if (payTokens.length == 0 || !acceptedToken[settlementToken] || usdAmount == 0 || dueAt <= block.timestamp || paymentRef == bytes32(0) || referenceUsed[paymentRef]) revert InvalidConfiguration();
        referenceUsed[paymentRef] = true;
        id = _nextInvoiceId++;
        _invoices[id] = Invoice(msg.sender, settlementToken, usdAmount, uint64(block.timestamp), dueAt, 0, address(0), address(0), 0, Status.CREATED, paymentRef);
        for (uint256 i; i < payTokens.length; ++i) {
            address token = payTokens[i];
            if (!acceptedToken[token] || _paymentOptions[id][token]) revert InvalidConfiguration();
            _paymentOptions[id][token] = true;
            _paymentTokens[id].push(token);
            emit PaymentOptionSet(id, token);
        }
        emit InvoiceCreatedV2(id, msg.sender, settlementToken, usdAmount, dueAt, paymentRef);
    }

    function quotePaymentAmount(uint256 id, address token) public view returns (uint256) {
        _require(id);
        if (!_paymentOptions[id][token]) revert UnsupportedPaymentToken(token);
        return priceOracle.quoteTokenAmount(token, _invoices[id].usdAmount);
    }

    function payInvoice(uint256 id, address token, uint256 maxAmount) external nonReentrant {
        Invoice storage inv = _require(id);
        if (inv.status != Status.CREATED || block.timestamp > inv.dueAt) revert InvalidStatus(id, inv.status);
        if (msg.sender == inv.merchant) revert MerchantIsPayer();
        uint256 amount = quotePaymentAmount(id, token);
        if (amount > maxAmount) revert QuoteExceeded(amount, maxAmount);
        IERC20 paymentToken = IERC20(token);
        uint256 balanceBefore = paymentToken.balanceOf(address(this));
        paymentToken.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = paymentToken.balanceOf(address(this)) - balanceBefore;
        if (received != amount) revert IncorrectPaymentAmount(amount, received);
        inv.status = Status.PAID;
        inv.payer = msg.sender;
        inv.paidToken = token;
        inv.amountPaid = received;
        inv.paidAt = uint64(block.timestamp);
        if (settlementContract == address(0)) revert SettlementNotConfigured();
        IFluxaSettlementReservation(settlementContract).reserveSettlement(id);
        emit InvoicePaid(id, msg.sender, token, received, 0);
    }

    function releaseEscrow(uint256 id) external nonReentrant returns (Invoice memory inv) {
        if (msg.sender != settlementContract) revert NotSettlement(msg.sender);
        inv = _require(id);
        if (inv.status != Status.PAID) revert InvalidStatus(id, inv.status);
        _invoices[id].status = Status.SETTLED;
        IERC20(inv.paidToken).safeTransfer(msg.sender, inv.amountPaid);
        emit EscrowReleased(id, msg.sender, inv.paidToken, inv.amountPaid);
        emit InvoiceSettled(id);
    }

    function cancelInvoice(uint256 id) external {
        Invoice storage inv = _require(id);
        if (msg.sender != inv.merchant) revert NotInvoiceMerchant(id, msg.sender);
        if (inv.status != Status.CREATED) revert InvalidStatus(id, inv.status);
        inv.status = Status.CANCELLED;
        emit InvoiceCancelled(id, msg.sender);
    }

    function expireInvoice(uint256 id) external {
        Invoice storage inv = _require(id);
        if (inv.status != Status.CREATED) revert InvalidStatus(id, inv.status);
        if (block.timestamp <= inv.dueAt) revert NotYetDue(id, inv.dueAt);
        inv.status = Status.EXPIRED;
        emit InvoiceExpired(id, msg.sender);
    }

    function acceptsPaymentToken(uint256 id, address token) external view returns (bool) { return _paymentOptions[id][token]; }
    function paymentTokens(uint256 id) external view returns (address[] memory) { return _paymentTokens[id]; }
    function getInvoice(uint256 id) external view returns (Invoice memory) { return _require(id); }
    function nextInvoiceId() external view returns (uint256) { return _nextInvoiceId; }

    function _require(uint256 id) private view returns (Invoice storage inv) {
        inv = _invoices[id];
        if (inv.merchant == address(0)) revert InvalidInvoice(id);
    }
}
