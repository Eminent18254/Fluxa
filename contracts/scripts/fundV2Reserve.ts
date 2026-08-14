import fs from "node:fs";
import path from "node:path";

import { ethers, network } from "hardhat";

type V2Deployment = {
  contracts: { FluxaSettlementV2: string };
  tokens: Array<{ symbol: string; address: string; decimals: number }>;
};

async function main(): Promise<void> {
  const file = path.resolve(__dirname, "..", "deployments", `${network.name}-v2.json`);
  if (!fs.existsSync(file)) throw new Error(`Missing ${file}. Deploy V2 first.`);
  const record = JSON.parse(fs.readFileSync(file, "utf8")) as V2Deployment;
  const [funder] = await ethers.getSigners();
  if (!funder) throw new Error("No reserve funder signer is configured.");

  const requested: Record<string, string | undefined> = {
    FXRP: process.env.FLUXA_V2_RESERVE_FXRP,
    USDT0: process.env.FLUXA_V2_RESERVE_USDT0,
  };
  if (!requested.FXRP && !requested.USDT0) {
    throw new Error(
      "Set FLUXA_V2_RESERVE_FXRP and/or FLUXA_V2_RESERVE_USDT0 to the explicit token amount to fund.",
    );
  }

  const settlement = await ethers.getContractAt(
    "FluxaSettlementV2",
    record.contracts.FluxaSettlementV2,
  );
  for (const token of record.tokens) {
    const text = requested[token.symbol];
    if (!text) continue;
    const amount = ethers.parseUnits(text, token.decimals);
    if (amount <= 0n) throw new Error(`${token.symbol} reserve amount must be positive.`);
    const erc20 = await ethers.getContractAt("IERC20", token.address);
    const balance = await erc20.balanceOf(funder.address);
    if (balance < amount) {
      throw new Error(
        `${funder.address} has ${ethers.formatUnits(balance, token.decimals)} ${token.symbol}, ` +
          `but ${text} was requested.`,
      );
    }
    await (await erc20.approve(record.contracts.FluxaSettlementV2, amount)).wait();
    await (await settlement.fundReserve(token.address, amount)).wait();
    console.log(`Funded ${text} ${token.symbol} into ${record.contracts.FluxaSettlementV2}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
