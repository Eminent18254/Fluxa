/**
 * Connected account's FXRP / USDT0 holdings.
 *
 * Both tokens are 6-decimal. The decimal count is displayed next to each
 * balance because it is the single assumption most likely to be wrong in code
 * that touches these tokens, and Phase 0 confirmed it on-chain.
 */
import { useAccount } from 'wagmi';
import { useTokenBalances } from '@/hooks/useTokenBalances';
import { useFtsoPrices } from '@/hooks/useFtsoPrices';
import { TOKENS, TOKEN_SYMBOLS, explorerAddress, COSTON2 } from '@/config/flare';
import { formatAmount, formatUsd } from '@/lib/format';
import { Card } from './ui';

export function TokenBalances() {
  const { address, isConnected } = useAccount();
  const { balances, isLoading } = useTokenBalances(address);
  const { prices } = useFtsoPrices();

  if (!isConnected) {
    return (
      <Card title="Balances" subtitle="Connect a wallet to see your holdings">
        <p className="text-sm text-ink-400">Not connected.</p>
      </Card>
    );
  }

  return (
    <Card
      title="Balances"
      subtitle="FXRP and USDT0 on Coston2"
      action={
        <a
          href={COSTON2.faucet}
          target="_blank"
          rel="noreferrer"
          className="text-xs text-flare-300 hover:underline"
        >
          Faucet ↗
        </a>
      }
    >
      <div className="space-y-2">
        {TOKEN_SYMBOLS.map((symbol) => {
          const token = TOKENS[symbol];
          const balance = balances[symbol];
          const price = prices[token.feed];
          const usd =
            balance && price
              ? (Number(balance.units) / 10 ** token.decimals) * price.price
              : null;

          return (
            <div
              key={symbol}
              className="flex items-center justify-between rounded-lg border border-ink-700 bg-ink-800/50 px-3 py-2.5"
            >
              <div>
                <a
                  href={explorerAddress(token.address)}
                  target="_blank"
                  rel="noreferrer"
                  className="text-sm font-medium text-ink-50 hover:text-flare-300"
                >
                  {token.label}
                </a>
                <span className="ml-2 text-[10px] text-ink-400">
                  {token.decimals} decimals
                </span>
              </div>
              <div className="text-right">
                <div className="tabular font-mono text-sm text-ink-50">
                  {isLoading && !balance
                    ? '—'
                    : balance
                      ? formatAmount(balance.units, balance.decimals)
                      : '0'}
                </div>
                {usd !== null && (
                  <div className="tabular text-[10px] text-ink-400">
                    ≈ {formatUsd(usd)}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
