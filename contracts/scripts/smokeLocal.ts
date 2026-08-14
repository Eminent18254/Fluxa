import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * Drive a deployed Fluxa system through a full invoice lifecycle.
 *
 * The unit tests use loadFixture against an in-process chain, which is the
 * right tool for asserting behaviour but says nothing about whether the
 * deployed artifacts work over JSON-RPC against a persistent node. This script
 * closes that gap: it reads the deployment record, sends real transactions from
 * separate signers, and asserts balances moved.
 *
 * Run against a node started with `npx hardhat node`:
 *   npx hardhat run scripts/smokeLocal.ts --network localhost
 */

const USD_TOTAL = 250_000_000n; // $250.000000 at the oracle's 6-decimal USD scale
const ONE_WEEK = 7 * 24 * 60 * 60;

function assert(condition: boolean, label: string) {
  console.log(`  ${condition ? "PASS" : "FAIL"}  ${label}`);
  if (!condition) throw new Error(`Smoke test failed: ${label}`);
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
    throw new Error("Need at least 3 signers: deployer, merchant, customer.");
  }
  const [deployer, merchant, customer] = signers;

  console.log(`Network   ${network.name} (chainId ${record.chainId})`);
  console.log(`Invoice   ${record.contracts.FluxaInvoice}`);
  console.log(`Settle    ${record.contracts.FluxaSettlement}`);

  const invoice = await ethers.getContractAt(
    "FluxaInvoice",
    record.contracts.FluxaInvoice,
  );
  const settlement = await ethers.getContractAt(
    "FluxaSettlement",
    record.contracts.FluxaSettlement,
  );

  const tokenMeta = record.tokens[0];
  if (!tokenMeta) throw new Error("Deployment record lists no tokens.");
  const token = await ethers.getContractAt("MockERC20", tokenMeta.address);
  console.log(`Token     ${tokenMeta.symbol} at ${tokenMeta.address}`);

  // -------------------------------------------------------------------
  // Price
  //
  // The doc's Sprint 3 flow is: customer picks an asset, Fluxa asks FTSOv2 for a
  // price, and the payment amount is calculated from it. Deriving AMOUNT here
  // rather than hardcoding it is what makes this script exercise that flow — the
  // figure the invoice demands comes from an on-chain read, so a broken oracle
  // fails the smoke test instead of going unnoticed behind a literal.
  // -------------------------------------------------------------------

  if (!record.contracts.FluxaPriceOracle) {
    throw new Error("Deployment record has no FluxaPriceOracle. Redeploy.");
  }
  const priceOracle = await ethers.getContractAt(
    "FluxaPriceOracle",
    record.contracts.FluxaPriceOracle,
  );
  console.log(`Oracle    ${record.contracts.FluxaPriceOracle}`);

  console.log("\nPricing...");
  const [priceValue, priceDecimals, priceTimestamp] = await priceOracle.getPriceUsd(
    tokenMeta.address,
  );
  const AMOUNT = await priceOracle.quoteTokenAmount(tokenMeta.address, USD_TOTAL);

  console.log(
    `  ${tokenMeta.symbol} = $${ethers.formatUnits(priceValue, Number(priceDecimals))}` +
      ` (${priceDecimals}dp feed, published at ${priceTimestamp})`,
  );
  console.log(
    `  $${ethers.formatUnits(USD_TOTAL, 6)} = ` +
      `${ethers.formatUnits(AMOUNT, tokenMeta.decimals)} ${tokenMeta.symbol}`,
  );

  assert(AMOUNT > 0n, "oracle produced a non-zero token amount");
  assert(
    (await priceOracle.feedIdFor(tokenMeta.address)) === tokenMeta.feedId,
    `${tokenMeta.symbol} is mapped to ${tokenMeta.feedName}`,
  );

  // Round-trip the derived amount back to USD. It should land on the original
  // total within a base unit's worth, which catches a decimal error in either
  // direction — the failure that a one-way conversion cannot see.
  const backToUsd = await priceOracle.quoteUsdValue(tokenMeta.address, AMOUNT);
  const drift = backToUsd > USD_TOTAL ? backToUsd - USD_TOTAL : USD_TOTAL - backToUsd;
  assert(
    drift <= priceValue / 10n ** BigInt(Number(priceDecimals)) + 1n,
    `round trip returns $${ethers.formatUnits(backToUsd, 6)}, within rounding of the total`,
  );

  // Fund the customer. Only possible because this is a mock token; on Coston2
  // the customer must already hold the asset.
  if (!tokenMeta.mock) {
    throw new Error("smokeLocal is for mock-token deployments only.");
  }
  await (await token.connect(deployer).mint(customer.address, AMOUNT * 10n)).wait();
  await (
    await token.connect(customer).approve(await invoice.getAddress(), AMOUNT * 10n)
  ).wait();

  // -------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------

  const latest = await ethers.provider.getBlock("latest");
  const dueAt = (latest!.timestamp ?? 0) + ONE_WEEK;
  const paymentRef = ethers.keccak256(
    ethers.toUtf8Bytes(`fluxa-smoke-${latest!.number}`),
  );

  console.log("\nCreating invoice...");
  const createTx = await invoice
    .connect(merchant)
    .createInvoice(tokenMeta.address, AMOUNT, dueAt, paymentRef);
  const createReceipt = await createTx.wait();

  const createdLog = createReceipt!.logs
    .map((log) => {
      try {
        return invoice.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find((parsed) => parsed?.name === "InvoiceCreated");
  assert(createdLog != null, "InvoiceCreated was emitted");

  const invoiceId: bigint = createdLog!.args[0];
  console.log(`  invoice id ${invoiceId}`);
  assert(await invoice.isPayable(invoiceId), "invoice reports payable");

  console.log("\nPaying invoice...");
  const merchantBefore = await token.balanceOf(merchant.address);
  const customerBefore = await token.balanceOf(customer.address);

  await (await invoice.connect(customer).payInvoice(invoiceId)).wait();

  assert(
    (await token.balanceOf(customer.address)) === customerBefore - AMOUNT,
    "customer was debited exactly the invoice amount",
  );
  assert(
    (await invoice.escrowOf(invoiceId)) === AMOUNT,
    "funds are held in escrow, not forwarded",
  );
  assert(
    (await token.balanceOf(merchant.address)) === merchantBefore,
    "merchant has not been paid yet — payment and settlement are separate",
  );
  assert(!(await invoice.isPayable(invoiceId)), "invoice is no longer payable");

  console.log("\nSettling invoice...");
  const settleReceipt = await (
    await settlement.connect(deployer).settleInvoice(invoiceId)
  ).wait();

  assert(
    (await token.balanceOf(merchant.address)) === merchantBefore + AMOUNT,
    "merchant received the full amount",
  );
  assert((await invoice.escrowOf(invoiceId)) === 0n, "escrow is empty");
  assert(await settlement.isSettled(invoiceId), "settlement is recorded");

  // The price snapshot is the audit trail: what the asset was worth at the moment
  // the merchant was paid. Asserting the event fired, and that its values match a
  // fresh oracle read, is what shows the oracle is actually wired into settlement
  // rather than merely deployed alongside it.
  const snapshots = (settleReceipt?.logs ?? [])
    .map((log) => {
      try {
        return settlement.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .filter((parsed) => parsed?.name === "SettlementPriceSnapshot");

  assert(snapshots.length === 1, "settlement emitted exactly one price snapshot");
  const snapshot = snapshots[0]!;
  assert(
    snapshot.args.token === tokenMeta.address,
    "snapshot names the token that was settled",
  );
  assert(
    snapshot.args.priceValue === priceValue &&
      snapshot.args.priceDecimals === priceDecimals,
    `snapshot records $${ethers.formatUnits(
      snapshot.args.priceValue,
      Number(snapshot.args.priceDecimals),
    )} with the feed's own exponent`,
  );

  const stored = await invoice.getInvoice(invoiceId);
  assert(stored.status === 3n, "invoice status is SETTLED");
  assert(stored.paymentRef === paymentRef, "payment reference survived the round trip");

  console.log("\nRejection paths...");
  let reverted = false;
  try {
    await settlement.connect(deployer).settleInvoice.staticCall(invoiceId);
  } catch {
    reverted = true;
  }
  assert(reverted, "a second settlement is rejected");

  reverted = false;
  try {
    await invoice.connect(customer).payInvoice.staticCall(invoiceId);
  } catch {
    reverted = true;
  }
  assert(reverted, "paying a settled invoice is rejected");

  console.log("\nSmoke test passed end to end over JSON-RPC.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
