/**
 * Known Coston2 token holders, for fork tests that need real assets.
 *
 * Why this file exists separately from `config/flare.ts`: everything in that file
 * was validated against chain state that does not move — contract addresses,
 * decimals, feed ids. The addresses *here* are balances, which move constantly.
 * Mixing the two would put mutable data behind a comment claiming Phase 0
 * verified it.
 *
 * ## What these are for
 *
 * A fork test that wants to pay a Fluxa invoice with *real* FXRP has to get real
 * FXRP from somewhere. The options are all worse than this one:
 *
 *   - Minting FAssets requires an agent, collateral reservation and an XRPL
 *     payment. Out of scope, and it would make the test depend on an agent being
 *     online.
 *   - `eth_getLogs` to discover a holder is capped at **30 blocks** by the public
 *     Coston2 RPC, so scanning Transfer events is not viable.
 *   - Forging a balance with `hardhat_setStorageAt` needs the FAsset proxy's
 *     storage layout, which is an implementation detail that can change under us.
 *
 * So: impersonate an account that already holds the token. On a fork this costs
 * nothing and touches no real funds.
 *
 * ## These will go stale, and that is handled
 *
 * A holder can move their balance at any time. The lists below are therefore
 * *candidates*, tried in order — see `findFundedHolder` in `test/forkHelpers.ts`,
 * which picks the first one that actually has enough on the forked block and
 * fails with a refresh instruction if none do. One whale draining their wallet
 * degrades to the next candidate instead of breaking the suite.
 *
 * ## Refreshing the lists
 *
 * Captured 11 August 2026 from the Blockscout holders API, ordered by balance:
 *
 * ```bash
 * curl -s "https://coston2-explorer.flare.network/api/v2/tokens/<TOKEN>/holders" \
 *   | python -c "import json,sys; [print(i['address']['hash'], i['value'], 'contract' if i['address'].get('is_contract') else 'EOA') for i in json.load(sys.stdin)['items'][:15]]"
 * ```
 *
 * Only EOAs are listed. A contract holder can be impersonated too, but its code
 * may reject or re-enter a transfer, which would make a test failure look like a
 * Fluxa bug rather than a bad choice of stand-in.
 *
 * Addresses are EIP-55 checksummed as Blockscout returned them. Do not retype
 * them by hand — ethers v6 rejects a bad checksum at runtime.
 */

export type HolderCandidate = {
  /** EIP-55 checksummed address. */
  address: string;
  /** Balance in the token's base units when captured. Indicative only. */
  balanceAtCapture: bigint;
};

/**
 * FXRP holders. Top entry held ~1,080,122 FXRP at capture, which is four orders
 * of magnitude more than any test needs.
 */
export const FXRP_HOLDERS: readonly HolderCandidate[] = [
  { address: "0xFf02F742106B8a25C26e65C1f0d66BEC3C90d429", balanceAtCapture: 1_080_122_127_264n },
  { address: "0x81866306DeA954C953403FCF987535de6DB745CD", balanceAtCapture: 101_697_543_615n },
  { address: "0xAE9531677EC7b6E13A6acE0C44251a0d17587A6F", balanceAtCapture: 100_010_000_000n },
  { address: "0x7C61f462771eeE3006D1B8fc9170444179859388", balanceAtCapture: 53_093_325_000n },
  { address: "0xa70e82b73a41a68bf9cc27D98df4b2003E12f119", balanceAtCapture: 50_248_800_000n },
  { address: "0xb18fD2694F710DA129Be5e630399f7a4aF3a6226", balanceAtCapture: 20_520_000_000n },
  { address: "0xCc2Ef3FbF9dA6344Ab1fb77d5e82AE975EbDc634", balanceAtCapture: 12_576_962_996n },
] as const;

/** USDT0 holders, for the settlement-asset side of a cross-asset invoice. */
export const USDT0_HOLDERS: readonly HolderCandidate[] = [
  { address: "0x3E46C6d97d38c4315db460dFdcDA57d46429f57B", balanceAtCapture: 1_000_294_100_100n },
  { address: "0xb084ac7FEa74ED619a390e84D84ECC0C30cA96fC", balanceAtCapture: 9_988_000_000n },
  { address: "0xA569F24a75463834266B919A0Bb8a79c5FBd3eD8", balanceAtCapture: 3_800_000_000n },
  { address: "0xEB70d5a49310429456c69c9B568C9ecB435B5e74", balanceAtCapture: 3_540_000_000n },
  { address: "0x681D33E7db326208221D9d76Dd3066EF18811A95", balanceAtCapture: 3_470_000_000n },
  { address: "0xD43687018Dc6510E651eC070454091A1d87f9359", balanceAtCapture: 3_450_000_000n },
] as const;

/** When the lists above were read from Blockscout. */
export const HOLDERS_CAPTURED_AT = "2026-08-11" as const;
