import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";
import * as path from "path";

// Secrets live in the repo-root .env, not in contracts/.
dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

const PRIVATE_KEY = process.env.PRIVATE_KEY ?? "";
const COSTON2_RPC_URL =
  process.env.COSTON2_RPC_URL ?? "https://coston2-api.flare.network/ext/C/rpc";

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      // Flare periphery contracts require cancun. Compiling under an older
      // EVM version fails on the registry libraries.
      evmVersion: "cancun",
    },
  },

  networks: {
    hardhat: {
      chainId: 31337,
    },
    coston2: {
      url: COSTON2_RPC_URL,
      chainId: 114,
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
    },
  },

  // Coston2 uses Blockscout, which ignores the API key but requires the field.
  etherscan: {
    apiKey: {
      coston2: process.env.FLARE_EXPLORER_API_KEY ?? "placeholder",
    },
    customChains: [
      {
        network: "coston2",
        chainId: 114,
        urls: {
          apiURL: "https://coston2-explorer.flare.network/api",
          browserURL: "https://coston2-explorer.flare.network",
        },
      },
    ],
  },

  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },

  mocha: {
    timeout: 120_000, // Coston2 blocks are ~1.8s; integration tests need room.
  },
};

export default config;
