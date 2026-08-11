/**
 * Coston2 connectivity and configuration check.
 *
 *   npm run check:flare
 *
 * Proves, against live chain state, that:
 *   - the RPC is reachable and reports chain 114
 *   - every address in config/flare.ts is a real deployed contract
 *   - token decimals are what we claim (6, not 18)
 *   - FTSOv2 returns usable prices for the feeds Fluxa depends on
 *   - the FXRP -> USDT0 conversion Fluxa performs actually computes
 *
 * Run this after any dependency bump or Flare protocol upgrade. It is the
 * fastest way to find out that an assumption has gone stale.
 */
import { ethers } from "hardhat";
import {
  COSTON2,
  COSTON2_PROTOCOL,
  COSTON2_TOKENS,
  COSTON2_ASSET_MANAGER_FXRP,
  FLARE_CONTRACT_REGISTRY,
  FEED_IDS,
  encodeFeedId,
  type FeedName,
} from "../config/flare";

const ERC20_ABI = [
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];
const FTSO_ABI = [
  "function getFeedById(bytes21) view returns (uint256, int8, uint64)",
  "function getFeedsById(bytes21[]) view returns (uint256[], int8[], uint64)",
];

let failures = 0;
function check(ok: boolean, label: string, detail = "") {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  const provider = ethers.provider;

  console.log("\nNetwork");
  const net = await provider.getNetwork();
  check(
    Number(net.chainId) === COSTON2.chainId,
    "chain id",
    `got ${net.chainId}, expected ${COSTON2.chainId}`,
  );
  console.log(`  block ${await provider.getBlockNumber()}`);

  console.log("\nContracts have code");
  const addresses: Record<string, string> = {
    FlareContractRegistry: FLARE_CONTRACT_REGISTRY,
    AssetManagerFXRP: COSTON2_ASSET_MANAGER_FXRP,
    ...COSTON2_PROTOCOL,
  };
  for (const [name, addr] of Object.entries(addresses)) {
    const code = await provider.getCode(addr);
    check(code !== "0x", name, code === "0x" ? "no code at address" : `${addr}`);
  }

  console.log("\nToken decimals (must be 6, not 18)");
  for (const [key, token] of Object.entries(COSTON2_TOKENS)) {
    const erc20 = new ethers.Contract(token.address, ERC20_ABI, provider);
    const [decimals, symbol] = await Promise.all([
      erc20.decimals(),
      erc20.symbol(),
    ]);
    check(
      Number(decimals) === token.decimals,
      `${key} decimals`,
      `on-chain ${decimals}, config ${token.decimals}`,
    );
    check(
      symbol === token.onChainSymbol,
      `${key} symbol`,
      `on-chain "${symbol}"`,
    );
  }

  console.log("\nFeed IDs are self-consistent");
  for (const name of Object.keys(FEED_IDS) as FeedName[]) {
    const derived = encodeFeedId(name);
    check(
      derived === FEED_IDS[name],
      `${name} encoding`,
      derived === FEED_IDS[name] ? `${derived}` : `derived ${derived}`,
    );
  }

  console.log("\nFTSOv2 live prices");
  const ftso = new ethers.Contract(
    COSTON2_PROTOCOL.FtsoV2,
    FTSO_ABI,
    provider,
  );
  const prices: Partial<Record<FeedName, number>> = {};
  for (const name of Object.keys(FEED_IDS) as FeedName[]) {
    try {
      const [value, decimals, timestamp] = await ftso.getFeedById(
        FEED_IDS[name],
      );
      // Decimals are per-feed: XRP/USD reports 6, FLR/USD reports 8.
      const price = Number(value) / 10 ** Number(decimals);
      prices[name] = price;
      const ageSeconds = Math.floor(Date.now() / 1000) - Number(timestamp);
      check(
        value > 0n && ageSeconds < 3600,
        name,
        `$${price.toFixed(6)} (${decimals} dp, ${ageSeconds}s old)`,
      );
    } catch (err) {
      check(false, name, `read failed: ${(err as Error).message.slice(0, 80)}`);
    }
  }

  // The frontend reads all feeds in one call via getFeedsById. If that
  // variant is not on the deployed contract, the price panel fails silently —
  // so assert it here rather than discovering it in the browser.
  console.log("\nFTSOv2 batch read (used by the frontend)");
  try {
    const ids = (Object.keys(FEED_IDS) as FeedName[]).map((n) => FEED_IDS[n]);
    const [values, decimalsList, timestamp] = await ftso.getFeedsById(ids);
    check(
      values.length === ids.length && decimalsList.length === ids.length,
      "getFeedsById returns one entry per feed",
      `${values.length} values, ${decimalsList.length} decimals, ts ${timestamp}`,
    );
    // Batch and single reads must agree, or the two code paths disagree on price.
    const singleXrp = prices["XRP/USD"];
    const batchXrp = Number(values[0]) / 10 ** Number(decimalsList[0]);
    check(
      singleXrp !== undefined && Math.abs(batchXrp - singleXrp) < 0.01,
      "batch agrees with single read",
      `batch $${batchXrp.toFixed(6)}`,
    );
  } catch (err) {
    check(
      false,
      "getFeedsById",
      `not callable: ${(err as Error).message.slice(0, 80)}`,
    );
  }

  console.log("\nFluxa conversion math");
  const xrpUsd = prices["XRP/USD"];
  const usdtUsd = prices["USDT/USD"];
  if (xrpUsd && usdtUsd) {
    const invoiceUsd = 500;
    const fxrpUnits = BigInt(
      Math.round((invoiceUsd / xrpUsd) * 10 ** COSTON2_TOKENS.FXRP.decimals),
    );
    const usdt0Units = BigInt(
      Math.round((invoiceUsd / usdtUsd) * 10 ** COSTON2_TOKENS.USDT0.decimals),
    );
    check(
      fxrpUnits > 0n && usdt0Units > 0n,
      "$500 invoice priced in both assets",
    );
    console.log(`        pay   ${fxrpUnits} FXRP base units  (${(Number(fxrpUnits) / 1e6).toFixed(6)} FXRP)`);
    console.log(`        settle ${usdt0Units} USDT0 base units (${(Number(usdt0Units) / 1e6).toFixed(6)} USDT0)`);
  } else {
    check(false, "conversion math", "missing a required price feed");
  }

  console.log(
    failures === 0
      ? "\nAll checks passed.\n"
      : `\n${failures} check(s) failed.\n`,
  );
  if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
