import fs from "node:fs";
import path from "node:path";

import { ethers, network } from "hardhat";

type TokenRecord = {
  symbol: string;
  address: string;
  decimals: number;
  feedId?: string;
  feedName?: string;
  mock?: boolean;
};

type BaseDeployment = {
  network: string;
  chainId: number;
  deployer: string;
  deployedAtBlock: number;
  contracts: Record<string, string>;
  tokens: TokenRecord[];
};

async function main(): Promise<void> {
  const networkName = network.name;
  const deploymentsDir = path.resolve(__dirname, "..", "deployments");
  const basePath = path.join(deploymentsDir, `${networkName}.json`);
  const output = path.join(deploymentsDir, `${networkName}-v2.json`);
  if (fs.existsSync(output) && process.env.FLUXA_ALLOW_V2_REDEPLOY !== "1") {
    throw new Error(
      `${path.relative(process.cwd(), output)} already exists. Refusing to replace a live V2 ` +
        `deployment; set FLUXA_ALLOW_V2_REDEPLOY=1 only for an intentional redeploy.`,
    );
  }
  if (!fs.existsSync(basePath)) {
    throw new Error(
      `Missing ${path.relative(process.cwd(), basePath)}. Deploy V1 first so V2 can reuse ` +
        `its proven oracle and token configuration.`,
    );
  }

  const base = JSON.parse(fs.readFileSync(basePath, "utf8")) as BaseDeployment;
  const oracle = base.contracts.FluxaPriceOracle;
  if (!oracle || !ethers.isAddress(oracle)) {
    throw new Error(`${path.basename(basePath)} has no valid FluxaPriceOracle address.`);
  }

  const accepted = base.tokens.filter((token) => token.symbol === "FXRP" || token.symbol === "USDT0");
  if (accepted.length !== 2) {
    throw new Error(`${path.basename(basePath)} must contain both FXRP and USDT0.`);
  }

  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("No deployer signer is configured.");
  const chain = await ethers.provider.getNetwork();
  if (Number(chain.chainId) !== base.chainId) {
    throw new Error(`Deployment record is chain ${base.chainId}, signer is connected to ${chain.chainId}.`);
  }

  console.log(`Deploying Fluxa V2 on ${networkName} from ${deployer.address}`);
  console.log(`Reusing oracle ${oracle}`);

  const Invoice = await ethers.getContractFactory("FluxaInvoiceV2");
  const invoice = await Invoice.deploy(deployer.address, oracle);
  await invoice.waitForDeployment();
  const invoiceAddress = await invoice.getAddress();

  const Settlement = await ethers.getContractFactory("FluxaSettlementV2");
  const settlement = await Settlement.deploy(deployer.address, invoiceAddress, oracle);
  await settlement.waitForDeployment();
  const settlementAddress = await settlement.getAddress();

  for (const token of accepted) {
    await (await invoice.setAcceptedToken(token.address, true)).wait();
    console.log(`Accepted ${token.symbol.padEnd(5)} ${token.address}`);
  }
  await (await invoice.setSettlementContract(settlementAddress)).wait();

  const receipt = await ethers.provider.getTransactionReceipt(invoice.deploymentTransaction()!.hash);
  if (!receipt) throw new Error("Could not read the V2 invoice deployment receipt.");

  const record = {
    network: networkName,
    chainId: Number(chain.chainId),
    deployer: deployer.address,
    deployedAtBlock: receipt.blockNumber,
    contracts: {
      FluxaInvoiceV2: invoiceAddress,
      FluxaSettlementV2: settlementAddress,
      FluxaPriceOracle: oracle,
    },
    tokens: accepted,
    baseDeployment: path.basename(basePath),
    reserve: {
      funded: false,
      note: "Cross-asset checkout remains unavailable until the settlement token reserve is funded.",
    },
  };

  fs.mkdirSync(deploymentsDir, { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(record, null, 2)}\n`);

  console.log(`FluxaInvoiceV2    ${invoiceAddress}`);
  console.log(`FluxaSettlementV2 ${settlementAddress}`);
  console.log(`Wrote ${path.relative(process.cwd(), output)}`);
  console.log("No reserve funds were moved. Fund explicitly before enabling cross-asset checkout.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
