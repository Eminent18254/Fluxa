import { ConnectWallet } from '@/components/ConnectWallet';
import { PriceFeeds } from '@/components/PriceFeeds';
import { TokenBalances } from '@/components/TokenBalances';
import { Badge, Card } from '@/components/ui';
import { COSTON2 } from '@/config/flare';

export function App() {
  return (
    <div className="min-h-screen bg-ink-950">
      <header className="border-b border-ink-800">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="flex size-8 items-center justify-center rounded-lg bg-flare-500 font-bold text-white">
              F
            </div>
            <div>
              <h1 className="text-sm font-semibold text-ink-50">Fluxa</h1>
              <p className="text-[11px] text-ink-400">
                Invoice in crypto, settle on Flare
              </p>
            </div>
          </div>
          <ConnectWallet />
        </div>
      </header>

      <main className="mx-auto max-w-5xl space-y-4 px-6 py-8">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="flare">{COSTON2.name}</Badge>
          <Badge>chain {COSTON2.chainId}</Badge>
          <Badge tone="success">Phase 0 validated</Badge>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <PriceFeeds />
          <TokenBalances />
        </div>

        <Card
          title="Two settlement rails"
          subtitle="How a Fluxa invoice gets paid"
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border border-ink-700 bg-ink-800/50 p-4">
              <div className="mb-2 flex items-center gap-2">
                <Badge tone="success">Rail A</Badge>
                <span className="text-xs text-ink-400">on-Flare</span>
              </div>
              <p className="text-sm text-ink-200">
                Customer pays FXRP or USDT0 on Coston2. The invoice contract
                observes the transfer directly.
              </p>
              <p className="mt-2 text-[11px] text-ink-400">
                No attestation needed — the payment is already in the state of
                the contract verifying it.
              </p>
            </div>

            <div className="rounded-lg border border-ink-700 bg-ink-800/50 p-4">
              <div className="mb-2 flex items-center gap-2">
                <Badge tone="flare">Rail B</Badge>
                <span className="text-xs text-ink-400">cross-chain</span>
              </div>
              <p className="text-sm text-ink-200">
                Customer pays native XRP on the XRP Ledger, tagged with the
                invoice reference. The Flare Data Connector attests it.
              </p>
              <p className="mt-2 text-[11px] text-ink-400">
                A Merkle proof is verified on Coston2 before the invoice moves to
                PAID — this is where FDC does real work.
              </p>
            </div>
          </div>
        </Card>
      </main>

      <footer className="border-t border-ink-800">
        <div className="mx-auto max-w-5xl px-6 py-6 text-[11px] text-ink-400">
          Built for Flare Summer Signal · Track 1, Interoperable Asset Products ·
          testnet only
        </div>
      </footer>
    </div>
  );
}
