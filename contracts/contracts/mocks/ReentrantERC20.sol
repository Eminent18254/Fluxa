// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

interface IReentrantTarget {
    function payInvoice(uint256 invoiceId) external;
}

/**
 * @title ReentrantERC20
 * @notice Token that calls back into FluxaInvoice during transferFrom.
 *
 * @dev The realistic shape of the attack: an ERC-777-style hook, or any token
 *      whose transfer logic hands control to a third party. Fluxa's allowlist
 *      makes this unlikely in production, but "unlikely" is not a security
 *      property — the reentrancy defence should hold regardless of what is on
 *      the list, and this token is how that gets demonstrated rather than
 *      asserted.
 *
 *      The callback fires once (`_reentered` latches) so a failed attack does
 *      not become infinite recursion, which would surface as an out-of-gas
 *      error and tell us nothing about which guard actually stopped it.
 */
contract ReentrantERC20 is ERC20 {
    uint8 private immutable _decimals;

    /// @dev Named `victim` rather than `target`: ethers v6 puts a `target`
    ///      property on every contract object, and a public state variable of
    ///      that name makes the generated TypeScript types unusable.
    address public victim;
    uint256 public targetInvoiceId;
    bool public attackEnabled;
    bool private _reentered;

    /// @notice Set when the re-entrant call reverted, with its revert data.
    bool public reentrancyReverted;
    bytes public lastRevertData;

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

    function arm(address victim_, uint256 invoiceId) external {
        victim = victim_;
        targetInvoiceId = invoiceId;
        attackEnabled = true;
        _reentered = false;
        reentrancyReverted = false;
    }

    function disarm() external {
        attackEnabled = false;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);

        if (!attackEnabled || _reentered || from == address(0)) return;

        _reentered = true;
        try IReentrantTarget(victim).payInvoice(targetInvoiceId) {
            // Reached only if the guard failed to stop the second entry.
            reentrancyReverted = false;
        } catch (bytes memory reason) {
            reentrancyReverted = true;
            lastRevertData = reason;
        }
    }
}
