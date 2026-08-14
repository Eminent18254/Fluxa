// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {FluxaTypes} from "../libraries/FluxaTypes.sol";

/**
 * @title IFluxaInvoice
 * @notice Interface the settlement contract depends on.
 * @dev Declared separately so FluxaSettlement holds no import of the invoice
 *      implementation, and so tests can substitute a mock.
 */
interface IFluxaInvoice {
    function getInvoice(uint256 invoiceId)
        external
        view
        returns (FluxaTypes.Invoice memory);

    function exists(uint256 invoiceId) external view returns (bool);

    /**
     * @notice Move a PAID invoice to SETTLED and release its escrow.
     * @dev Callable only by the registered settlement contract. Returns the
     *      amount actually transferred so the caller can account for
     *      fee-on-transfer tokens rather than trusting the requested figure.
     */
    function releaseEscrow(uint256 invoiceId, address recipient)
        external
        returns (address token, uint256 amount);
}

/**
 * @title IPriceOracle
 * @notice Seam for FTSOv2.
 *
 * @dev Sprint 2 builds the contract layer; Sprint 3 supplies the FTSOv2-backed
 *      implementation. Declaring the seam now means the settlement logic is
 *      unit-testable with a deterministic mock instead of requiring a live
 *      oracle, and it keeps the FTSO dependency out of the money-moving code.
 *
 * `decimals` is part of the return value on purpose. FTSOv2 exponents differ
 * per feed — XRP/USD reports 6 while FLR/USD reports 8 — so a price without its
 * exponent is not a price. Any implementation must pass through what the oracle
 * returned rather than normalising to a constant.
 */
interface IPriceOracle {
    /**
     * @param token ERC-20 whose USD price is wanted.
     * @return value Raw oracle value.
     * @return decimals Exponent for `value`; price = value / 10**decimals.
     * @return timestamp When the oracle last updated the feed.
     */
    function getPriceUsd(address token)
        external
        view
        returns (uint256 value, int8 decimals, uint64 timestamp);
}
