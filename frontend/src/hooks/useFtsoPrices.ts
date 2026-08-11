/**
 * Live FTSOv2 prices, read straight from the oracle contract on Coston2.
 *
 * No price API, no backend cache — the browser calls getFeedsById on the FTSOv2
 * contract and renders what Flare's decentralised oracle reports. That is the
 * point: an invoice's exchange rate is verifiable by anyone against the same
 * on-chain source.
 *
 * getFeedsById returns parallel arrays plus one shared timestamp, so a single
 * RPC round-trip covers every feed the app needs.
 */
import { useReadContract } from 'wagmi';
import { COSTON2_PROTOCOL, FEED_IDS, type FeedName } from '@/config/flare';
import { ftsoV2Abi } from '@/lib/abi';

export interface FeedPrice {
  /** Price as a plain number, already scaled by the feed's own decimals. */
  price: number;
  /** The exponent FTSO returned for this feed — 6 for XRP/USD, 8 for FLR/USD. */
  decimals: number;
  /** Seconds since the oracle last updated, so staleness can be shown. */
  ageSeconds: number;
  timestamp: number;
}

const FEED_NAMES = Object.keys(FEED_IDS) as FeedName[];
const FEED_ID_LIST = FEED_NAMES.map((n) => FEED_IDS[n]);

export function useFtsoPrices() {
  const query = useReadContract({
    address: COSTON2_PROTOCOL.FtsoV2,
    abi: ftsoV2Abi,
    functionName: 'getFeedsById',
    args: [FEED_ID_LIST],
    query: {
      // Feeds update on a ~90s voting round; refetching faster just burns RPC.
      refetchInterval: 30_000,
      staleTime: 15_000,
    },
  });

  const prices: Partial<Record<FeedName, FeedPrice>> = {};

  if (query.data) {
    const [values, decimals, timestamp] = query.data;
    const ts = Number(timestamp);
    const ageSeconds = Math.max(0, Math.floor(Date.now() / 1000) - ts);

    FEED_NAMES.forEach((name, i) => {
      const raw = values[i];
      const dp = Number(decimals[i]);
      if (raw === undefined || Number.isNaN(dp)) return;
      prices[name] = {
        price: Number(raw) / 10 ** dp,
        decimals: dp,
        ageSeconds,
        timestamp: ts,
      };
    });
  }

  return {
    prices,
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
    refetch: query.refetch,
  };
}

/**
 * Convert a USD invoice total into token base units at the live oracle rate.
 *
 * Done in bigint throughout: a $500 invoice at $1.004879/XRP is 497572345 base
 * units, and float arithmetic on 6-decimal amounts loses cents.
 */
export function usdToTokenUnits(
  usdCents: bigint,
  price: FeedPrice,
  tokenDecimals: number,
): bigint {
  if (price.price <= 0) throw new Error('Oracle price is zero or negative');

  // usdCents / (priceValue / 10^priceDecimals) scaled to token decimals,
  // with the /100 undoing cents.
  const priceUnits = BigInt(Math.round(price.price * 10 ** price.decimals));
  const numerator =
    usdCents * 10n ** BigInt(tokenDecimals) * 10n ** BigInt(price.decimals);
  return numerator / (priceUnits * 100n);
}
