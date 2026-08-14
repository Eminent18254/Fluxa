import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

import { COSTON2_TOKENS, FEED_IDS, FLARE_CONTRACT_REGISTRY } from "../config/flare";

/**
 * Deploy the Fluxa contract system.
 *
 * Works against the local Hardhat node and against Coston2 from the same code
 * path, because a deploy script that is only ever run against a mock is not
 * evidence that the real deployment works.
 *
 * There are two deliberate differences, both because the real thing does not
 * exist locally:
 *
 *   - The token allowlist. FXRP and USDT0 exist at fixed addresses on Coston2;
 *     on a local chain they do not exist at all, so the script deploys
 *     6-decimal mocks in their place. Pointing a local deployment at the Coston2
 *     addresses would allowlist empty accounts and every payment would fail with
 *     a confusing error.
 *
 *   - The Flare Contract Registry. The canonical address holds no code on a local
 *     chain, so every FTSOv2 lookup would revert. Locally the script stands up a
 *     mock registry, FTSOv2 and FeeCalculator; on Coston2 it uses the canonical
 *     registry and asserts the contract's own constant agrees with the config.
 */

type DeployedToken = {
  symbol: string;
  address: string;
  decimals: number;
  feedId: string;
  feedName: string;
  mock: boolean;
};

const OUTPUT_DIR = path.resolve(__dirname, "..", "deployments");

/**
 * Staleness window for the price oracle, in seconds.
 *
 * FTSOv2 publishes about every 90 seconds, so 300 gives a real feed several
 * publication rounds of headroom while still rejecting anything genuinely
 * abandoned. Locally the window is effectively disabled: the mock FTSOv2
 * publishes once at deploy time and never again, so a staleness check there
 * would only measure how long ago the script was run.
 */
const MAX_PRICE_AGE_COSTON2 = 300n;
const MAX_PRICE_AGE_LOCAL = 365n * 24n * 60n * 60n;


async function main() {
  const [deployer] = await ethers.getSigners();
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const isLocal = chainId === 31337;

  console.log(`Network      ${network.name} (chainId ${chainId})`);
  console.log(`Deployer     ${deployer.address}`);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`Balance      ${ethers.formatEther(balance)} ${isLocal ? "ETH" : "C2FLR"}`);
  if (balance === 0n) {
    throw new Error(
      "Deployer has no balance. Fund it before deploying — " +
        "https://faucet.flare.network/coston2 for Coston2.",
    );
  }

  // ---------------------------------------------------------------------
  // Core contracts
  // ---------------------------------------------------------------------

  console.log("\nDeploying FluxaInvoice...");
  const FluxaInvoice = await ethers.getContractFactory("FluxaInvoice");
  const invoice = await FluxaInvoice.deploy(deployer.address);
  await invoice.waitForDeployment();
  const invoiceAddress = await invoice.getAddress();
  console.log(`  FluxaInvoice     ${invoiceAddress}`);

  console.log("Deploying FluxaSettlement...");
  const FluxaSettlement = await ethers.getContractFactory("FluxaSettlement");
  const settlement = await FluxaSettlement.deploy(deployer.address, invoiceAddress);
  await settlement.waitForDeployment();
  const settlementAddress = await settlement.getAddress();
  console.log(`  FluxaSettlement  ${settlementAddress}`);

  // ---------------------------------------------------------------------
  // Tokens
  // ---------------------------------------------------------------------

  const tokens: DeployedToken[] = [];

  if (isLocal) {
    console.log("\nLocal chain: deploying 6-decimal mock tokens.");
    const MockERC20 = await ethers.getContractFactory("MockERC20");

    for (const [symbol, meta] of Object.entries(COSTON2_TOKENS)) {
      const mock = await MockERC20.deploy(
        `Fluxa Mock ${symbol}`,
        symbol,
        meta.decimals,
      );
      await mock.waitForDeployment();
      const address = await mock.getAddress();

      // Fund the deployer so the smoke script has something to move.
      await (await mock.mint(deployer.address, 1_000_000n * 10n ** BigInt(meta.decimals))).wait();

      tokens.push({
        symbol,
        address,
        decimals: meta.decimals,
        feedId: FEED_IDS[meta.feedId],
        feedName: meta.feedId,
        mock: true,
      });
      console.log(`  ${symbol.padEnd(6)} ${address} (${meta.decimals} decimals, mock)`);
    }
  } else {
    console.log("\nUsing the real Coston2 token addresses.");
    for (const [symbol, meta] of Object.entries(COSTON2_TOKENS)) {
      // Verify the address is actually a contract before allowlisting it. An
      // allowlisted EOA would accept invoices that can never be paid.
      const code = await ethers.provider.getCode(meta.address);
      if (code === "0x") {
        throw new Error(`${symbol} at ${meta.address} has no code on chain ${chainId}`);
      }
      tokens.push({
        symbol,
        address: meta.address,
        decimals: meta.decimals,
        feedId: FEED_IDS[meta.feedId],
        feedName: meta.feedId,
        mock: false,
      });
      console.log(`  ${symbol.padEnd(6)} ${meta.address} (${meta.decimals} decimals)`);
    }
  }

  // ---------------------------------------------------------------------
  // Price oracle
  // ---------------------------------------------------------------------

  let registryAddress: string;
  let mockFtsoAddress: string | null = null;

  if (isLocal) {
    console.log("\nLocal chain: standing up a mock registry, FTSOv2 and FeeCalculator.");

    const MockFtsoV2 = await ethers.getContractFactory("MockFtsoV2");
    const ftso = await MockFtsoV2.deploy();
    await ftso.waitForDeployment();
    mockFtsoAddress = await ftso.getAddress();

    const MockFeeCalculator = await ethers.getContractFactory("MockFeeCalculator");
    const feeCalculator = await MockFeeCalculator.deploy();
    await feeCalculator.waitForDeployment();

    const MockContractRegistry = await ethers.getContractFactory("MockContractRegistry");
    const registry = await MockContractRegistry.deploy();
    await registry.waitForDeployment();
    registryAddress = await registry.getAddress();

    await (await registry.setAddress("FtsoV2", mockFtsoAddress)).wait();
    await (await registry.setAddress("FeeCalculator", await feeCalculator.getAddress())).wait();

    // FdcVerification too, so FluxaFdcPaymentRail can be deployed and wired on a
    // local chain. The mock always says yes, which is fine here: this script proves
    // the deployment path, and the rail's rejection logic is proved by its tests.
    const MockFdcVerification = await ethers.getContractFactory("MockFdcVerification");
    const mockFdc = await MockFdcVerification.deploy();
    await mockFdc.waitForDeployment();
    await (await registry.setAddress("FdcVerification", await mockFdc.getAddress())).wait();
    console.log(`  FdcVerification mock at ${await mockFdc.getAddress()}`);

    // Publish a price for every feed the tokens map to, at that feed's real
    // decimals. Using one scale for both would hide the per-feed decimal
    // handling that the oracle exists to get right.
    const localPrices: Record<string, { value: bigint; decimals: number }> = {
      "XRP/USD": { value: 2_500_000n, decimals: 6 },
      "USDT/USD": { value: 1_000_000n, decimals: 6 },
      "USDC/USD": { value: 1_000_000n, decimals: 6 },
      "FLR/USD": { value: 2_100_000n, decimals: 8 },
    };
    const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);

    for (const token of tokens) {
      const price = localPrices[token.feedName];
      if (!price) throw new Error(`No local price defined for ${token.feedName}`);
      await (await ftso.setFeed(token.feedId, price.value, price.decimals, now)).wait();
      console.log(
        `  ${token.feedName} published at ${price.value} (${price.decimals} decimals)`,
      );
    }
  } else {
    const code = await ethers.provider.getCode(FLARE_CONTRACT_REGISTRY);
    if (code === "0x") {
      throw new Error(
        `Flare Contract Registry at ${FLARE_CONTRACT_REGISTRY} has no code on chain ${chainId}`,
      );
    }
    registryAddress = FLARE_CONTRACT_REGISTRY;
    console.log(`\nFlare Contract Registry  ${registryAddress}`);
  }

  console.log("Deploying FluxaPriceOracle...");
  const FluxaPriceOracle = await ethers.getContractFactory("FluxaPriceOracle");
  const priceOracle = await FluxaPriceOracle.deploy(
    deployer.address,
    registryAddress,
    isLocal ? MAX_PRICE_AGE_LOCAL : MAX_PRICE_AGE_COSTON2,
  );
  await priceOracle.waitForDeployment();
  const priceOracleAddress = await priceOracle.getAddress();
  console.log(`  FluxaPriceOracle ${priceOracleAddress}`);

  // The contract carries the canonical registry address as a constant so a
  // deployment can be checked against it rather than trusting whatever was
  // passed in. If the config and the contract ever drift, this is where it
  // surfaces — before any price is read, rather than as a mispriced invoice.
  const canonical = await priceOracle.CANONICAL_FLARE_REGISTRY();
  if (canonical.toLowerCase() !== FLARE_CONTRACT_REGISTRY.toLowerCase()) {
    throw new Error(
      `Registry constant mismatch: contract says ${canonical}, config says ${FLARE_CONTRACT_REGISTRY}`,
    );
  }
  if (!isLocal && registryAddress.toLowerCase() !== canonical.toLowerCase()) {
    throw new Error(
      `Refusing to deploy against a non-canonical registry on chain ${chainId}: ${registryAddress}`,
    );
  }


  // ---------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------

  console.log("\nWiring...");
  await (await invoice.setSettlementContract(settlementAddress)).wait();
  console.log("  settlement contract registered on FluxaInvoice");

  for (const token of tokens) {
    await (await invoice.setAcceptedToken(token.address, true)).wait();
    console.log(`  ${token.symbol} allowlisted`);
  }

  for (const token of tokens) {
    await (await priceOracle.setFeed(token.address, token.feedId)).wait();
    console.log(`  ${token.symbol} mapped to ${token.feedName}`);
  }

  await (await settlement.setPriceOracle(priceOracleAddress)).wait();
  console.log("  price oracle registered on FluxaSettlement");

  // ---------------------------------------------------------------------
  // Rail B — the FDC cross-chain payment rail
  //
  // Separate from the core set on purpose. Rail A (an ERC-20 transfer on Flare)
  // needs no attestation, because the contract observes the transfer itself; the
  // rail exists only for XRP paid on the XRPL, where an attestation is the only
  // way Flare can know the payment happened. Deploying it does not change how any
  // Rail A invoice behaves — from FluxaInvoice's side the rail is just a payer.
  // ---------------------------------------------------------------------

  const fxrpToken = tokens.find((token) => token.symbol === "FXRP");
  if (!fxrpToken) {
    throw new Error("FXRP is not in the token set; Rail B has nothing to front.");
  }

  console.log("\nDeploying FluxaFdcPaymentRail...");
  const FluxaFdcPaymentRail = await ethers.getContractFactory("FluxaFdcPaymentRail");
  const rail = await FluxaFdcPaymentRail.deploy(
    deployer.address,
    registryAddress,
    invoiceAddress,
    fxrpToken.address,
  );
  await rail.waitForDeployment();
  const railAddress = await rail.getAddress();
  console.log(`  FluxaFdcPaymentRail ${railAddress}`);

  // Resolve the verifier now rather than at the first payment. A registry that
  // cannot name FdcVerification is a deployment that looks healthy and then fails
  // on the first XRPL payment, which is the worst time to find out.
  const fdcVerification = await rail.fdcVerificationAddress();
  const fdcProtocolId = await rail.fdcProtocolId();
  console.log(`  FdcVerification resolves to ${fdcVerification} (protocol ${fdcProtocolId})`);

  // ---------------------------------------------------------------------
  // Post-deploy assertions
  //
  // Deploying and reporting success without reading the state back would make
  // a silently failed wiring transaction look like a good deployment.
  // ---------------------------------------------------------------------

  console.log("\nVerifying deployed state...");
  const checks: Array<[string, boolean]> = [
    ["owner is the deployer", (await invoice.owner()) === deployer.address],
    ["settlement owner is the deployer", (await settlement.owner()) === deployer.address],
    ["oracle owner is the deployer", (await priceOracle.owner()) === deployer.address],
    [
      "invoice points at settlement",
      (await invoice.settlementContract()) === settlementAddress,
    ],
    [
      "settlement points at invoice",
      (await settlement.invoiceContract()) === invoiceAddress,
    ],
    [
      "settlement points at the price oracle",
      (await settlement.priceOracle()) === priceOracleAddress,
    ],
    [
      "oracle registry is immutable and correct",
      (await priceOracle.registry()) === registryAddress,
    ],
    ["invoice ids start at 1", (await invoice.nextInvoiceId()) === 1n],
    ["not paused", (await invoice.paused()) === false],

    // Rail B
    ["rail owner is the deployer", (await rail.owner()) === deployer.address],
    ["rail points at the invoice contract", (await rail.fluxaInvoice()) === invoiceAddress],
    ["rail fronts FXRP", (await rail.fxrp()) === fxrpToken.address],
    ["rail is not paused", (await rail.paused()) === false],
    ["rail starts with no float", (await rail.availableLiquidity()) === 0n],
    ["resolved FdcVerification has code", (await ethers.provider.getCode(fdcVerification)) !== "0x"],
    ["FDC protocol id is 200", fdcProtocolId === 200n],
    [
      "rail carries the canonical registry constant",
      (await rail.CANONICAL_FLARE_REGISTRY()).toLowerCase() ===
        FLARE_CONTRACT_REGISTRY.toLowerCase(),
    ],
  ];

  for (const token of tokens) {
    checks.push([
      `${token.symbol} accepted`,
      await invoice.acceptedToken(token.address),
    ]);
    checks.push([
      `${token.symbol} mapped to ${token.feedName}`,
      (await priceOracle.feedIdFor(token.address)) === token.feedId,
    ]);
  }

  // The registry lookup has to be exercised, not assumed. A wrong registry, or a
  // name the registry does not know, both resolve to a plausible-looking address
  // and only fail at the first price read — which in production is a payment.
  const ftsoV2 = await priceOracle.ftsoV2Address();
  const feeCalculator = await priceOracle.feeCalculatorAddress();
  console.log(`  FtsoV2 resolves to        ${ftsoV2}`);
  console.log(`  FeeCalculator resolves to ${feeCalculator}`);
  checks.push([
    "resolved FtsoV2 has code",
    (await ethers.provider.getCode(ftsoV2)) !== "0x",
  ]);
  checks.push([
    "resolved FeeCalculator has code",
    (await ethers.provider.getCode(feeCalculator)) !== "0x",
  ]);
  if (isLocal && mockFtsoAddress) {
    checks.push(["FtsoV2 resolves to the mock", ftsoV2 === mockFtsoAddress]);
  }

  // Read a live price for every token, and derive a quote from it. This is the
  // check that would catch a wrong feed id, a decimal mistake, or a fee that has
  // stopped being zero — none of which are visible from the wiring alone.
  const observedPrices: Array<{
    symbol: string;
    feed: string;
    value: string;
    decimals: number;
    timestamp: number;
    ageSeconds: number;
    feeWei: string;
    usdPerToken: string;
    quoteFor100Usd: string;
  }> = [];

  const nowSeconds = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
  const ONE_HUNDRED_USD = 100_000_000n; // $100.000000 at the oracle's 6dp USD scale

  for (const token of tokens) {
    const [value, decimals, timestamp] = await priceOracle.getPriceUsd(token.address);
    const fee = await priceOracle.feeForToken(token.address);
    const quote = await priceOracle.quoteTokenAmount(token.address, ONE_HUNDRED_USD);

    const usdPerToken = ethers.formatUnits(value, Number(decimals));
    const quoteFormatted = ethers.formatUnits(quote, token.decimals);

    console.log(
      `  ${token.symbol.padEnd(6)} $${usdPerToken} (${decimals}dp, ${
        nowSeconds - timestamp
      }s old, fee ${fee} wei) — $100 = ${quoteFormatted} ${token.symbol}`,
    );

    observedPrices.push({
      symbol: token.symbol,
      feed: token.feedName,
      value: value.toString(),
      decimals: Number(decimals),
      timestamp: Number(timestamp),
      ageSeconds: Number(nowSeconds - timestamp),
      feeWei: fee.toString(),
      usdPerToken,
      quoteFor100Usd: quoteFormatted,
    });

    checks.push([`${token.symbol} price is non-zero`, value > 0n]);
    checks.push([`${token.symbol} quote is non-zero`, quote > 0n]);
    // Zero today on Coston2. Asserted rather than assumed, because the view read
    // path only works while it holds; getPriceUsdPaying is the answer if it stops.
    checks.push([`${token.symbol} feed fee is zero`, fee === 0n]);
  }

  let failed = 0;
  for (const [label, ok] of checks) {
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
    if (!ok) failed++;
  }
  if (failed > 0) {
    throw new Error(`${failed} post-deploy check(s) failed`);
  }

  // ---------------------------------------------------------------------
  // Record
  // ---------------------------------------------------------------------

  const record = {
    network: network.name,
    chainId,
    deployer: deployer.address,
    deployedAtBlock: await ethers.provider.getBlockNumber(),
    contracts: {
      FluxaInvoice: invoiceAddress,
      FluxaSettlement: settlementAddress,
      FluxaPriceOracle: priceOracleAddress,
      FluxaFdcPaymentRail: railAddress,
    },
    tokens,
    flare: {
      contractRegistry: registryAddress,
      registryIsCanonical: registryAddress.toLowerCase() === canonical.toLowerCase(),
      ftsoV2,
      feeCalculator,
      fdcVerification,
      fdcProtocolId: Number(fdcProtocolId),
      maxPriceAgeSeconds: Number(await priceOracle.maxPriceAge()),
    },
    observedPrices,
  };


  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const outPath = path.join(OUTPUT_DIR, `${network.name}.json`);
  fs.writeFileSync(outPath, `${JSON.stringify(record, null, 2)}\n`);

  console.log(`\nDeployment recorded at ${path.relative(process.cwd(), outPath)}`);
  console.log("\nAll post-deploy checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
