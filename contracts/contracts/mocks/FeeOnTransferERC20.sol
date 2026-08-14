// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title FeeOnTransferERC20
 * @notice Token that delivers less than the requested amount.
 *
 * @dev Exists to prove FluxaInvoice.payInvoice measures the balance delta
 *      instead of trusting the amount it asked for. Without this token that
 *      defence is untested code: a plain mock always delivers face value, so
 *      the before/after measurement and the naive `amount` assignment behave
 *      identically and the test suite cannot tell them apart.
 *
 *      The fee is burned rather than routed to a collector — where it goes is
 *      irrelevant to the property under test, which is only that the recipient
 *      receives less than was sent.
 */
contract FeeOnTransferERC20 is ERC20 {
    uint8 private immutable _decimals;

    /// @notice Fee in basis points, taken out of every transfer.
    uint256 public feeBps;

    constructor(string memory name_, string memory symbol_, uint8 decimals_, uint256 feeBps_)
        ERC20(name_, symbol_)
    {
        _decimals = decimals_;
        feeBps = feeBps_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setFeeBps(uint256 feeBps_) external {
        feeBps = feeBps_;
    }

    /**
     * @dev Overriding _update rather than transfer/transferFrom so the fee also
     *      applies on the transferFrom path that SafeERC20 uses. Minting and
     *      burning are left untouched, otherwise setting up test balances would
     *      itself be lossy and the arithmetic in each test would stop being
     *      obvious.
     */
    function _update(address from, address to, uint256 value) internal override {
        if (from == address(0) || to == address(0) || feeBps == 0) {
            super._update(from, to, value);
            return;
        }

        uint256 fee = (value * feeBps) / 10_000;
        super._update(from, to, value - fee);
        if (fee > 0) super._update(from, address(0), fee);
    }
}
