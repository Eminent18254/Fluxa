// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

import {IFlareContractRegistry} from
    "@flarenetwork/flare-periphery-contracts/coston2/IFlareContractRegistry.sol";
import {IFdcVerification} from
    "@flarenetwork/flare-periphery-contracts/coston2/IFdcVerification.sol";
import {IPayment} from "@flarenetwork/flare-periphery-contracts/coston2/IPayment.sol";

import {FluxaTypes} from "./libraries/FluxaTypes.sol";
import {IFluxaInvoice} from "./interfaces/IFluxa.sol";

/**
 * @dev The one call this rail needs that {IFluxaInvoice} does not expose.
 *
 *      Declared here rather than added to `interfaces/IFluxa.sol` because that
 *      file is Sprint 2's seam between the invoice and settlement contracts, and
 *      widening it would change a shipped interface to serve a later sprint. The
 *      rail is a *client* of FluxaInvoice, not a peer of it.
 */
interface IFluxaPayable {
    function payInvoice(uint256 invoiceId) external;
}

/**
 * @title FluxaFdcPaymentRail
 * @notice Rail B — settles a Fluxa invoice against a native XRP payment made on
 *         the XRP Ledger, proven on Flare by the Flare Data Connector.
 *
 * @dev ## Why this is a separate contract
 *
 *      Rail A (`FluxaInvoice.payInvoice`) needs no attestation: the ERC-20
 *      transfer lands in the invoice contract's own state, so asking FDC to prove
 *      it would be proving something the verifier already knows. That circularity
 *      was the flaw found in the original design — see
 *      docs/PHASE-0-FLARE-VALIDATION.md §2.3. Rail B is the case where FDC is
 *      genuinely load-bearing, because the payment happens on a chain Flare
 *      cannot see.
 *
 *      The obvious implementation would be a privileged "mark this invoice paid"
 *      hook on FluxaInvoice. It was rejected: `releaseEscrow` reverts
 *      `ZeroAmount()` when escrow is empty, so an invoice marked PAID without
 *      funds on Flare would be permanently unsettleable. Making that work means
 *      changing `releaseEscrow`, the escrow accounting and the settlement path —
 *      a far larger edit to shipped Sprint 2 code than it first appears.
 *
 *      So this rail **fronts liquidity** instead. It verifies the XRPL payment,
 *      then pays the invoice through the ordinary `payInvoice` entry point using
 *      its own FXRP. Escrow, settlement and the state machine are untouched and
 *      untouchable: from FluxaInvoice's perspective this is just another payer.
 *      The rail operator has been paid in real XRP on the XRP Ledger, and holds
 *      FXRP on Flare — that is the trade they are making, and the attestation is
 *      what makes it safe to make.
 *
 *      ## What this costs, stated plainly
 *
 *      Because the payment goes through `payInvoice`, the invoice records
 *      `rail = FLARE_ERC20` and `payer = address(this)`. The invoice itself does
 *      not know it was paid from XRPL. The true provenance — XRPL transaction id,
 *      source account, drops received, attesting voting round — lives in this
 *      contract's `recordOf(invoiceId)` and in {XrplPaymentAccepted}. An indexer
 *      that wants the full picture joins on invoice id. That indirection is the
 *      price of not modifying Sprint 2, and it is the right trade: a wrong edit to
 *      escrow accounting loses money, a join does not.
 *
 *      Second cost: `payInvoice` rejects an invoice past `dueAt`, measured at
 *      proof-submission time rather than payment time. A customer who paid on time
 *      but whose proof arrives late is refused. FDC voting rounds are 90 seconds,
 *      so the practical requirement is that a proof be submitted within a couple
 *      of minutes of the deadline. Merchants should not set knife-edge due dates.
 *
 *      ## Why drops compare directly against FXRP base units
 *
 *      One XRP drop is 1e-6 XRP, and FXRP carries 6 decimals — confirmed on-chain
 *      in Phase 0 §2.1, and re-proved against the live FAssets AssetManager
 *      (`assetMintingDecimals() == 6`). So a drop and an FXRP base unit are the
 *      same quantity of value, and `receivedAmount >= invoice.amount` is a
 *      meaningful solvency check rather than a unit confusion. If FAssets ever
 *      changes minting decimals this assumption breaks, which is why
 *      {ASSET_MINTING_DECIMALS} is asserted against the token at bind time.
 */
contract FluxaFdcPaymentRail is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error ZeroAddress();
    error RegistryLookupFailed(bytes32 key);

    error NotInvoiceMerchant(address caller, address merchant);
    error InvoiceNotFound(uint256 invoiceId);
    error InvoiceNotOpen(uint256 invoiceId, FluxaTypes.Status status);
    error UnsupportedPayToken(address payToken, address expected);
    error MissingPaymentReference(uint256 invoiceId);
    error AlreadyBound(uint256 invoiceId);
    error InvoiceNotBound(uint256 invoiceId);
    error ZeroReceivingAddressHash();
    error InsufficientCommitment(uint256 minimumDrops, uint256 invoiceAmount);
    error UnexpectedAssetDecimals(uint8 actual, uint8 expected);

    error UnexpectedAttestationType(bytes32 actual, bytes32 expected);
    error UnexpectedSource(bytes32 actual, bytes32 expected);
    error ProofRejected(bytes32 transactionId);
    error TransactionAlreadyUsed(bytes32 transactionId);
    error XrplPaymentFailed(uint8 status);
    error ReferenceMismatch(bytes32 actual, bytes32 expected);
    error RecipientMismatch(bytes32 actual, bytes32 expected);
    error NonPositiveAmount(int256 receivedAmount);
    error AmountBelowCommitment(uint256 received, uint256 required);
    error PaymentPredatesInvoice(uint64 paidAt, uint64 invoiceCreatedAt);
    error InsufficientLiquidity(uint256 required, uint256 available);

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event InvoiceBound(
        uint256 indexed invoiceId,
        address indexed merchant,
        bytes32 receivingAddressHash,
        bytes32 paymentReference,
        uint256 minimumDrops
    );

    /**
     * @notice An XRPL payment was proven and used to pay a Fluxa invoice.
     * @dev This is the record of cross-chain provenance. `FluxaInvoice` will show
     *      this contract as the payer, so anything reconstructing "who really paid"
     *      must read this event or {recordOf}.
     */
    event XrplPaymentAccepted(
        uint256 indexed invoiceId,
        bytes32 indexed transactionId,
        bytes32 indexed sourceAddressHash,
        uint256 dropsReceived,
        uint256 fxrpFronted,
        uint64 votingRound
    );

    event LiquidityDeposited(address indexed from, uint256 amount);
    event LiquidityWithdrawn(address indexed to, uint256 amount);

    // ---------------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------------

    /**
     * @notice The Flare Contract Registry address, identical on every Flare
     *         network. Recorded for cross-checking a constructor argument.
     * @dev Same reasoning as {FluxaPriceOracle}: the registry is passed in so
     *      tests can substitute a mock, and this constant is what the deploy
     *      script checks that argument against on a real network.
     */
    address public constant CANONICAL_FLARE_REGISTRY = 0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019;

    bytes32 private constant FDC_VERIFICATION_KEY = keccak256(abi.encode("FdcVerification"));

    /**
     * @notice Attestation type `Payment`, 32-byte right-padded ASCII.
     * @dev Type 0x01, supported for BTC, DOGE and XRP.
     *
     *      The periphery package also ships `IXRPPayment`, an XRP-native type.
     *      `Payment` is used here because its response body carries
     *      `standardPaymentReference` as a `bytes32`, which maps directly onto
     *      `FluxaTypes.Invoice.paymentRef`. `IXRPPayment` replaces that with a raw
     *      memo blob and a destination tag, which would mean parsing bytes to
     *      recover the invoice binding.
     */
    bytes32 public constant ATTESTATION_TYPE_PAYMENT =
        0x5061796d656e7400000000000000000000000000000000000000000000000000;

    /** @notice Source id `testXRP` — the XRPL testnet. */
    bytes32 public constant SOURCE_ID_TEST_XRP =
        0x7465737458525000000000000000000000000000000000000000000000000000;

    /** @notice XRPL transaction status meaning success (1 and 2 are failures). */
    uint8 public constant XRPL_STATUS_SUCCESS = 0;

    /** @notice FXRP minting decimals, which make drops and base units comparable. */
    uint8 public constant ASSET_MINTING_DECIMALS = 6;

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    /** @notice What XRPL payment satisfies a given invoice. */
    struct XrplExpectation {
        /** Standard address hash of the merchant's XRPL account. */
        bytes32 receivingAddressHash;
        /** Copied from the invoice, so Sprint 2's uniqueness guarantee carries. */
        bytes32 paymentReference;
        /** Floor on `receivedAmount`, in drops. */
        uint256 minimumDrops;
        bool bound;
    }

    /** @notice The attested facts about the XRPL payment that paid an invoice. */
    struct XrplPaymentRecord {
        bytes32 transactionId;
        bytes32 sourceAddressHash;
        uint64 xrplBlockNumber;
        uint64 xrplBlockTimestamp;
        uint64 votingRound;
        uint256 dropsReceived;
        uint256 fxrpFronted;
    }

    IFlareContractRegistry public immutable registry;
    IFluxaInvoice public immutable fluxaInvoice;

    /** @notice The FAsset this rail fronts. Must be the invoice's payToken. */
    IERC20 public immutable fxrp;

    /**
     * @notice Guards against one XRPL transaction paying two invoices.
     * @dev Keyed on the XRPL transaction id, which is what the proof is *about*.
     *      The invoice-side `referenceUsed` map stops a reference being reused; this
     *      stops a single payment being presented twice under one reference.
     */
    mapping(bytes32 => bool) public transactionUsed;

    mapping(uint256 => XrplExpectation) private _expectations;
    mapping(uint256 => XrplPaymentRecord) private _records;

    // ---------------------------------------------------------------------
    // Construction
    // ---------------------------------------------------------------------

    constructor(
        address initialOwner,
        address registry_,
        address invoiceContract,
        address fxrp_
    ) Ownable(initialOwner) {
        if (registry_ == address(0)) revert ZeroAddress();
        if (invoiceContract == address(0)) revert ZeroAddress();
        if (fxrp_ == address(0)) revert ZeroAddress();

        registry = IFlareContractRegistry(registry_);
        fluxaInvoice = IFluxaInvoice(invoiceContract);
        fxrp = IERC20(fxrp_);
    }

    // ---------------------------------------------------------------------
    // Binding an invoice to an expected XRPL payment
    // ---------------------------------------------------------------------

    /**
     * @notice Declare which XRPL payment will satisfy `invoiceId`.
     *
     * @param invoiceId            Invoice to bind. Must be open and payable in FXRP.
     * @param receivingAddressHash Standard address hash of the merchant's XRPL
     *                             account, as FDC will report it.
     * @param minimumDrops         Drops the XRPL payment must deliver.
     *
     * @dev Merchant-only, because the XRPL account being paid is theirs to name.
     *
     *      The payment reference is *read from the invoice* rather than accepted as
     *      an argument. `FluxaInvoice.createInvoice` already enforces global
     *      uniqueness of `paymentRef` through its `referenceUsed` map — built in
     *      Sprint 2 for exactly this purpose — so taking it from there means one
     *      reference can never be bound to two invoices. Accepting it as a
     *      parameter would throw that guarantee away.
     *
     *      `minimumDrops >= invoice.amount` is the rail's solvency condition. The
     *      rail fronts `invoice.amount` FXRP and receives `minimumDrops` worth of
     *      XRP; anything less and the operator is subsidising the payment. Because
     *      the merchant sets this and the operator bears the risk, the floor is
     *      enforced here rather than left to configuration.
     *
     *      Binding is single-shot. Allowing a rebind would let a merchant redirect
     *      an invoice to a different XRPL account after a customer had already been
     *      shown payment instructions.
     */
    function bindInvoice(
        uint256 invoiceId,
        bytes32 receivingAddressHash,
        uint256 minimumDrops
    ) external whenNotPaused {
        if (!fluxaInvoice.exists(invoiceId)) revert InvoiceNotFound(invoiceId);
        if (_expectations[invoiceId].bound) revert AlreadyBound(invoiceId);
        if (receivingAddressHash == bytes32(0)) revert ZeroReceivingAddressHash();

        FluxaTypes.Invoice memory invoice = fluxaInvoice.getInvoice(invoiceId);

        if (msg.sender != invoice.merchant) {
            revert NotInvoiceMerchant(msg.sender, invoice.merchant);
        }
        if (invoice.status != FluxaTypes.Status.CREATED) {
            revert InvoiceNotOpen(invoiceId, invoice.status);
        }
        if (invoice.payToken != address(fxrp)) {
            revert UnsupportedPayToken(invoice.payToken, address(fxrp));
        }
        if (invoice.paymentRef == bytes32(0)) revert MissingPaymentReference(invoiceId);
        if (minimumDrops < invoice.amount) {
            revert InsufficientCommitment(minimumDrops, invoice.amount);
        }

        // The drops-to-base-units equivalence this rail relies on is only true
        // while FXRP is 6-decimal. Checked here, once per invoice, rather than
        // assumed from a comment.
        uint8 decimals = IERC20Decimals(address(fxrp)).decimals();
        if (decimals != ASSET_MINTING_DECIMALS) {
            revert UnexpectedAssetDecimals(decimals, ASSET_MINTING_DECIMALS);
        }

        _expectations[invoiceId] = XrplExpectation({
            receivingAddressHash: receivingAddressHash,
            paymentReference: invoice.paymentRef,
            minimumDrops: minimumDrops,
            bound: true
        });

        emit InvoiceBound(
            invoiceId, invoice.merchant, receivingAddressHash, invoice.paymentRef, minimumDrops
        );
    }

    // ---------------------------------------------------------------------
    // Rail B: pay an invoice from a proven XRPL payment
    // ---------------------------------------------------------------------

    /**
     * @notice Prove an XRPL payment and use it to pay a bound invoice.
     *
     * @param invoiceId Invoice previously bound with {bindInvoice}.
     * @param proof     FDC `Payment` attestation, as returned by the DA layer.
     *
     * @dev Permissionless on purpose: the proof *is* the authorisation. Requiring a
     *      privileged submitter would mean a customer's paid invoice could be held
     *      hostage by an offline operator, and would add a trusted party to a flow
     *      whose entire point is not needing one.
     *
     *      ### The check that is easy to omit
     *
     *      `verifyPayment` returns true for any response that was in the Merkle
     *      root of its voting round. It does **not** check that the response is the
     *      attestation type or source you were expecting. Without the
     *      `attestationType` and `sourceId` comparisons below, an attestation about
     *      a different chain — or a different attestation type whose response body
     *      happens to decode — could be presented here and would verify. The type
     *      and source are therefore checked against constants before the proof is
     *      trusted for anything.
     *
     *      ### Ordering
     *
     *      Replay and identity checks run before the external `verifyPayment` call
     *      so a resubmitted proof fails cheaply. Effects are written before
     *      `payInvoice`, and the function is `nonReentrant`, so a reentrant call
     *      finds the transaction already consumed.
     */
    function payInvoiceFromXrpl(uint256 invoiceId, IPayment.Proof calldata proof)
        external
        nonReentrant
        whenNotPaused
    {
        XrplExpectation memory expectation = _expectations[invoiceId];
        if (!expectation.bound) revert InvoiceNotBound(invoiceId);

        bytes32 transactionId = proof.data.requestBody.transactionId;
        if (transactionUsed[transactionId]) revert TransactionAlreadyUsed(transactionId);

        if (proof.data.attestationType != ATTESTATION_TYPE_PAYMENT) {
            revert UnexpectedAttestationType(proof.data.attestationType, ATTESTATION_TYPE_PAYMENT);
        }
        if (proof.data.sourceId != SOURCE_ID_TEST_XRP) {
            revert UnexpectedSource(proof.data.sourceId, SOURCE_ID_TEST_XRP);
        }

        // The Merkle proof, checked against the round's root by Flare's own
        // verifier. Resolved from the registry on every call rather than cached, so
        // a protocol upgrade that moves FdcVerification does not strand this rail.
        if (!IFdcVerification(_resolve(FDC_VERIFICATION_KEY)).verifyPayment(proof)) {
            revert ProofRejected(transactionId);
        }

        IPayment.ResponseBody calldata body = proof.data.responseBody;

        // A failed XRPL transaction is still attestable — status 1 and 2 record
        // sender-fault and receiver-fault failures. Proving one happened is not
        // proving the merchant was paid.
        if (body.status != XRPL_STATUS_SUCCESS) revert XrplPaymentFailed(body.status);

        if (body.standardPaymentReference != expectation.paymentReference) {
            revert ReferenceMismatch(body.standardPaymentReference, expectation.paymentReference);
        }
        if (body.receivingAddressHash != expectation.receivingAddressHash) {
            revert RecipientMismatch(body.receivingAddressHash, expectation.receivingAddressHash);
        }

        // `receivedAmount` is int256 in the attestation type. A non-positive value
        // would wrap to an enormous uint and sail past the floor below.
        if (body.receivedAmount <= 0) revert NonPositiveAmount(body.receivedAmount);
        uint256 dropsReceived = uint256(body.receivedAmount);
        if (dropsReceived < expectation.minimumDrops) {
            revert AmountBelowCommitment(dropsReceived, expectation.minimumDrops);
        }

        FluxaTypes.Invoice memory invoice = fluxaInvoice.getInvoice(invoiceId);

        // A payment that predates the invoice cannot be a payment *of* it. Without
        // this, an XRPL transaction made before the invoice existed could be
        // presented against it. XRPL close times and Flare block timestamps are
        // both UNIX seconds, so the comparison is direct.
        if (body.blockTimestamp < invoice.createdAt) {
            revert PaymentPredatesInvoice(body.blockTimestamp, invoice.createdAt);
        }

        uint256 fronted = invoice.amount;
        uint256 available = fxrp.balanceOf(address(this));
        if (available < fronted) revert InsufficientLiquidity(fronted, available);

        // Effects before interaction.
        transactionUsed[transactionId] = true;
        _records[invoiceId] = XrplPaymentRecord({
            transactionId: transactionId,
            sourceAddressHash: body.sourceAddressHash,
            xrplBlockNumber: body.blockNumber,
            xrplBlockTimestamp: body.blockTimestamp,
            votingRound: proof.data.votingRound,
            dropsReceived: dropsReceived,
            fxrpFronted: fronted
        });

        // Pay through the ordinary entry point. FluxaInvoice pulls exactly
        // `invoice.amount` and measures the delta itself; the allowance is set to
        // that figure and consumed by the pull, leaving nothing standing.
        fxrp.forceApprove(address(fluxaInvoice), fronted);
        IFluxaPayable(address(fluxaInvoice)).payInvoice(invoiceId);

        emit XrplPaymentAccepted(
            invoiceId,
            transactionId,
            body.sourceAddressHash,
            dropsReceived,
            fronted,
            proof.data.votingRound
        );
    }

    // ---------------------------------------------------------------------
    // Liquidity
    // ---------------------------------------------------------------------

    /**
     * @notice Fund the rail's FXRP float.
     * @dev Permissionless. Depositing is a gift to the contract and withdrawal is
     *      owner-only, so an open deposit adds no attack surface while making the
     *      demo path — and third-party liquidity — straightforward.
     */
    function depositLiquidity(uint256 amount) external whenNotPaused {
        if (amount == 0) revert InsufficientLiquidity(1, 0);
        fxrp.safeTransferFrom(msg.sender, address(this), amount);
        emit LiquidityDeposited(msg.sender, amount);
    }

    /**
     * @notice Withdraw FXRP float.
     * @dev Not restricted to the surplus above outstanding commitments: the rail
     *      cannot know which bound invoices will actually be paid, so any such
     *      figure would be a guess. An operator who withdraws below what a pending
     *      proof needs gets `InsufficientLiquidity` on submission, which is
     *      recoverable — the proof stays valid and can be resubmitted after
     *      refunding.
     */
    function withdrawLiquidity(address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();

        uint256 available = fxrp.balanceOf(address(this));
        if (amount > available) revert InsufficientLiquidity(amount, available);

        fxrp.safeTransfer(to, amount);
        emit LiquidityWithdrawn(to, amount);
    }

    function availableLiquidity() external view returns (uint256) {
        return fxrp.balanceOf(address(this));
    }

    // ---------------------------------------------------------------------
    // Administration
    // ---------------------------------------------------------------------

    /**
     * @notice Stop new bindings and new proof submissions.
     * @dev Withdrawal is deliberately left callable while paused: pausing is the
     *      response to something being wrong, and stranding the float behind the
     *      same switch would make that worse.
     */
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /** @notice The live FdcVerification address, resolved from the registry. */
    function fdcVerificationAddress() external view returns (address) {
        return _resolve(FDC_VERIFICATION_KEY);
    }

    /**
     * @notice The FDC protocol id the live verifier reports.
     * @dev Read rather than hardcoded, as the Flare docs instruct. Config records
     *      200 for reference; this is the authoritative value.
     */
    function fdcProtocolId() external view returns (uint8) {
        return IFdcVerification(_resolve(FDC_VERIFICATION_KEY)).fdcProtocolId();
    }

    function expectationOf(uint256 invoiceId) external view returns (XrplExpectation memory) {
        return _expectations[invoiceId];
    }

    function isBound(uint256 invoiceId) external view returns (bool) {
        return _expectations[invoiceId].bound;
    }

    /**
     * @notice The XRPL provenance of an invoice paid through this rail.
     * @dev Zero-valued if the invoice was not paid here. `FluxaInvoice` records
     *      this contract as the payer, so this is where the real payer lives.
     */
    function recordOf(uint256 invoiceId) external view returns (XrplPaymentRecord memory) {
        return _records[invoiceId];
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    /**
     * @dev The registry returns `address(0)` for an unknown name rather than
     *      reverting, so an unchecked result becomes a call to the zero address —
     *      which fails with no revert data and nothing to debug.
     */
    function _resolve(bytes32 key) private view returns (address resolved) {
        resolved = registry.getContractAddressByHash(key);
        if (resolved == address(0)) revert RegistryLookupFailed(key);
    }
}

/** @dev Minimal decimals view; avoids pulling in all of IERC20Metadata. */
interface IERC20Decimals {
    function decimals() external view returns (uint8);
}
