// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IPayment} from "@flarenetwork/flare-periphery-contracts/coston2/IPayment.sol";

/**
 * @title MockFdcVerification
 * @notice Stand-in for Flare's FdcVerification contract.
 *
 * @dev **What this mock does not prove.** It does not verify a Merkle proof. It
 *      answers whatever it has been told to answer. Its purpose is to let
 *      `FluxaFdcPaymentRail`'s own checks — attestation type, source, XRPL status,
 *      payment reference, recipient, amount, replay — be tested exhaustively
 *      offline, which is impossible against the real verifier because producing a
 *      valid proof requires an attested XRPL transaction and a live DA layer.
 *
 *      That the *real* verifier performs real Merkle verification is a separate
 *      claim, proved separately in `FluxaFdcPaymentRail.coston2.test.ts` by handing
 *      the live contract a fabricated proof and watching it refuse.
 *
 *      Deliberately does not inherit `IFdcVerification`: that interface composes
 *      nine attestation-type interfaces, and implementing all of them here would
 *      add a large surface with no bearing on what is under test. The rail casts an
 *      address to `IFdcVerification` and calls it, so matching these two
 *      signatures is sufficient.
 */
contract MockFdcVerification {
    /** @notice Blanket answer for {verifyPayment}. */
    bool public shouldVerify = true;

    /** @notice Protocol id reported to callers. 200 is FDC's real id. */
    uint8 public protocolId = 200;

    /** @notice Per-transaction override, so one proof can be refused among many. */
    mapping(bytes32 => bool) private _forcedRejection;

    function setShouldVerify(bool value) external {
        shouldVerify = value;
    }

    function setProtocolId(uint8 value) external {
        protocolId = value;
    }

    function rejectTransaction(bytes32 transactionId) external {
        _forcedRejection[transactionId] = true;
    }

    /**
     * @dev Must stay `view`. `IFdcVerification` declares it `view`, so the rail
     *      reaches it by STATICCALL — a mock that tried to record calls here would
     *      revert inside the rail and look like a rail bug.
     */
    function verifyPayment(IPayment.Proof calldata _proof) external view returns (bool) {
        if (_forcedRejection[_proof.data.requestBody.transactionId]) return false;
        return shouldVerify;
    }

    function fdcProtocolId() external view returns (uint8) {
        return protocolId;
    }
}
