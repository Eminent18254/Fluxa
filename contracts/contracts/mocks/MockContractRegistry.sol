// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title MockContractRegistry
 * @notice Stand-in for the Flare Contract Registry.
 *
 * @dev The reason `FluxaPriceOracle` takes its registry as a constructor
 *      argument rather than hardcoding the canonical address: on a local chain
 *      that address holds no code, so every protocol lookup reverts and none of
 *      the oracle's logic can be reached. With this in its place the whole
 *      contract is testable offline, and the deploy script asserts the real
 *      address is used on a real network.
 *
 *      `getContractAddressByHash` returns `address(0)` for unknown keys rather
 *      than reverting, matching the real registry — which is precisely the
 *      behaviour that makes the oracle's own zero-check necessary.
 */
contract MockContractRegistry {
    mapping(bytes32 nameHash => address) private _addresses;

    function setAddress(string calldata name, address addr) external {
        _addresses[keccak256(abi.encode(name))] = addr;
    }

    function getContractAddressByName(string calldata _name) external view returns (address) {
        return _addresses[keccak256(abi.encode(_name))];
    }

    function getContractAddressByHash(bytes32 _nameHash) external view returns (address) {
        return _addresses[_nameHash];
    }
}
