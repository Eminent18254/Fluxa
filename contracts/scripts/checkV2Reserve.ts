import fs from "node:fs";
import path from "node:path";

import { ethers, network } from "hardhat";

type V2Deployment = {
  deployedAtBlock: number;
  contracts: { FluxaSettlementV2: string };
  tokens: Array<{ symbol: string; address: string; decimals: number }>;
};

async function main(): Promise<void> {
  const file = path.resolve(__dirname, "..", "deployments", `${network.name}-v2.json`);
  if (!fs.existsSync(file)) throw new Error(`Missing ${file}. Deploy V2 first.`);
  const record = JSON.parse(fs.readFileSync(file, "utf8")) as V2Deployment;
  const [funder] = await ethers.getSigners();
  if (!funder) throw new Error("No reserve funder signer is configured.");

  const settlementAddress = record.contracts.FluxaSettlementV2;
  const settlement = await ethers.getContractAt("FluxaSettlementV2", settlementAddress);
  const gasBalance = await ethers.provider.getBalance(funder.address);

  console.log(`Network      ${network.name}`);
  console.log(`Deployed at  ${record.deployedAtBlock}`);
  console.log(`Funder       ${funder.address}`);
  console.log(`Settlement   ${settlementAddress}`);
  console.log(`Gas balance  ${ethers.formatEther(gasBalance)} C2FLR`);

  for (const token of record.tokens) {
    const erc20 = await ethers.getContractAt("IERC20", token.address);
    const [walletBalance, vaultBalance, reserved] = await Promise.all([
      erc20.balanceOf(funder.address),
      erc20.balanceOf(settlementAddress),
      settlement.totalReserved(token.address),
    ]);
    const available = vaultBalance > reserved ? vaultBalance - reserved : 0n;
    console.log(
      `${token.symbol.padEnd(5)} wallet=${ethers.formatUnits(walletBalance, token.decimals)} ` +
        `vault=${ethers.formatUnits(vaultBalance, token.decimals)} ` +
        `reserved=${ethers.formatUnits(reserved, token.decimals)} ` +
        `available=${ethers.formatUnits(available, token.decimals)}`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
