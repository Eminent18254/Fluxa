// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {FluxaInvoiceV2} from "./FluxaInvoiceV2.sol";
import {IPriceOracle} from "./interfaces/IFluxa.sol";

contract FluxaSettlementV2 is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    error InsufficientReserve(address token, uint256 required, uint256 available);
    error AlreadySettled();
    error ZeroAddress();
    error NotInvoiceContract(address caller);
    error SettlementNotReserved(uint256 invoiceId);
    event ReserveFunded(address indexed token, address indexed funder, uint256 amount);
    event ReserveWithdrawn(address indexed token, address indexed recipient, uint256 amount);
    event InvoiceSettled(uint256 indexed invoiceId, address indexed merchant, address indexed recipient, address token, uint256 amountOut);
    event ConversionRecorded(uint256 indexed invoiceId, address indexed paidToken, uint256 paidAmount, address indexed settlementToken, uint256 settlementAmount);

    FluxaInvoiceV2 public immutable invoiceContract;
    IPriceOracle public priceOracle;
    mapping(uint256 => bool) public settled;
    mapping(address => address) public payoutAddress;
    mapping(uint256 => uint256) public reservedAmount;
    mapping(uint256 => address) public reservedToken;
    mapping(address => uint256) public totalReserved;

    constructor(address owner_, address invoice_, address oracle_) Ownable(owner_) {
        if (invoice_ == address(0) || oracle_ == address(0)) revert ZeroAddress();
        invoiceContract = FluxaInvoiceV2(invoice_);
        priceOracle = IPriceOracle(oracle_);
    }
    function setPriceOracle(address oracle_) external onlyOwner {
        if (oracle_ == address(0)) revert ZeroAddress();
        priceOracle = IPriceOracle(oracle_);
    }
    function setPayoutAddress(address recipient) external { payoutAddress[msg.sender] = recipient; }
    function fundReserve(address token, uint256 amount) external {
        if (token == address(0) || amount == 0) revert ZeroAddress();
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        emit ReserveFunded(token, msg.sender, amount);
    }
    function withdrawReserve(address token, address recipient, uint256 amount) external onlyOwner {
        if (recipient == address(0)) revert ZeroAddress();
        uint256 balance = IERC20(token).balanceOf(address(this));
        uint256 available = balance > totalReserved[token]
            ? balance - totalReserved[token]
            : 0;
        if (amount > available) revert InsufficientReserve(token, amount, available);
        IERC20(token).safeTransfer(recipient, amount);
        emit ReserveWithdrawn(token, recipient, amount);
    }

    function reserveSettlement(uint256 id) external {
        if (msg.sender != address(invoiceContract)) revert NotInvoiceContract(msg.sender);
        if (reservedAmount[id] != 0) revert AlreadySettled();
        FluxaInvoiceV2.Invoice memory inv = invoiceContract.getInvoice(id);
        uint256 required = inv.paidToken == inv.settlementToken
            ? inv.amountPaid
            : IFluxaQuoteOracleV2(address(priceOracle)).quoteTokenAmount(inv.settlementToken, inv.usdAmount);
        if (inv.paidToken != inv.settlementToken) {
            uint256 balance = IERC20(inv.settlementToken).balanceOf(address(this));
            uint256 available = balance > totalReserved[inv.settlementToken]
                ? balance - totalReserved[inv.settlementToken]
                : 0;
            if (available < required) revert InsufficientReserve(inv.settlementToken, required, available);
            totalReserved[inv.settlementToken] += required;
        }
        reservedAmount[id] = required;
        reservedToken[id] = inv.settlementToken;
    }

    function capacityFor(uint256 id, address payToken)
        external
        view
        returns (uint256 required, uint256 available, bool sufficient)
    {
        FluxaInvoiceV2.Invoice memory inv = invoiceContract.getInvoice(id);
        required = payToken == inv.settlementToken
            ? invoiceContract.quotePaymentAmount(id, payToken)
            : IFluxaQuoteOracleV2(address(priceOracle)).quoteTokenAmount(inv.settlementToken, inv.usdAmount);
        if (payToken == inv.settlementToken) return (required, type(uint256).max, true);
        uint256 balance = IERC20(inv.settlementToken).balanceOf(address(this));
        available = balance > totalReserved[inv.settlementToken]
            ? balance - totalReserved[inv.settlementToken]
            : 0;
        sufficient = available >= required;
    }

    function settleInvoice(uint256 id) external nonReentrant returns (uint256 outputAmount) {
        if (settled[id]) revert AlreadySettled();
        uint256 reserved = reservedAmount[id];
        if (reserved == 0) revert SettlementNotReserved(id);
        FluxaInvoiceV2.Invoice memory inv = invoiceContract.releaseEscrow(id);
        settled[id] = true;
        address recipient = payoutAddress[inv.merchant] == address(0) ? inv.merchant : payoutAddress[inv.merchant];
        if (inv.paidToken == inv.settlementToken) {
            outputAmount = reserved;
            IERC20(inv.paidToken).safeTransfer(recipient, outputAmount);
        } else {
            outputAmount = reserved;
            totalReserved[inv.settlementToken] -= outputAmount;
            IERC20(inv.settlementToken).safeTransfer(recipient, outputAmount);
            // The paid asset remains in this contract and replenishes the other
            // side of the reserve inventory; no value is fabricated by FTSO.
        }
        delete reservedAmount[id];
        delete reservedToken[id];
        emit InvoiceSettled(id, inv.merchant, recipient, inv.settlementToken, outputAmount);
        emit ConversionRecorded(id, inv.paidToken, inv.amountPaid, inv.settlementToken, outputAmount);
    }

}

interface IFluxaQuoteOracleV2 {
    function quoteTokenAmount(address token, uint256 usdAmount) external view returns (uint256);
}
