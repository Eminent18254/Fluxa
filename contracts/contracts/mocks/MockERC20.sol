// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title MockERC20
 * @notice Test token with a configurable decimal count.
 *
 * @dev The decimal count is a constructor argument rather than the ERC20
 *      default of 18 because FXRP and USDT0 on Coston2 are both 6-decimal
 *      (verified on-chain — docs/PHASE-0-FLARE-VALIDATION.md). Testing the
 *      payment path exclusively against an 18-decimal token would leave the
 *      real deployment's decimal handling entirely unexercised.
 */
contract MockERC20 is ERC20 {
    uint8 private immutable _decimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals_)
        ERC20(name_, symbol_)
    {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
