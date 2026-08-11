/**
 * Live FTSOv2 feed panel.
 *
 * This is the most direct evidence in the UI that Fluxa is reading Flare's
 * oracle rather than a price API: the feed ID, the per-feed decimal exponent
 * and the oracle's own timestamp are all shown, so anyone can reproduce the
 * same read against the FTSOv2 contract on Coston2.
 */
import { useFtsoPrices } from '@/hooks/useFtsoPrices';
import { FEED_IDS, COSTON2_PROTOCOL, explorerAddress, type FeedName } from '@/config/flare';
import { formatPrice, formatAge } from '@/lib/format';
import { Badge, Card } from './ui';

const FEED_NAMES = Object.keys(FEED_IDS) as FeedName[];

export function PriceFeeds() {
  const { prices, isLoading, isError } = useFtsoPrices();

  return (
    <Card
      title="FTSOv2 live feeds"
      subtitle="Read on-chain from Flare's decentralised oracle — no price API"
      action={
        <a
          href={explorerAddress(COSTON2_PROTOCOL.FtsoV2)}
          target="_blank"
          rel="noreferrer"
          className="text-xs text-flare-300 hover:underline"
        >
          View contract ↗
        </a>
      }
    >
      {isError && (
        <p className="text-sm text-danger-500">
          Could not reach FTSOv2. Check the Coston2 RPC.
        </p>
      )}

      <div className="grid gap-2 sm:grid-cols-2">
        {FEED_NAMES.map((name) => {
          const feed = prices[name];
          return (
            <div
              key={name}
              className="rounded-lg border border-ink-700 bg-ink-800/50 p-3"
            >
              <div className="flex items-baseline justify-between">
                <span className="text-xs font-medium text-ink-200">{name}</span>
                {feed && (
                  <span className="text-[10px] text-ink-400">
                    {feed.decimals} dp
                  </span>
                )}
              </div>
              <div className="tabular mt-1 font-mono text-lg text-ink-50">
                {isLoading && !feed ? (
                  <span className="text-ink-400">—</span>
                ) : feed ? (
                  formatPrice(feed.price)
                ) : (
                  <span className="text-ink-400">unavailable</span>
                )}
              </div>
              {feed && (
                <div className="mt-1 text-[10px] text-ink-400">
                  updated {formatAge(feed.ageSeconds)}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <p className="mt-3 text-[11px] leading-relaxed text-ink-400">
        Decimals differ per feed — XRP/USD reports 6, FLR/USD reports 8. Fluxa
        divides by the exponent the oracle returns, never by a constant.
      </p>
    </Card>
  );
}

/** Compact strip for the invoice form: just the rate being applied. */
export function FeedTicker({ feed }: { feed: FeedName }) {
  const { prices } = useFtsoPrices();
  const price = prices[feed];
  if (!price) return null;
  return (
    <Badge tone="flare">
      <span className="tabular font-mono">
        {feed} {formatPrice(price.price)}
      </span>
      <span className="text-ink-400">· {formatAge(price.ageSeconds)}</span>
    </Badge>
  );
}
