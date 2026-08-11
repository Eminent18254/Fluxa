/**
 * ERC-20 balances for the tokens Fluxa accepts.
 *
 * Decimals come from config, which Phase 0 verified on-chain as 6 for both FXRP
 * and USDT0. The hook still returns them alongside the balance so no consumer
 * is tempted to assume 18.
 */
import { useReadContracts } from 'wagmi';
import type { Address } from 'viem';
import { TOKENS, TOKEN_SYMBOLS, type TokenSymbol } from '@/config/flare';
import { erc20Abi } from '@/lib/abi';

export interface TokenBalance {
  symbol: TokenSymbol;
  units: bigint;
  decimals: number;
  address: Address;
}

export function useTokenBalances(owner?: Address) {
  const query = useReadContracts({
    contracts: TOKEN_SYMBOLS.map((symbol) => ({
      address: TOKENS[symbol].address as Address,
      abi: erc20Abi,
      functionName: 'balanceOf' as const,
      args: [owner ?? '0x0000000000000000000000000000000000000000'],
    })),
    query: {
      enabled: Boolean(owner),
      refetchInterval: 20_000,
    },
  });

  const balances: Partial<Record<TokenSymbol, TokenBalance>> = {};

  query.data?.forEach((result, i) => {
    const symbol = TOKEN_SYMBOLS[i];
    if (!symbol || result.status !== 'success') return;
    balances[symbol] = {
      symbol,
      units: result.result as bigint,
      decimals: TOKENS[symbol].decimals,
      address: TOKENS[symbol].address as Address,
    };
  });

  return {
    balances,
    isLoading: query.isLoading,
    isError: query.isError,
    refetch: query.refetch,
  };
}
