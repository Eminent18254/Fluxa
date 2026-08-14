import { ArrowUpRight, BookOpen, Check, CircleDollarSign, ExternalLink, Link2, Orbit, ShieldCheck, WalletCards } from 'lucide-react'
import { Link } from 'react-router'
import { Wordmark } from '@/components/landing/Brand'
import { paths } from '@/paths'

const steps = [
  ['01', 'Create an invoice', 'Set the USD-denominated invoice value, due date, accepted payment assets, and the asset you want to receive. USD is used for pricing, not payment.'],
  ['02', 'Share one link', 'Fluxa publishes the invoice on Coston2 and gives you a customer-ready payment link.'],
  ['03', 'Customer pays', 'The customer selects FXRP or USDT0, reviews a live FTSOv2 quote, and confirms from their wallet.'],
  ['04', 'Settlement completes', 'The contract verifies the payment, checks reserve capacity, and delivers your chosen settlement asset.'],
]

export function DocsPage() {
  return (
    <div className="app-shell min-h-dvh text-night">
      <header className="px-4 pt-4 sm:px-8 sm:pt-6"><div className="mx-auto flex max-w-5xl items-center justify-between"><Link to={paths.landing}><Wordmark tone="dark" markClassName="size-9" textClassName="text-xl" /></Link><Link to={paths.invoices} className="inline-flex items-center gap-2 rounded-full border border-brand-100 bg-white/75 px-4 py-2 text-sm font-semibold text-brand-700 shadow-sm">Open app <ArrowUpRight className="size-4" /></Link></div></header>
      <main className="mx-auto max-w-5xl space-y-8 px-4 pb-16 pt-8 sm:px-8 sm:pt-12">
      <section className="grain-overlay relative overflow-hidden rounded-[2rem] bg-gradient-to-br from-[#174fd8] via-[#3976ef] to-[#9ac3fb] px-6 py-8 text-white shadow-[0_28px_80px_rgba(31,91,237,.22)] sm:px-10 sm:py-11">
        <div className="absolute -right-20 -top-24 size-72 rounded-full border-[3.5rem] border-white/10" />
        <div className="relative max-w-2xl">
          <span className="inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/12 px-3 py-1.5 text-xs font-semibold backdrop-blur-xl"><BookOpen className="size-3.5" /> Fluxa docs</span>
          <h1 className="mt-5 font-display text-4xl font-semibold tracking-[-.045em] sm:text-5xl">Everything you need to move money clearly.</h1>
          <p className="mt-4 max-w-xl text-sm leading-relaxed text-white/75 sm:text-base">A concise guide to creating invoices, accepting supported Flare assets, and following every settlement from payment link to wallet.</p>
        </div>
      </section>

      <section className="grid gap-4 sm:grid-cols-3">
        <DocCard icon={<ReceiptIcon />} title="Merchant flow" body="Create, publish, and track invoices from one workspace." />
        <DocCard icon={<WalletCards className="size-5" />} title="Customer flow" body="Pay from a wallet without creating a Fluxa account." />
        <DocCard icon={<ShieldCheck className="size-5" />} title="Verified settlement" body="Pricing, payment, and settlement are grounded on Flare." />
      </section>

      <section className="app-panel rounded-3xl p-6 sm:p-8">
        <div className="flex items-end justify-between gap-4"><div><p className="text-xs font-semibold uppercase tracking-[.14em] text-brand-600">The complete flow</p><h2 className="mt-2 font-display text-2xl font-semibold text-night">From invoice to settlement</h2></div><Link to={paths.newInvoice} className="hidden items-center gap-1.5 text-sm font-semibold text-brand-700 sm:inline-flex">Create invoice <ArrowUpRight className="size-4" /></Link></div>
        <div className="mt-7 grid gap-3 md:grid-cols-4">{steps.map(([number, title, body]) => <div key={number} className="rounded-2xl border border-brand-100/80 bg-gradient-to-br from-[#f1f5ff] via-white to-brand-50/70 p-5"><span className="font-display text-sm font-semibold text-brand-500">{number}</span><h3 className="mt-8 font-display text-lg font-semibold text-night">{title}</h3><p className="mt-2 text-sm leading-relaxed text-night/52">{body}</p></div>)}</div>
      </section>

      <section className="grid gap-5 lg:grid-cols-2">
        <Guide title="For merchants" items={['Connect the wallet that will own and receive settlements.', 'Open Create, enter the invoice value and customer-facing details.', 'Choose FXRP, USDT0, or both as the customer payment options.', 'Choose the settlement asset you want delivered to your wallet.', 'Publish the invoice, copy its public link, and send it to your customer.', 'Track OPEN, PAID, and SETTLED updates from the Invoices screen.']} />
        <Guide title="For customers" items={['Open the payment link; no Fluxa account is required.', 'Review the merchant, invoice amount, due date, and accepted assets.', 'Connect a browser wallet and switch to Coston2 when prompted.', 'Select an accepted asset and review the exact live quote.', 'Approve token access when required, then confirm the payment.', 'Keep the receipt page as verifiable confirmation of settlement.']} />
      </section>

      <section className="app-panel rounded-3xl p-6 sm:p-8"><p className="text-xs font-semibold uppercase tracking-[.14em] text-brand-600">Invoice states</p><h2 className="mt-2 font-display text-2xl font-semibold text-night">Know what each status means</h2><div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{[['Draft','Not yet published or payable.'],['Open','Published and ready for payment.'],['Paid','Customer payment is confirmed on-chain.'],['Settled','The merchant has received the selected settlement asset.']].map(([title,body])=><div key={title} className="rounded-2xl border border-brand-100 bg-brand-50/55 p-4"><span className="inline-flex rounded-full bg-white px-2.5 py-1 text-xs font-semibold text-brand-700 ring-1 ring-brand-100">{title}</span><p className="mt-3 text-sm leading-relaxed text-night/52">{body}</p></div>)}</div></section>

      <section className="grid gap-5 lg:grid-cols-[1.15fr_.85fr]">
        <div className="app-panel rounded-3xl p-6 sm:p-8"><p className="text-xs font-semibold uppercase tracking-[.14em] text-brand-600">Supported rails</p><h2 className="mt-2 font-display text-2xl font-semibold text-night">Pay with what you have. Settle with what you want.</h2><div className="mt-6 space-y-3"><Asset symbol="FXRP" detail="XRP-derived Flare asset · payment and settlement" icon={<Orbit className="size-5" />} /><Asset symbol="USDT0" detail="USD stablecoin · payment and settlement" icon={<CircleDollarSign className="size-5" />} /><Asset symbol="C2FLR" detail="Coston2 gas only · not an invoice payment asset" icon={<ZapIcon />} /></div></div>
        <div className="app-panel-soft rounded-3xl p-6 sm:p-8"><p className="text-xs font-semibold uppercase tracking-[.14em] text-brand-600">Why Flare</p><h2 className="mt-2 font-display text-2xl font-semibold text-night">The infrastructure is part of the product.</h2><p className="mt-3 text-sm leading-relaxed text-night/55">FTSOv2 supplies live decentralized pricing, while Coston2 contracts enforce invoice state, quote protection, and reserve-backed settlement.</p><a href="https://dev.flare.network" target="_blank" rel="noreferrer" className="mt-6 inline-flex items-center gap-2 text-sm font-semibold text-brand-700">Read Flare documentation <ExternalLink className="size-4" /></a></div>
      </section>
      </main>
      <footer className="border-t border-brand-100/70 px-4 py-6 text-center text-xs text-night/45">Fluxa · Crypto invoices with flexible payment and settlement on Flare</footer>
    </div>
  )
}

function DocCard({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) { return <div className="app-panel rounded-2xl p-5"><span className="grid size-10 place-items-center rounded-xl bg-gradient-to-br from-brand-600 to-iris-500 text-white shadow-lg shadow-brand-600/15">{icon}</span><h3 className="mt-5 font-display font-semibold text-night">{title}</h3><p className="mt-2 text-sm leading-relaxed text-night/52">{body}</p></div> }
function Asset({ symbol, detail, icon }: { symbol: string; detail: string; icon: React.ReactNode }) { return <div className="flex items-center gap-3 rounded-2xl border border-brand-100 bg-white/70 p-3"><span className="grid size-10 place-items-center rounded-xl bg-brand-600 text-white">{icon}</span><div><p className="font-semibold text-night">{symbol}</p><p className="text-xs text-night/48">{detail}</p></div><Check className="ml-auto size-4 text-brand-500" /></div> }
function Guide({ title, items }: { title: string; items: string[] }) { return <div className="app-panel rounded-3xl p-6 sm:p-8"><h2 className="font-display text-2xl font-semibold text-night">{title}</h2><ol className="mt-6 space-y-4">{items.map((item,index)=><li key={item} className="flex gap-3 text-sm leading-relaxed text-night/58"><span className="grid size-6 shrink-0 place-items-center rounded-full bg-brand-600 text-[.65rem] font-bold text-white">{index+1}</span>{item}</li>)}</ol></div> }
function ReceiptIcon() { return <Link2 className="size-5" /> }
function ZapIcon() { return <span className="text-sm font-bold">FLR</span> }
