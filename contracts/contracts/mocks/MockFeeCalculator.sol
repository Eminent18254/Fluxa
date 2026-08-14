// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title MockFeeCalculator
 * @notice Stand-in for Flare's FeeCalculator.
 *
 * @dev Exists so the fee-paying path in `FluxaPriceOracle.getPriceUsdPaying`
 *      can be exercised with a non-zero fee. On Coston2 the fee for Fluxa's
 *      feeds is zero, which means the live network cannot test the branch that
 *      matters if it ever changes.
 */
contract MockFeeCalculator {
    uint256 public feePerFeed;

    function setFeePerFeed(uint256 value) external {
        feePerFeed = value;
    }

    function calculateFeeByIds(bytes21[] memory _feedIds) external view returns (uint256 _fee) {
        return feePerFeed * _feedIds.length;
    }

    function calculateFeeByIndices(uint256[] memory _indices) external view returns (uint256 _fee) {
        return feePerFeed * _indices.length;
    }
}
