import { http, createConfig } from 'wagmi';
import { injected } from 'wagmi/connectors';
import { coston2 } from './chains';

/**
 * Wagmi config for Fluxa.
 *
 * Injected-only by default: MetaMask and every browser wallet that speaks
 * EIP-1193 works without an API key, so the demo has no third-party signup as a
 * dependency. WalletConnect can be added later behind a project id.
 */
export const wagmiConfig = createConfig({
  chains: [coston2],
  connectors: [injected()],
  transports: {
    [coston2.id]: http(coston2.rpcUrls.default.http[0]),
  },
  ssr: false,
});

declare module 'wagmi' {
  interface Register {
    config: typeof wagmiConfig;
  }
}
