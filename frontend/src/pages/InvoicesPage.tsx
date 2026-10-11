import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowRight, Plus, ReceiptText, RefreshCw } from 'lucide-react'
import { Link } from 'react-router'
import { Button } from '@/components/Button'
import { LoadingState } from '@/components/LoadingState'
import { StatusBadge } from '@/components/invoice/StatusBadge'
import { useWalletModal } from '@/components/wallet/WalletModalProvider'
import { useWallet } from '@/hooks/useWallet'
import { fetchMyObligations } from '@/lib/genlayer/client'
import {
  daysUntilDue,
  formatDueDate,
  formatMinorUnits,
  isOverdue,
  type Obligation,
  type ObligationStatus,
} from '@/lib/obligations'
import { paths } from '@/routes'

/**
 * The merchant's home. The list is read straight from the contract, so what a
 * merchant sees here is what the committee decided - there is no projection to
 * drift out of date or to disagree with the chain.
 *
 * Filters use the contract's own statuses. A freshly submitted obligation is
 * "Awaiting review", which is a real state with a real next action, rather than
 * being folded into a generic "open".
 */
const FILTERS: { key: string; label: string; statuses?: ObligationStatus[] }[] = [
  { key: 'all', label: 'All' },
  { key: 'review', label: 'Awaiting review', statuses: ['SUBMITTED'] },
  { key: 'evidence', label: 'Needs evidence', statuses: ['MORE_EVIDENCE_REQUIRED'] },
  { key: 'verified', label: 'Verified', statuses: ['VERIFIED'] },
  { key: 'rejected', label: 'Rejected', statuses: ['REJECTED'] },
  { key: 'paid', label: 'Paid', statuses: ['PAID'] },
]

function dueLabel(obligation: Obligation): string {
  if (obligation.status === 'PAID') return 'Settled'
  const days = daysUntilDue(obligation)
  if (isOverdue(obligation)) return `Overdue by ${Math.abs(days)}d`
  if (days === 0) return 'Due today'
  if (days === 1) return 'Due tomorrow'
  return `Due in ${days}d`
}

export function InvoicesPage() {
  const [filter, setFilter] = useState('all')
  const [obligations, setObligations] = useState<Obligation[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const { address, isConnected } = useWallet()
  const { open } = useWalletModal()

  const load = useCallback(async () => {
    if (!isConnected || !address) {
      setObligations([])
      setLoading(false)
      return
    }
    try {
      setObligations(await fetchMyObligations(address))
      setLoadError(null)
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : 'Obligations could not be loaded.')
    } finally {
      setLoading(false)
    }
  }, [address, isConnected])

  useEffect(() => {
    void load()
  }, [load])

  const stats = useMemo(() => {
    let awaiting = 0
    let verified = 0
    let paid = 0
    let needsEvidence = 0
    for (const item of obligations) {
      const amount = Number(item.amountMinor) / 100
      if (item.status === 'SUBMITTED') awaiting += amount
      if (item.status === 'VERIFIED') verified += amount
      if (item.status === 'PAID') paid += amount
      if (item.status === 'MORE_EVIDENCE_REQUIRED') needsEvidence += 1
    }
    return { awaiting, verified, paid, needsEvidence, total: obligations.length }
  }, [obligations])

  const active = FILTERS.find((item) => item.key === filter) ?? FILTERS[0]
  const visible = active.statuses ? obligations.filter((item) => active.statuses!.includes(item.status)) : obligations

  if (!isConnected) {
    return (
      <div className="app-panel-soft rounded-3xl px-6 py-16 text-center">
        <span className="mx-auto grid size-12 place-items-center rounded-2xl bg-white text-brand-600 shadow-sm ring-1 ring-brand-100">
          <ReceiptText className="size-6" strokeWidth={1.6} />
        </span>
        <h1 className="mt-5 font-display text-2xl font-semibold">Connect to see your obligations</h1>
        <p className="mx-auto mt-2 max-w-md text-sm text-night/55">
          Your obligations live on GenLayer, addressed by your wallet. Connect the wallet that created them.
        </p>
        <Button className="mt-6" onClick={open}>
          Connect wallet
        </Button>
      </div>
    )
  }

  if (loading) return <LoadingState label="Loading obligations" compact />

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase text-brand-600">Merchant workspace</p>
          <h1 className="mt-2 font-display text-3xl font-semibold">Obligations</h1>
        </div>
        <Link to={paths.newInvoice}>
          <Button>
            <Plus className="size-4" />
            New obligation
          </Button>
        </Link>
      </div>

      <div className="mt-7 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Awaiting review" value={formatMinorUnits(String(Math.round(stats.awaiting * 100)))} />
        <Stat label="Verified, unpaid" value={formatMinorUnits(String(Math.round(stats.verified * 100)))} />
        <Stat label="Paid" value={formatMinorUnits(String(Math.round(stats.paid * 100)))} />
        <Stat label="Total obligations" value={String(stats.total)} />
      </div>

      {stats.needsEvidence > 0 && (
        <p className="app-error mt-4 px-4 py-3 text-sm">
          {stats.needsEvidence} obligation{stats.needsEvidence > 1 ? 's' : ''} need more evidence before they can be verified.
        </p>
      )}

      <div className="mt-6 flex flex-wrap gap-2">
        {FILTERS.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => setFilter(item.key)}
            className={`h-9 rounded-full px-4 text-sm font-semibold transition-colors ${
              filter === item.key ? 'bg-brand-600 text-white' : 'bg-white text-night/55 ring-1 ring-brand-100 hover:text-night'
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      {loadError && (
        <div className="app-error mt-4 flex flex-col items-start justify-between gap-3 px-4 py-4 sm:flex-row sm:items-center">
          <div>
            <p className="text-sm font-semibold">Obligations could not be refreshed</p>
            <p className="mt-0.5 text-xs opacity-75">{loadError}</p>
          </div>
          <Button variant="secondary" size="sm" onClick={() => void load()}>
            <RefreshCw className="size-3.5" />
            Retry
          </Button>
        </div>
      )}

      {visible.length === 0 ? (
        <div className="app-panel-soft mt-4 rounded-2xl px-6 py-14 text-center">
          <h3 className="font-display text-lg font-semibold">
            {obligations.length === 0 ? 'Record your first obligation' : 'Nothing in this view'}
          </h3>
          <p className="mx-auto mt-1.5 max-w-sm text-sm text-night/50">
            {obligations.length === 0
              ? 'Add the terms and the evidence. The committee reviews it and writes a decision on chain.'
              : 'Choose another filter.'}
          </p>
        </div>
      ) : (
        <ul className="app-panel mt-4 divide-y divide-brand-50 overflow-hidden rounded-2xl">
          {visible.map((item) => (
            <li key={item.id}>
              <Link
                to={`${paths.pay(item.id)}?view=merchant`}
                className="flex flex-wrap items-center gap-3 px-5 py-4 transition-colors hover:bg-brand-50/50"
              >
                <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600">
                  <ReceiptText className="size-4.5" strokeWidth={1.8} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-semibold text-night">{item.externalId}</span>
                  <span className="block text-xs text-night/50">
                    {formatDueDate(item.dueAt)} · {dueLabel(item)}
                  </span>
                </span>
                <span className="tabular font-semibold text-night">
                  {formatMinorUnits(item.amountMinor, item.currency)}
                </span>
                <StatusBadge status={item.status} />
                <ArrowRight className="size-4 text-night/30" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="app-panel rounded-2xl p-5">
      <p className="text-xs font-medium text-night/45">{label}</p>
      <p className="tabular mt-3 font-display text-2xl font-semibold tracking-[-.035em] text-night">{value}</p>
    </div>
  )
}
