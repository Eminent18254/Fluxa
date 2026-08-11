import { defineChain } from 'viem';
import { COSTON2 } from './flare';

/**
 * Coston2 defined explicitly rather than imported from viem/chains.
 *
 * The RPC and explorer here are the ones Phase 0 validated against, so what the
 * browser talks to is provably the same endpoint `npm run check:flare` asserts.
 */
export const coston2 = defineChain({
  id: COSTON2.chainId,
  name: COSTON2.name,
  nativeCurrency: {
    name: 'Coston2 Flare',
    symbol: 'C2FLR',
    decimals: 18,
  },
  rpcUrls: {
    default: { http: [COSTON2.rpcUrl] },
  },
  blockExplorers: {
    default: {
      name: 'Coston2 Explorer',
      url: COSTON2.explorer,
    },
  },
  testnet: true,
});
