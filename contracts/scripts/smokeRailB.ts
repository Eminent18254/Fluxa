import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * Drive a deployed Fluxa system through the Rail B (XRPL-native) payment path.
 *
 * `smokeLocal.ts` exercises Rail A — an ERC-20 `payInvoice` the invoice contract
 * observes directly. It says nothing about Rail B, where a native XRP payment is
 * attested by the FDC and replayed on-chain through `FluxaFdcPaymentRail`. The two
 * rails emit different events and the indexer reduces them differently — Rail B
 * carries an `XrplPaymentAccepted` that names the real XRPL sender, joined to the
 * inner `InvoicePaid` — so a proof that only ever ran Rail A leaves half the sync
 * unproven against real chain state.
 *
 * This closes that gap on a local node. The FDC verifier is the deployment's mock,
 * which accepts any well-formed proof without Merkle verification — the same split
 * the contract suite documents: this proves Fluxa's rail logic and the indexer's
 * mapping, not Flare's cryptography (that is the Coston2 fork suite's job).
 *
 * Run against a node started with `npx hardhat node`, after deploy + Rail A smoke:
 *   npx hardhat run scripts/smokeRailB.ts --network localhost
 */

const AMOUNT = 100_000_000n; // 100.000000 FXRP in base units
const DROPS = 100_000_000n; // 100 XRP in drops — same quantity at 6 decimals
const VOTING_ROUND = 987_654n;
const ONE_WEEK = 7 * 24 * 60 * 60;

// Standard address hashes, as FDC reports XRPL accounts.
const MERCHANT_XRPL = ethers.keccak256(ethers.toUtf8Bytes("rMerchantTestAccount"));
const CUSTOMER_XRPL = ethers.keccak256(ethers.toUtf8Bytes("rCustomerTestAccount"));

// Attestation type `Payment` and source `testXRP`, right-padded ASCII — the exact
// constants FluxaFdcPaymentRail checks the proof against before trusting it.
const TYPE_PAYMENT =
  "0x5061796d656e7400000000000000000000000000000000000000000000000000";
const SOURCE_TEST_XRP =
  "0x7465737458525000000000000000000000000000000000000000000000000000";

function assert(condition: boolean, label: string) {
  console.log(`  ${condition ? "PASS" : "FAIL"}  ${label}`);
  if (!condition) throw new Error(`Rail B smoke test failed: ${label}`);
}

async function main() {
  const recordPath = path.resolve(
    __dirname,
    "..",
    "deployments",
    `${network.name}.json`,
  );
  if (!fs.existsSync(recordPath)) {
    throw new Error(
      `No deployment record at ${recordPath}. Run deploy.ts against ` +
        `--network ${network.name} first.`,
    );
  }

  const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
  const signers = await ethers.getSigners();
  if (signers.length < 3) {
    throw new Error("Need at least 3 signers: liquidity provider, merchant, submitter.");
  }
  const [funder, merchant, submitter] = signers;

  const railAddress = record.contracts.FluxaFdcPaymentRail;
  if (!railAddress) {
    throw new Error("Deployment record has no FluxaFdcPaymentRail. Redeploy.");
  }
  const fxrpMeta = record.tokens.find((t: { symbol: string }) => t.symbol === "FXRP");
  if (!fxrpMeta) throw new Error("Deployment record lists no FXRP token.");

  const invoice = await ethers.getContractAt("FluxaInvoice", record.contracts.FluxaInvoice);
  const rail = await ethers.getContractAt("FluxaFdcPaymentRail", railAddress);
  const fxrp = await ethers.getContractAt("MockERC20", fxrpMeta.address);

  console.log(`Network   ${network.name} (chainId ${record.chainId})`);
  console.log(`Invoice   ${record.contracts.FluxaInvoice}`);
  console.log(`Rail      ${railAddress}`);
  console.log(`FXRP      ${fxrpMeta.address}`);
  console.log(`FDC       ${record.flare.fdcVerification} (mock verifier, protocol ${record.flare.fdcProtocolId})`);

  // -------------------------------------------------------------------
  // Float the rail
  //
  // The rail fronts FXRP against a proven XRP payment, so it needs float. In
  // production the operator funds this from the XRP they were paid; here the
  // deployer's minted FXRP stands in. Deposit only the shortfall, so re-runs do
  // not pile up liquidity.
  // -------------------------------------------------------------------

  console.log("\nFloating the rail...");
  const railBalance = await fxrp.balanceOf(railAddress);
  if (railBalance < AMOUNT) {
    const top = AMOUNT * 2n;
    await (await fxrp.connect(funder).approve(railAddress, top)).wait();
    await (await rail.connect(funder).depositLiquidity(top)).wait();
    console.log(`  deposited ${ethers.formatUnits(top, 6)} FXRP of float`);
  } else {
    console.log(`  rail already holds ${ethers.formatUnits(railBalance, 6)} FXRP — no top-up`);
  }
  assert((await fxrp.balanceOf(railAddress)) >= AMOUNT, "rail has enough float to front the invoice");

  // -------------------------------------------------------------------
  // Create and bind an FXRP invoice
  //
  // Reference and transaction id are derived from the current block so the script
  // re-runs cleanly: FluxaInvoice enforces global reference uniqueness, and the
  // rail refuses a transaction id it has already consumed.
  // -------------------------------------------------------------------

  const block = await ethers.provider.getBlock("latest");
  if (!block) throw new Error("Could not read the latest block.");
  const nonce = block.number;
  const reference = ethers.keccak256(ethers.toUtf8Bytes(`fluxa-railb-ref-${nonce}`));
  const transactionId = ethers.keccak256(ethers.toUtf8Bytes(`fluxa-railb-txid-${nonce}`));
  const dueAt = block.timestamp + ONE_WEEK;

  console.log("\nCreating invoice...");
  const createReceipt = await (
    await invoice.connect(merchant).createInvoice(fxrpMeta.address, AMOUNT, dueAt, reference)
  ).wait();
  if (!createReceipt) throw new Error("createInvoice produced no receipt.");

  const created = createReceipt.logs
    .map((l) => {
      try {
        return invoice.interface.parseLog(l);
      } catch {
        return null;
      }
    })
    .find((p) => p?.name === "InvoiceCreated");
  assert(created != null, "InvoiceCreated was emitted");
  const invoiceId: bigint = created!.args.invoiceId;
  console.log(`  invoice id ${invoiceId}`);

  console.log("\nBinding invoice to the merchant's XRPL account...");
  const bindReceipt = await (
    await rail.connect(merchant).bindInvoice(invoiceId, MERCHANT_XRPL, DROPS)
  ).wait();
  const bound = bindReceipt!.logs
    .map((l) => {
      try {
        return rail.interface.parseLog(l);
      } catch {
        return null;
      }
    })
    .find((p) => p?.name === "InvoiceBound");
  assert(bound != null, "InvoiceBound was emitted");
  // The rail reads the reference from the invoice, not from the binding call.
  assert(bound!.args.paymentReference === reference, "bound reference matches the invoice's own");

  // -------------------------------------------------------------------
  // Prove the XRPL payment
  //
  // A well-formed IPayment.Proof the rail should accept: the mock verifier ignores
  // the (empty) Merkle proof, but every other field is checked on-chain — type,
  // source, status, reference, recipient, amount and that the payment does not
  // predate the invoice. `blockTimestamp` is now, comfortably after createdAt.
  // -------------------------------------------------------------------

  const now = (await ethers.provider.getBlock("latest"))!.timestamp;
  const proof = {
    merkleProof: [] as string[],
    data: {
      attestationType: TYPE_PAYMENT,
      sourceId: SOURCE_TEST_XRP,
      votingRound: VOTING_ROUND,
      lowestUsedTimestamp: BigInt(now),
      requestBody: {
        transactionId,
        inUtxo: 0n,
        utxo: 0n,
      },
      responseBody: {
        blockNumber: 4_242_424n,
        blockTimestamp: BigInt(now),
        sourceAddressHash: CUSTOMER_XRPL,
        sourceAddressesRoot: ethers.ZeroHash,
        receivingAddressHash: MERCHANT_XRPL,
        intendedReceivingAddressHash: MERCHANT_XRPL,
        spentAmount: DROPS + 12n, // + XRPL network fee
        intendedSpentAmount: DROPS + 12n,
        receivedAmount: DROPS,
        intendedReceivedAmount: DROPS,
        standardPaymentReference: reference,
        oneToOne: true,
        status: 0n, // 0 = success
      },
    },
  };

  console.log("\nPaying invoice from the proven XRPL payment...");
  const railBefore = await fxrp.balanceOf(railAddress);
  const escrowBefore = await fxrp.balanceOf(record.contracts.FluxaInvoice);

  // Permissionless: submitted by a third party, not the merchant. The proof is the
  // authorisation.
  const payReceipt = await (
    await rail.connect(submitter).payInvoiceFromXrpl(invoiceId, proof)
  ).wait();
  if (!payReceipt) throw new Error("payInvoiceFromXrpl produced no receipt.");

  const parsed = payReceipt.logs.map((l) => {
    for (const c of [rail, invoice]) {
      try {
        const p = c.interface.parseLog(l);
        if (p) return p;
      } catch {
        /* not this contract's event */
      }
    }
    return null;
  });

  const accepted = parsed.find((p) => p?.name === "XrplPaymentAccepted");
  const paid = parsed.find((p) => p?.name === "InvoicePaid");

  assert(accepted != null, "XrplPaymentAccepted was emitted");
  assert(paid != null, "InvoicePaid was emitted in the same transaction");
  assert(accepted!.args.invoiceId === invoiceId, "the accepted payment names this invoice");
  assert(
    accepted!.args.sourceAddressHash === CUSTOMER_XRPL,
    "the event carries the real XRPL sender, not the rail",
  );
  assert(accepted!.args.dropsReceived === DROPS, "drops received match the attestation");
  assert(accepted!.args.fxrpFronted === AMOUNT, "the rail fronted exactly the invoice amount");
  assert(accepted!.args.votingRound === VOTING_ROUND, "the voting round is recorded for the indexer");

  // The rail's own float paid for it, and the funds landed in escrow.
  assert(
    (await fxrp.balanceOf(railAddress)) === railBefore - AMOUNT,
    "the rail's float paid for the invoice",
  );
  assert(
    (await fxrp.balanceOf(record.contracts.FluxaInvoice)) === escrowBefore + AMOUNT,
    "the fronted FXRP is held in escrow, not forwarded",
  );

  const stored = await invoice.getInvoice(invoiceId);
  assert(stored.status === 2n, "invoice status is PAID");
  assert(stored.amountPaid === AMOUNT, "the invoice records the full amount paid");

  // -------------------------------------------------------------------
  // Rejection paths
  // -------------------------------------------------------------------

  console.log("\nRejection paths...");
  let replayRejected = false;
  try {
    await rail.connect(submitter).payInvoiceFromXrpl(invoiceId, proof);
  } catch {
    replayRejected = true;
  }
  assert(replayRejected, "the same proof cannot be replayed against the invoice");

  console.log("\nRail B smoke test passed end to end over JSON-RPC.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
