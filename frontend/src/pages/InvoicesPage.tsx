import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ArrowRight,
  ArrowUpRight,
  CircleDollarSign,
  Clock3,
  Coins,
  Plus,
  ReceiptText,
  RefreshCw,
  Sparkles,
  FileText,
  WalletCards,
} from 'lucide-react'
import { Link } from 'react-router'
import { formatUnits } from 'viem'
import { Button } from '@/components/Button'
import { LoadingState } from '@/components/LoadingState'
import { StatusBadge } from '@/components/invoice/StatusBadge'
import { useWalletModal } from '@/components/wallet/WalletModalProvider'
import { useTokenBalances } from '@/hooks/useTokenBalances'
import { useWallet } from '@/hooks/useWallet'
import { isOverdue, listInvoices, type Invoice } from '@/lib/db'
import { formatUsd, shortenAddress } from '@/lib/format'
import { hasSupabaseConfig, supabase } from '@/lib/supabase'
import { hasWalletSession } from '@/lib/walletAuth'
import { paths } from '@/routes'
import type { InvoiceStatus } from '@/types/database'

const DAY = 86_400_000
const FILTERS: { key: string; label: string; statuses?: InvoiceStatus[] }[] = [
  { key: 'all', label: 'All' },
  { key: 'open', label: 'Open', statuses: ['OPEN', 'PENDING'] },
  { key: 'paid', label: 'Paid', statuses: ['PAID', 'SETTLED'] },
  { key: 'drafts', label: 'Drafts', statuses: ['DRAFT'] },
]

function dueLabel(inv: Invoice): string {
  if (inv.status === 'PAID' || inv.status === 'SETTLED') return 'Completed'
  if (inv.status === 'CANCELLED') return 'Withdrawn'
  if (isOverdue(inv)) return 'Overdue'
  const days = Math.round((new Date(inv.dueAt).getTime() - Date.now()) / DAY)
  if (inv.status === 'EXPIRED') return 'Expired'
  if (days === 0) return 'Due today'
  if (days === 1) return 'Due tomorrow'
  if (days > 1) return `Due in ${days} days`
  return `Due ${Math.abs(days)} days ago`
}

export function InvoicesPage() {
  const [filter, setFilter] = useState('all')
  const [invoices, setInvoices] = useState<Invoice[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const { address, isConnected, isConnecting, isWrongChain } = useWallet()
  const { open: openWallet } = useWalletModal()
  const [sessionReady, setSessionReady] = useState(false)
  const [sessionChecking, setSessionChecking] = useState(true)
  const tokenBalances = useTokenBalances(address)

  useEffect(() => {
    let active = true
    if (!isConnected || !address) {
      setSessionReady(false)
      setSessionChecking(false)
      setInvoices([])
      setLoading(false)
      return
    }
    const check = async () => {
      try {
        const ready = await Promise.race([
          hasWalletSession(address),
          new Promise<boolean>((resolve) => window.setTimeout(() => resolve(false), 6_000)),
        ])
        if (active) setSessionReady(ready)
      } catch {
        if (active) setSessionReady(false)
      } finally {
        if (active) setSessionChecking(false)
      }
    }
    setSessionChecking(true)
    void check()
    const timer = window.setInterval(() => void check(), 10_000)
    return () => { active = false; window.clearInterval(timer) }
  }, [address, isConnected])

  const load = useCallback(async () => {
    if (!isConnected || !address || !sessionReady) {
      setInvoices([])
      setLoading(false)
      return
    }
    if (!hasSupabaseConfig()) {
      setInvoices([])
      setLoadError(true)
      setLoading(false)
      return
    }
    try {
      const result = await listInvoices(supabase(), { limit: 200 })
      setInvoices(result.invoices)
      setLoadError(false)
      void tokenBalances.refetch()
    } catch {
      setLoadError(true)
    } finally {
      setLoading(false)
    }
  }, [address, isConnected, sessionReady, tokenBalances.refetch])

  useEffect(() => {
    if (!isConnected || !address || !sessionReady) return
    void load()
    if (!hasSupabaseConfig()) return
    const client = supabase()
    const channel = client.channel('merchant-invoices-live').on('postgres_changes', { event: '*', schema: 'public', table: 'invoices' }, () => void load()).subscribe()
    const fallback = window.setInterval(() => void load(), 15_000)
    return () => { window.clearInterval(fallback); void client.removeChannel(channel) }
  }, [address, isConnected, load, sessionReady])

  const stats = useMemo(() => {
    let outstanding = 0
    let paid = 0
    let open = 0
    for (const inv of invoices) {
      if (inv.status === 'OPEN' || inv.status === 'PENDING') { outstanding += inv.usdAmountNumber; open += 1 }
      if (inv.status === 'PAID' || inv.status === 'SETTLED') paid += inv.usdAmountNumber
    }
    return { outstanding, paid, open, total: invoices.length }
  }, [invoices])

  const visible = useMemo(() => {
    const current = FILTERS.find((item) => item.key === filter)
    return current?.statuses ? invoices.filter((invoice) => current.statuses!.includes(invoice.status)) : invoices
  }, [filter, invoices])

  if (isConnecting) return <LoadingState label="Connecting wallet" />
  if (!isConnected || !address) return <MerchantGate title="Your invoices stay private" body="Connect the merchant wallet that owns this workspace." action="Connect wallet" onAction={openWallet} />
  if (isWrongChain) return <MerchantGate title="Switch to Coston2" body="Fluxa invoices and balances are available on the Coston2 testnet." action="Switch network" onAction={openWallet} />
  if (sessionChecking) return <LoadingState label="Opening invoices" />
  if (!sessionReady) return <MerchantGate title="Confirm your wallet session" body="Sign once to unlock your private invoice workspace." action="Continue" onAction={openWallet} />

  return (
    <div className="space-y-8">
      <section className="grain-overlay relative overflow-hidden rounded-[2rem] bg-gradient-to-br from-[#1f5bed] via-[#4f89f2] to-[#94bcfb] px-5 py-6 text-white shadow-[0_28px_80px_rgba(31,91,237,.24)] sm:px-8 sm:py-8">
        <div className="absolute -right-20 -top-24 size-72 rounded-full border-[3.5rem] border-white/10" />
        <div className="absolute bottom-0 left-1/3 h-24 w-72 rounded-full bg-white/15 blur-3xl" />
        <div className="relative z-10 flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="max-w-xl font-display text-3xl font-semibold tracking-[-.04em] sm:text-4xl">Every invoice. One clear view.</h1>
            <p className="mt-3 max-w-xl text-sm leading-relaxed text-white/72 sm:text-base">Issue invoices, follow payment activity, and see what has reached your wallet.</p>
          </div>
          <Link to={paths.newInvoice} className="premium-button inline-flex h-12 shrink-0 items-center justify-center gap-2 rounded-full bg-white px-5 text-sm font-semibold text-brand-700 shadow-[0_14px_35px_rgba(14,31,82,.18)] transition-transform hover:-translate-y-0.5">
            <Plus className="size-4" /> Create invoice
          </Link>
        </div>
      </section>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Invoice summary">
        <Stat label="Outstanding" value={formatUsd(stats.outstanding)} visual="bars" tone="brand" />
        <Stat label="Settled volume" value={formatUsd(stats.paid)} visual="ring" tone="cobalt" />
        <Stat label="Open invoices" value={String(stats.open)} visual="stack" tone="sky" />
        <Stat label="Total invoices" value={String(stats.total)} visual="dots" tone="iris" />
      </section>

      <section className="app-panel-soft grid overflow-hidden rounded-2xl sm:grid-cols-2">
        <WalletBalance symbol="FXRP" value={tokenBalances.balances.FXRP ? `${formatUnits(tokenBalances.balances.FXRP.units, tokenBalances.balances.FXRP.decimals)} FXRP` : '0 FXRP'} />
        <WalletBalance symbol="USDT0" value={tokenBalances.balances.USDT0 ? `${formatUnits(tokenBalances.balances.USDT0.units, tokenBalances.balances.USDT0.decimals)} USDT0` : '0 USDT0'} />
      </section>

      <section>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="font-display text-xl font-semibold text-night">Recent activity</h2>
          </div>
          <div className="inline-flex w-fit rounded-full border border-brand-100 bg-white/70 p-1 shadow-sm backdrop-blur-xl">
            {FILTERS.map((item) => (
              <button key={item.key} type="button" onClick={() => setFilter(item.key)} className={`rounded-full px-3.5 py-1.5 text-xs font-semibold transition-all ${item.key === filter ? 'bg-brand-600 text-white shadow-sm' : 'text-night/50 hover:text-night'}`}>
                {item.label}
              </button>
            ))}
          </div>
        </div>

        {loadError ? <LoadError onRetry={() => void load()} /> : loading ? <InvoiceSkeleton /> : visible.length === 0 ? <EmptyState filter={filter} /> : (
          <div className="mt-4 overflow-hidden rounded-2xl border border-white/80 bg-gradient-to-br from-white via-[#f7faff] to-brand-50/70 shadow-[0_22px_65px_rgba(31,91,237,.10)] ring-1 ring-brand-100/60">
            <div className="hidden grid-cols-[minmax(0,1.5fr)_minmax(10rem,.8fr)_8rem_8rem_6rem] gap-4 border-b border-brand-100/70 px-5 py-3 text-[.68rem] font-semibold uppercase tracking-[.13em] text-night/35 md:grid">
              <span>Invoice</span><span>Terms</span><span>Status</span><span className="text-right">Amount</span><span />
            </div>
            <div className="space-y-2 px-2 pb-2 pt-2">
              {visible.map((invoice) => (
                <Link key={invoice.id} to={paths.pay(invoice.id)} className="group relative grid gap-3 overflow-hidden rounded-2xl border border-brand-100/80 bg-white/72 px-3 py-4 shadow-[0_8px_26px_rgba(36,82,224,.06),inset_0_1px_0_rgba(255,255,255,.9)] backdrop-blur-xl transition-all before:absolute before:inset-y-3 before:left-0 before:w-1 before:rounded-full before:bg-gradient-to-b before:from-brand-400 before:to-iris-400 hover:-translate-y-0.5 hover:border-brand-200 hover:bg-white hover:shadow-[0_14px_38px_rgba(36,82,224,.12)] sm:px-4 md:grid-cols-[minmax(0,1.5fr)_minmax(10rem,.8fr)_8rem_8rem_6rem] md:items-center md:gap-4">
                  <div className="flex min-w-0 items-center gap-3">
                    <ActivityMark status={invoice.status} />
                    <div className="min-w-0"><p className="truncate text-sm font-semibold text-night">{invoice.title}</p><p className="mt-0.5 truncate text-xs text-night/42">{invoice.customerAddress ? shortenAddress(invoice.customerAddress) : 'Open payment link'}{invoice.description ? ` · ${invoice.description}` : ''}</p></div>
                  </div>
                  <div className="hidden md:block"><p className="text-sm font-medium text-night/65">{dueLabel(invoice)}</p><p className="mt-0.5 text-xs text-night/38">Accepts {invoice.acceptedPaymentAssets.join(' / ')} · settles {invoice.settlementTokenSymbol}</p></div>
                  <div className="flex items-center justify-between md:block"><span className="text-xs text-night/42 md:hidden">Status</span><StatusBadge status={invoice.status} /></div>
                  <div className="flex items-center justify-between md:block md:text-right"><span className="text-xs text-night/42 md:hidden">Amount</span><span className="tabular font-display text-base font-semibold text-night">{formatUsd(invoice.usdAmountNumber)}</span></div>
                  <span className="inline-flex items-center justify-end gap-1 text-xs font-semibold text-brand-700 md:hidden">{invoice.status === 'OPEN' || invoice.status === 'PENDING' ? 'Share link' : 'View invoice'}<ArrowRight className="size-3.5" /></span>
                  <span className="hidden items-center justify-end gap-1 text-xs font-semibold text-brand-700 md:inline-flex">{invoice.status === 'OPEN' || invoice.status === 'PENDING' ? 'Share link' : 'View invoice'}<ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" /></span>
                </Link>
              ))}
            </div>
          </div>
        )}
      </section>
    </div>
  )
}

function MerchantGate({ title, body, action, onAction, loading = false }: { title: string; body: string; action?: string; onAction?: () => void; loading?: boolean }) {
  return (
    <div className="mx-auto grid min-h-[60vh] max-w-xl place-items-center text-center">
      <div className="app-panel w-full rounded-3xl px-7 py-12">
        <span className="mx-auto grid size-14 place-items-center rounded-2xl bg-gradient-to-br from-brand-100 to-white text-brand-600 ring-1 ring-brand-100"><WalletCards className={`size-7 ${loading ? 'animate-pulse' : ''}`} strokeWidth={1.6} /></span>
        <h1 className="mt-5 font-display text-2xl font-semibold text-night">{title}</h1>
        <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-night/52">{body}</p>
        {action && onAction && <Button className="mt-6" onClick={onAction}><WalletCards className="size-4" />{action}</Button>}
      </div>
    </div>
  )
}

function Stat({ label, value, visual, tone }: { label: string; value: string; visual: 'bars' | 'ring' | 'stack' | 'dots'; tone: 'brand' | 'cobalt' | 'sky' | 'iris' }) {
  const tones = { brand: 'from-brand-600 to-brand-700 text-white', cobalt: 'from-[#326cf1] to-[#183fb9] text-white', sky: 'from-[#76a9fb] to-brand-500 text-white', iris: 'from-iris-400 to-iris-600 text-white' }
  return <div className="app-panel group relative overflow-hidden rounded-2xl bg-gradient-to-br from-white/90 to-brand-50/45 p-5 transition-transform duration-200 hover:-translate-y-1"><span className={`absolute -right-8 -top-8 size-24 rounded-full bg-gradient-to-br opacity-[.1] ${tones[tone]}`} /><div className="relative flex items-start justify-between gap-3"><div><p className="text-xs font-medium text-night/45">{label}</p><p className="tabular mt-3 font-display text-2xl font-semibold tracking-[-.035em] text-night">{value}</p></div><MiniVisual kind={visual} tone={tones[tone]} /></div></div>
}

function MiniVisual({ kind, tone }: { kind: 'bars' | 'ring' | 'stack' | 'dots'; tone: string }) {
  return <span className={`relative grid size-11 place-items-center overflow-hidden rounded-xl bg-gradient-to-br shadow-lg ${tone}`}>
    {kind === 'bars' && <span className="flex h-6 items-end gap-1"><i className="h-2 w-1.5 rounded-full bg-white/55" /><i className="h-4 w-1.5 rounded-full bg-white/75" /><i className="h-6 w-1.5 rounded-full bg-white" /></span>}
    {kind === 'ring' && <span className="grid size-6 place-items-center rounded-full border-[5px] border-white/35 border-t-white"><i className="size-1.5 rounded-full bg-white" /></span>}
    {kind === 'stack' && <span className="relative h-6 w-7"><i className="absolute left-0 top-1 h-5 w-5 rounded-md border border-white/45 bg-white/20" /><i className="absolute right-0 top-0 h-5 w-5 rounded-md border border-white/70 bg-white/35" /></span>}
    {kind === 'dots' && <span className="grid grid-cols-2 gap-1.5">{[0,1,2,3].map((item)=><i key={item} className="size-2 rounded-[3px] bg-white/85" />)}</span>}
  </span>
}

function WalletBalance({ symbol, value }: { symbol: 'FXRP' | 'USDT0'; value: string }) {
  return <div className="flex items-center justify-between gap-4 px-5 py-4 first:border-b first:border-brand-100/70 sm:first:border-b-0 sm:first:border-r"><div className="flex items-center gap-3"><span className={`grid size-9 place-items-center rounded-xl ${symbol === 'FXRP' ? 'bg-brand-600 text-white' : 'bg-iris-500 text-white'}`}>{symbol === 'FXRP' ? <Coins className="size-4" /> : <CircleDollarSign className="size-4" />}</span><div><p className="text-xs text-night/42">Wallet balance</p><p className="text-sm font-semibold text-night">{symbol}</p></div></div><span className="tabular text-sm font-semibold text-night">{value}</span></div>
}

function ActivityMark({ status }: { status: InvoiceStatus }) {
  const Icon = status === 'SETTLED' || status === 'PAID' ? ArrowUpRight : status === 'OPEN' || status === 'PENDING' ? Sparkles : status === 'DRAFT' ? FileText : Clock3
  const tone = status === 'SETTLED' ? 'from-iris-500 to-brand-600' : status === 'PAID' ? 'from-brand-500 to-brand-700' : 'from-brand-300 to-[#76a9fb]'
  return <span className={`grid size-10 shrink-0 place-items-center rounded-xl bg-gradient-to-br ${tone} text-white shadow-[0_8px_20px_rgba(36,82,224,.18)]`}><Icon className="size-4.5" strokeWidth={1.8} /></span>
}

function LoadError({ onRetry }: { onRetry: () => void }) {
  return <div className="app-error mt-4 flex flex-col items-start justify-between gap-3 px-4 py-4 sm:flex-row sm:items-center"><div><p className="text-sm font-semibold">Invoices could not be refreshed</p><p className="mt-0.5 text-xs opacity-75">Check your connection and try again.</p></div><Button variant="secondary" size="sm" onClick={onRetry}><RefreshCw className="size-3.5" />Retry</Button></div>
}

function InvoiceSkeleton() {
  return <div className="app-panel mt-4 overflow-hidden rounded-2xl">{[0, 1, 2].map((item) => <div key={item} className="flex items-center gap-4 border-b border-brand-50 px-5 py-5 last:border-0"><span className="size-10 animate-pulse rounded-xl bg-brand-100" /><div className="flex-1"><div className="h-3 w-36 animate-pulse rounded-full bg-brand-100" /><div className="mt-2 h-2.5 w-52 max-w-full animate-pulse rounded-full bg-brand-50" /></div><div className="h-6 w-20 animate-pulse rounded-full bg-brand-50" /></div>)}</div>
}

function EmptyState({ filter }: { filter: string }) {
  return <div className="app-panel-soft mt-4 rounded-2xl px-6 py-14 text-center"><span className="mx-auto grid size-12 place-items-center rounded-2xl bg-white text-brand-600 shadow-sm ring-1 ring-brand-100"><ReceiptText className="size-6" strokeWidth={1.6} /></span><h3 className="mt-4 font-display text-lg font-semibold text-night">{filter === 'all' ? 'Create your first invoice' : 'No invoices in this view'}</h3><p className="mx-auto mt-1.5 max-w-sm text-sm text-night/50">{filter === 'all' ? 'Set the amount, accepted assets, and settlement preference in one short flow.' : 'Choose another filter or create a new payment request.'}</p>{filter === 'all' && <Link to={paths.newInvoice} className="mt-5 inline-flex h-10 items-center gap-2 rounded-full bg-brand-600 px-4 text-sm font-semibold text-white"><Plus className="size-4" />New invoice</Link>}</div>
}
