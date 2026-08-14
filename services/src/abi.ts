/**
 * Event ABIs for the three contracts the indexer watches.
 *
 * Hand-written rather than imported from Hardhat's artifacts, for two reasons.
 * The artifacts live in `contracts/artifacts/`, which is gitignored build
 * output — a service that only runs after someone has compiled the contracts is
 * a service that fails in deployment. And an event fragment is the whole
 * interface the indexer needs; pulling in a full ABI would let it call the
 * contracts, which it has no business doing.
 *
 * These signatures were read off the sources, not from the specification. The
 * spec's synchronisation diagrams (§5.12, §7.5) name an event `PaymentConfirmed`
 * that does not exist anywhere in the contract set. The real pair is
 * `InvoicePaid` on FluxaInvoice and `InvoiceSettled` on FluxaSettlement — a
 * *different contract*, which is why `WATCHED` below is keyed by contract and
 * the indexer subscribes to more than one address.
 */

/** FluxaInvoice — the invoice registry and escrow. */
export const INVOICE_EVENTS = [
  "event InvoiceCreated(uint256 indexed invoiceId, address indexed merchant, address indexed payToken, uint256 amount, uint64 dueAt, bytes32 paymentRef)",
  "event InvoicePaid(uint256 indexed invoiceId, address indexed payer, address indexed payToken, uint256 amountPaid, uint8 rail)",
  "event InvoiceCancelled(uint256 indexed invoiceId, address indexed merchant)",
  "event InvoiceExpired(uint256 indexed invoiceId, address indexed caller)",
  "event EscrowReleased(uint256 indexed invoiceId, address indexed recipient, address indexed token, uint256 amount)",
] as const;

/** FluxaInvoiceV2 â€” USD-denominated invoices with selectable payment assets. */
export const INVOICE_V2_EVENTS = [
  "event InvoiceCreatedV2(uint256 indexed invoiceId, address indexed merchant, address indexed settlementToken, uint256 usdAmount, uint64 dueAt, bytes32 paymentRef)",
  "event PaymentOptionSet(uint256 indexed invoiceId, address indexed token)",
  "event InvoicePaid(uint256 indexed invoiceId, address indexed payer, address indexed payToken, uint256 amountPaid, uint8 rail)",
  "event InvoiceCancelled(uint256 indexed invoiceId, address indexed merchant)",
  "event InvoiceExpired(uint256 indexed invoiceId, address indexed caller)",
  "event EscrowReleased(uint256 indexed invoiceId, address indexed settlement, address indexed token, uint256 amount)",
] as const;

/** FluxaSettlement — payout, and the FTSO snapshot the payout was priced at. */
export const SETTLEMENT_EVENTS = [
  "event InvoiceSettled(uint256 indexed invoiceId, address indexed merchant, address indexed recipient, address token, uint256 amountOut)",
  "event SettlementPriceSnapshot(uint256 indexed invoiceId, address indexed token, uint256 priceValue, int8 priceDecimals, uint64 priceTimestamp)",
] as const;

/** FluxaSettlementV2 â€” direct or reserve-backed settlement. */
export const SETTLEMENT_V2_EVENTS = [
  "event InvoiceSettled(uint256 indexed invoiceId, address indexed merchant, address indexed recipient, address token, uint256 amountOut)",
  "event ConversionRecorded(uint256 indexed invoiceId, address indexed paidToken, uint256 paidAmount, address indexed settlementToken, uint256 settlementAmount)",
] as const;

/**
 * FluxaFdcPaymentRail — Rail B.
 *
 * `XrplPaymentAccepted` is the only place the real payer appears. The rail
 * fronts its own FXRP through the ordinary `payInvoice`, so the invoice records
 * `payer = <the rail's address>` and `rail = FLARE_ERC20`; the customer's XRPL
 * account and the drops they actually sent exist here and nowhere else.
 */
export const RAIL_EVENTS = [
  "event InvoiceBound(uint256 indexed invoiceId, address indexed merchant, bytes32 receivingAddressHash, bytes32 paymentReference, uint256 minimumDrops)",
  "event XrplPaymentAccepted(uint256 indexed invoiceId, bytes32 indexed transactionId, bytes32 indexed sourceAddressHash, uint256 dropsReceived, uint256 fxrpFronted, uint64 votingRound)",
] as const;

/** Which deployed contract a log came from. */
export type ContractKey = "invoice" | "settlement" | "rail" | "invoiceV2" | "settlementV2";

export const WATCHED: Record<ContractKey, readonly string[]> = {
  invoice: INVOICE_EVENTS,
  settlement: SETTLEMENT_EVENTS,
  rail: RAIL_EVENTS,
  invoiceV2: INVOICE_V2_EVENTS,
  settlementV2: SETTLEMENT_V2_EVENTS,
};

/**
 * Every event name the reducer knows how to handle.
 *
 * `EscrowReleased` is watched but intentionally produces no mutation: it is the
 * escrow leg of the same transaction that emits `InvoiceSettled`, and recording
 * both would double-count one payout. It is decoded so that an unrecognised
 * event is a real signal rather than noise.
 */
export const HANDLED_EVENTS = new Set([
  "InvoiceCreated",
  "InvoiceCreatedV2",
  "PaymentOptionSet",
  "InvoicePaid",
  "InvoiceCancelled",
  "InvoiceExpired",
  "EscrowReleased",
  "InvoiceSettled",
  "SettlementPriceSnapshot",
  "InvoiceBound",
  "XrplPaymentAccepted",
  "ConversionRecorded",
]);
