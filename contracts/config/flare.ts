/**
 * Flare / Coston2 constants for Fluxa.
 *
 * Every address and value here was read from Coston2 on-chain during Phase 0.
 * See docs/PHASE-0-FLARE-VALIDATION.md for how each was verified.
 *
 * Only the FlareContractRegistry address should ever be hardcoded in Solidity.
 * The protocol addresses below are recorded for scripts, tests and reference;
 * contracts must resolve them through the registry at runtime so they survive
 * Flare's protocol upgrades.
 */

export const COSTON2 = {
  chainId: 114,
  name: "coston2",
  rpcUrl: "https://coston2-api.flare.network/ext/C/rpc",
  explorer: "https://coston2-explorer.flare.network",
  faucet: "https://faucet.flare.network/coston2",
} as const;

/**
 * Identical on every Flare-family network. This is the one safe hardcode:
 * resolve everything else from it.
 */
export const FLARE_CONTRACT_REGISTRY =
  "0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019";

/** Registry-resolved protocol addresses, captured 2026-08-11. Reference only. */
export const COSTON2_PROTOCOL = {
  FtsoV2: "0xC4e9c78EA53db782E28f28Fdf80BaF59336B304d",
  FeeCalculator: "0x88A9315f96c9b5518BBeC58dC6a914e13fAb13e2",
  FdcHub: "0x48aC463d7975828989331F4De43341627b9c5f1D",
  FdcVerification: "0x906507E0B64bcD494Db73bd0459d1C667e14B933",
  FdcRequestFeeConfigurations: "0x191a1282Ac700edE65c5B0AaF313BAcC3eA7fC7e",
  Relay: "0xa10B672D1c62e5457b17af63d4302add6A99d7dE",
  FlareSystemsManager: "0xA90Db6D10F856799b10ef2A77EBCbF460aC71e52",
  AssetManagerController: "0x1C772F700308aF4c13897cc7b9c41EFfB82c50C0",
  WNat: "0xC67DCE33D7A8efA5FfEB961899C73fe01bCe9273",
} as const;

/** FXRP AssetManager (FAssets). Not registry-resolved; discovered via the controller. */
export const COSTON2_ASSET_MANAGER_FXRP =
  "0xc1Ca88b937d0b528842F95d5731ffB586f4fbDFA";

/**
 * Tokens Fluxa accepts or settles in.
 *
 * Both are 6-decimal, NOT 18. Assuming 18 is the most likely source of a
 * six-orders-of-magnitude bug in this codebase, so amounts are always handled
 * in base units with the decimals read from this table.
 */
export const COSTON2_TOKENS = {
  FXRP: {
    address: "0x0b6A3645c240605887a5532109323A3E12273dc7",
    symbol: "FXRP",
    onChainSymbol: "FTestXRP",
    decimals: 6,
    feedId: "XRP/USD",
  },
  USDT0: {
    address: "0xC1A5B41512496B80903D1f32d6dEa3a73212E71F",
    symbol: "USDT0",
    onChainSymbol: "USD₮0",
    decimals: 6,
    feedId: "USDT/USD",
  },
} as const;

export type TokenSymbol = keyof typeof COSTON2_TOKENS;

/**
 * FTSOv2 feed IDs.
 *
 * Encoding: 1 byte category + ASCII feed name, right-padded to 21 bytes.
 * Category 0x01 = crypto.
 *
 * Decimals differ per feed and are returned by getFeedById — XRP/USD reports 6
 * while FLR/USD reports 8. Never hardcode the exponent; always use the returned
 * value.
 */
export const FEED_IDS = {
  "XRP/USD": "0x015852502f55534400000000000000000000000000",
  "USDT/USD": "0x01555344542f555344000000000000000000000000",
  "USDC/USD": "0x01555344432f555344000000000000000000000000",
  "FLR/USD": "0x01464c522f55534400000000000000000000000000",
} as const;

export type FeedName = keyof typeof FEED_IDS;

/** Encode a feed name to its bytes21 ID, so IDs can be derived rather than trusted. */
export function encodeFeedId(name: string, category = 1): string {
  const hex = Buffer.from(name, "ascii").toString("hex");
  const body = hex.padEnd(40, "0"); // 20 bytes after the category byte
  if (body.length > 40) throw new Error(`Feed name too long: ${name}`);
  return `0x${category.toString(16).padStart(2, "0")}${body}`;
}

/** Flare protocol timing, read from FlareSystemsManager. */
export const FLARE_TIMING = {
  votingEpochDurationSeconds: 90,
  firstVotingRoundStartTs: 1658429488,
} as const;

/** Derive the FDC voting round that contains a given block timestamp. */
export function votingRoundIdForTimestamp(blockTimestamp: number): number {
  const { firstVotingRoundStartTs, votingEpochDurationSeconds } = FLARE_TIMING;
  return Math.floor(
    (blockTimestamp - firstVotingRoundStartTs) / votingEpochDurationSeconds,
  );
}

/**
 * FDC configuration for the cross-chain XRPL payment rail.
 *
 * protocolId is recorded for reference but contracts should call
 * FdcVerification.fdcProtocolId() at runtime, as the docs instruct.
 *
 * attestationType/sourceId are 32-byte right-padded ASCII.
 */
export const FDC = {
  protocolId: 200,
  attestationType: {
    Payment:
      "0x5061796d656e7400000000000000000000000000000000000000000000000000",
    ReferencedPaymentNonexistence:
      "0x5265666572656e6365645061796d656e744e6f6e6578697374656e6365000000",
  },
  sourceId: {
    testXRP:
      "0x7465737458525000000000000000000000000000000000000000000000000000",
  },
  verifierPaymentRoute: "verifier/xrp/Payment/prepareRequest",
  daLayerProofRoute: "api/v1/fdc/proof-by-request-round-raw",
} as const;

/** FAssets FXRP parameters, decoded from AssetManager.getSettings(). */
export const FXRP_PARAMS = {
  lotSizeXRP: 10,
  assetMintingDecimals: 6,
  maxRedeemedTickets: 20,
} as const;
