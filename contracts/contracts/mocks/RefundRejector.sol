// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IPayingOracle {
    function getPriceUsdPaying(address token)
        external
        payable
        returns (uint256 value, int8 decimals, uint64 timestamp);
}

/**
 * @title RefundRejector
 * @notice A contract caller that cannot accept its own fee refund.
 *
 * @dev `FluxaPriceOracle.getPriceUsdPaying` refunds any surplus above the
 *      FeeCalculator fee. An EOA always accepts that transfer, so the failure
 *      branch is unreachable from a normal test and would sit uncovered — which
 *      is exactly the branch worth having, since the alternative to reverting is
 *      the oracle quietly keeping other people's money.
 *
 *      There is deliberately no `receive` or `fallback`, so a plain value
 *      transfer to this contract reverts. It is funded through a payable
 *      constructor instead: a payable constructor lets it hold ether without
 *      giving it any way to be paid afterwards.
 */
contract RefundRejector {
    constructor() payable {}

    function read(address oracle, address token, uint256 value)
        external
        returns (uint256, int8, uint64)
    {
        return IPayingOracle(oracle).getPriceUsdPaying{value: value}(token);
    }
}
