/**
 * Flare / Coston2 constants for the Fluxa frontend.
 *
 * Mirrors contracts/config/flare.ts. Every value here was read from Coston2
 * on-chain during Phase 0 — see docs/PHASE-0-FLARE-VALIDATION.md.
 *
 * Kept as a hand-maintained mirror rather than a shared package: the two
 * workspaces install independently, and `npm run check:flare` in contracts/ is
 * the single source of truth that asserts these values against the live chain.
 * If that check fails, both copies need updating.
 */

export const COSTON2 = {
  chainId: 114,
  name: 'Flare Testnet Coston2',
  rpcUrl: 'https://coston2-api.flare.network/ext/C/rpc',
  explorer: 'https://coston2-explorer.flare.network',
  faucet: 'https://faucet.flare.network/coston2',
} as const;

/** Identical on every Flare network. The one safe hardcode. */
export const FLARE_CONTRACT_REGISTRY =
  '0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019' as const;

export const COSTON2_PROTOCOL = {
  FtsoV2: '0xC4e9c78EA53db782E28f28Fdf80BaF59336B304d',
  FdcHub: '0x48aC463d7975828989331F4De43341627b9c5f1D',
  FdcVerification: '0x906507E0B64bcD494Db73bd0459d1C667e14B933',
  Relay: '0xa10B672D1c62e5457b17af63d4302add6A99d7dE',
} as const;

/** Fluxa application contracts. A deployment file or Vite env supplies these. */
export const FLUXA_CONTRACTS = {
  invoice: (import.meta.env.VITE_INVOICE_REGISTRY_ADDRESS ?? '').trim() as `0x${string}` | '',
  settlement: (import.meta.env.VITE_SETTLEMENT_VAULT_ADDRESS ?? '').trim() as `0x${string}` | '',
  invoiceV2: (import.meta.env.VITE_INVOICE_REGISTRY_V2_ADDRESS ?? '').trim() as `0x${string}` | '',
  settlementV2: (import.meta.env.VITE_SETTLEMENT_VAULT_V2_ADDRESS ?? '').trim() as `0x${string}` | '',
} as const;

/**
 * Tokens Fluxa accepts.
 *
 * Both are 6-decimal, NOT 18. Never use parseEther/formatEther on these —
 * use parseUnits/formatUnits with the decimals below.
 */
export const TOKENS = {
  FXRP: {
    address: '0x0b6A3645c240605887a5532109323A3E12273dc7',
    symbol: 'FXRP',
    label: 'FXRP',
    decimals: 6,
    feed: 'XRP/USD',
  },
  USDT0: {
    address: '0xC1A5B41512496B80903D1f32d6dEa3a73212E71F',
    symbol: 'USDT0',
    label: 'USDT0',
    decimals: 6,
    feed: 'USDT/USD',
  },
} as const;

export type TokenSymbol = keyof typeof TOKENS;
export const TOKEN_SYMBOLS = Object.keys(TOKENS) as TokenSymbol[];

/**
 * FTSOv2 feed IDs: 1 category byte (0x01 = crypto) + ASCII name, right-padded
 * to 21 bytes.
 *
 * getFeedById returns (value, decimals, timestamp) and the decimals differ per
 * feed — XRP/USD reports 6 while FLR/USD reports 8. Always divide by the
 * returned exponent, never by a constant.
 */
export const FEED_IDS = {
  'XRP/USD': '0x015852502f55534400000000000000000000000000',
  'USDT/USD': '0x01555344542f555344000000000000000000000000',
  'USDC/USD': '0x01555344432f555344000000000000000000000000',
  'FLR/USD': '0x01464c522f55534400000000000000000000000000',
} as const;

export type FeedName = keyof typeof FEED_IDS;

/** Derive a feed ID rather than trusting a typed literal. */
export function encodeFeedId(name: string, category = 1): `0x${string}` {
  const hex = Array.from(name)
    .map((c) => c.charCodeAt(0).toString(16).padStart(2, '0'))
    .join('');
  if (hex.length > 40) throw new Error(`Feed name too long: ${name}`);
  return `0x${category.toString(16).padStart(2, '0')}${hex.padEnd(40, '0')}`;
}

export function explorerAddress(address: string): string {
  return `${COSTON2.explorer}/address/${address}`;
}

export function explorerTx(hash: string): string {
  return `${COSTON2.explorer}/tx/${hash}`;
}
