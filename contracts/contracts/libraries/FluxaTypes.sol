// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title FluxaTypes
 * @notice Shared enums and structs for the Fluxa contract system.
 * @dev Kept in one file so the invoice and settlement contracts cannot drift
 *      apart on the state machine, which is the thing most likely to be
 *      duplicated inconsistently.
 */
library FluxaTypes {
    /**
     * @notice Invoice lifecycle.
     *
     * Valid transitions — anything not listed here is rejected:
     *
     *   CREATED   -> PENDING | CANCELLED | EXPIRED
     *   PENDING   -> PAID    | EXPIRED
     *   PAID      -> SETTLED
     *   SETTLED   terminal
     *   CANCELLED terminal
     *   EXPIRED   terminal
     *
     * PENDING exists for Rail B: an XRPL payment has been observed but its FDC
     * attestation has not yet been verified on Flare. On Rail A a payment moves
     * CREATED -> PAID in a single transaction, because the ERC-20 transfer and
     * the state change happen atomically in the same call.
     */
    enum Status {
        CREATED,
        PENDING,
        PAID,
        SETTLED,
        CANCELLED,
        EXPIRED
    }

    /**
     * @notice Which rail a payment arrived on.
     * @dev FLARE_ERC20 needs no attestation: the transfer is already in this
     *      contract's own state. XRPL_NATIVE requires an FDC Merkle proof,
     *      verified in Sprint 3.
     */
    enum Rail {
        FLARE_ERC20,
        XRPL_NATIVE
    }

    /**
     * @notice A single invoice.
     *
     * @dev Field ordering is deliberate: the four small types are packed to
     *      share a slot with `merchant`, and the two amounts occupy full slots
     *      because they are uint256.
     *
     * `amount` is in the token's own base units. FXRP and USDT0 are 6-decimal
     * on Coston2 (verified on-chain, see docs/PHASE-0-FLARE-VALIDATION.md), so
     * an 18-decimal assumption anywhere in the payment path is a 10^12 error.
     * This contract never assumes a decimal count; it moves whatever units the
     * token defines.
     */
    struct Invoice {
        address merchant;      // who gets paid
        address payToken;      // ERC-20 the invoice is denominated in
        uint256 amount;        // base units of payToken owed
        uint256 amountPaid;    // base units actually escrowed
        uint64 createdAt;
        uint64 dueAt;          // after this, expireInvoice() may be called
        uint64 paidAt;
        address payer;         // who paid; zero until payment
        Status status;
        Rail rail;
        bytes32 paymentRef;    // 32-byte payment reference, unique per invoice
    }

    /// @notice Record of a completed settlement.
    struct Settlement {
        address settledTo;
        address settleToken;
        uint256 amountOut;
        uint64 settledAt;
    }
}
