/**
 * GenLayer network configuration.
 *
 * Fluxa runs on one network: GenLayer Studionet (chain 61999), the network the
 * CLI deploys to. The chain object comes from the SDK rather than being
 * hand-rolled, so the chain id, RPC and currency cannot drift from the client.
 *
 * The contract address has a compiled-in fallback because `.env` is gitignored:
 * without it a fresh clone or a host with no env vars would boot with no
 * contract and every read would fail. A stored override is validated before it
 * is trusted, because a stale or truncated address is truthy and would
 * otherwise silently replace a working one.
 */
import { studionet } from 'genlayer-js/chains';

/** The chain this app reads and writes. */
export const GENLAYER_CHAIN = studionet;

/** The FluxaObligation deployment. Public, so it can live in source. */
const DEPLOYED_CONTRACT = '0x4Cb20B9dD428F2B14bf4d256a1342a4cC39a5cEE';

/** The SDK's placeholder explorer URL is not the Studionet explorer. */
const EXPLORER_URL = 'https://explorer-studio.genlayer.com';

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const CONFIGURED_CONTRACT = String(import.meta.env.VITE_GENLAYER_OBLIGATION_CONTRACT ?? '').trim();

export const GENLAYER = {
  chainId: GENLAYER_CHAIN.id,
  chainName: GENLAYER_CHAIN.name,
  rpcUrl: GENLAYER_CHAIN.rpcUrls.default.http[0],
  explorerUrl: EXPLORER_URL,
  obligationContract: ADDRESS_PATTERN.test(CONFIGURED_CONTRACT) ? CONFIGURED_CONTRACT : DEPLOYED_CONTRACT,
} as const;

export function isConfigured(): boolean {
  return ADDRESS_PATTERN.test(GENLAYER.obligationContract);
}

export function contractLink(): string {
  return `${GENLAYER.explorerUrl}/address/${GENLAYER.obligationContract}`;
}

export function txLink(hash: string): string {
  return `${GENLAYER.explorerUrl}/tx/${hash}`;
}
