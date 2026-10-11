import { useCallback, useEffect, useState } from 'react'
import { Check, ChevronLeft, Copy, ExternalLink } from 'lucide-react'
import { Link, useParams, useSearchParams } from 'react-router'
import { Button, Spinner } from '@/components/Button'
import { LoadingState } from '@/components/LoadingState'
import { StatusBadge } from '@/components/invoice/StatusBadge'
import { Wordmark } from '@/components/landing/Brand'
import { WalletButton } from '@/components/wallet/WalletButton'
import { useWalletModal } from '@/components/wallet/WalletModalProvider'
import { useWallet } from '@/hooks/useWallet'
import { fetchObligation, recordPayment, replaceEvidence, submitVerification } from '@/lib/genlayer/client'
import {
  formatDueDate,
  formatMinorUnits,
  isOverdue,
  MAX_EVIDENCE_CHARS,
  type Obligation,
} from '@/lib/obligations'
import { shortenAddress } from '@/lib/format'
import { paths } from '@/routes'

/**
 * One page, two audiences.
 *
 * A buyer opens this from a link and should never be asked to connect a wallet
 * before they understand what they are being asked to pay. A merchant opens the
 * same URL to run or re-run verification. The panel at the bottom is chosen from
 * the connected address, not from a mode toggle, so nobody can act as the wrong
 * party by accident - and the contract enforces the same split regardless.
 */
export function PayInvoicePage() {
  const { invoiceId } = useParams<{ invoiceId: string }>()
  const [search] = useSearchParams()
  const [obligation, setObligation] = useState<Obligation | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const { address } = useWallet()

  const load = useCallback(async () => {
    if (!invoiceId) {
      setLoading(false)
      return
    }
    try {
      setObligation(await fetchObligation(invoiceId))
      setLoadError(null)
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : 'This obligation could not be loaded.')
    } finally {
      setLoading(false)
    }
  }, [invoiceId])

  useEffect(() => {
    void load()
  }, [load])

  if (loading) return <LoadingState label="Loading obligation" />
  if (!obligation) {
    return (
      <Page>
        <div className="mx-auto max-w-lg py-24 text-center">
          <h1 className="font-display text-3xl font-semibold">Obligation unavailable</h1>
          <p className="mt-3 text-night/55">{loadError ?? 'This link is invalid or the contract is not configured.'}</p>
        </div>
      </Page>
    )
  }

  const viewer = address?.toLowerCase()
  const isMerchant = Boolean(viewer && viewer === obligation.merchant.toLowerCase())
  const isBuyer = Boolean(viewer && viewer === obligation.buyer.toLowerCase())
  const merchantView = search.get('view') === 'merchant' || isMerchant

  return (
    <Page>
      <div className="mx-auto max-w-2xl">
        <Link to={paths.landing} className="mb-5 inline-flex items-center gap-2 text-sm text-night/55">
          <ChevronLeft className="size-4" />
          Back to Fluxa
        </Link>

        <section className="overflow-hidden rounded-2xl border border-brand-100 bg-white shadow-xl">
          <header className="bg-brand-700 px-6 py-6 text-white">
            <p className="text-xs font-semibold uppercase text-white/60">Fluxa on GenLayer</p>
            <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
              <h1 className="font-display text-2xl font-semibold">{obligation.externalId}</h1>
              <StatusBadge status={obligation.status} />
            </div>
          </header>

          <div className="space-y-4 px-6 py-6">
            <Row label="Amount">{formatMinorUnits(obligation.amountMinor, obligation.currency)}</Row>
            <Row label="Merchant">{shortenAddress(obligation.merchant)}</Row>
            <Row label="Buyer">{shortenAddress(obligation.buyer)}</Row>
            <Row label="Due">
              {formatDueDate(obligation.dueAt)}
              {isOverdue(obligation) && <span className="ml-2 text-xs font-semibold text-danger-500">Overdue</span>}
            </Row>
            <Row label="Evidence">
              <a
                href={obligation.evidenceUri}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-brand-700 hover:underline"
              >
                Manifest
                <ExternalLink className="size-3.5" />
              </a>
            </Row>
            <p className="break-all rounded-xl bg-brand-50 p-3 font-mono text-[.68rem] text-night/55">
              {obligation.evidenceDigest}
            </p>
          </div>

          {obligation.decision !== 'NONE' && (
            <div className="border-t border-brand-100 px-6 py-6">
              <div className="flex items-center justify-between">
                <h2 className="font-display text-base font-semibold">Committee decision</h2>
                <span className="text-xs font-semibold uppercase text-night/45">
                  {obligation.confidenceBand} confidence · revision {obligation.decisionRevision}
                </span>
              </div>
              {obligation.reason && <p className="mt-3 text-sm leading-relaxed text-night/70">{obligation.reason}</p>}
              {obligation.inconsistencies.length > 0 && (
                <ul className="mt-4 space-y-2">
                  {obligation.inconsistencies.map((item) => (
                    <li key={item} className="flex gap-2 rounded-xl bg-warn-500/8 p-3 text-xs leading-relaxed text-night/70">
                      <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-warn-500" />
                      {item}
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-4 text-[.68rem] text-night/40">
                Policy {obligation.policyVersion} · evidence revision {obligation.evidenceRevision}
              </p>
            </div>
          )}

          {merchantView ? (
            <MerchantPanel obligation={obligation} isMerchant={isMerchant} onChanged={load} />
          ) : (
            <BuyerPanel obligation={obligation} isBuyer={isBuyer} onChanged={load} />
          )}
        </section>
      </div>
    </Page>
  )
}

function BuyerPanel({
  obligation,
  isBuyer,
  onChanged,
}: {
  obligation: Obligation
  isBuyer: boolean
  onChanged: () => Promise<void>
}) {
  const { isConnected, address } = useWallet()
  const { open } = useWalletModal()
  const [reference, setReference] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  if (obligation.status === 'PAID') {
    return (
      <div className="border-t border-brand-100 bg-brand-50 px-6 py-8 text-center">
        <Check className="mx-auto size-8 text-emerald-600" />
        <h2 className="mt-3 font-display text-xl font-semibold">Payment recorded</h2>
        <p className="mt-2 break-all text-sm text-night/55">{obligation.paymentReference}</p>
      </div>
    )
  }

  if (obligation.status !== 'VERIFIED') {
    return (
      <div className="border-t border-brand-100 bg-brand-50/60 px-6 py-6">
        <p className="text-sm leading-relaxed text-night/60">
          Payment stays locked until the committee returns a VERIFIED decision. This obligation is currently{' '}
          <span className="font-semibold text-night">{obligation.status}</span>.
        </p>
      </div>
    )
  }

  async function pay() {
    if (!isConnected || !address) {
      open()
      return
    }
    if (!isBuyer) {
      setError(`This obligation is payable by ${shortenAddress(obligation.buyer)}. Connect that wallet to record payment.`)
      return
    }
    try {
      setBusy(true)
      setError(null)
      await recordPayment(obligation.id, reference.trim() || `fluxa:${obligation.id}:${address}:${Date.now()}`)
      await onChanged()
      setDone(true)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Payment could not be recorded.')
    } finally {
      setBusy(false)
    }
  }

  if (done) {
    return (
      <div className="border-t border-brand-100 bg-brand-50 px-6 py-8 text-center">
        <Check className="mx-auto size-8 text-emerald-600" />
        <h2 className="mt-3 font-display text-xl font-semibold">Payment recorded</h2>
      </div>
    )
  }

  return (
    <div className="border-t border-brand-100 bg-brand-50/60 px-6 py-6">
      <p className="text-sm text-night/60">
        This obligation is verified. The recorded buyer can attach a payment reference on chain.
      </p>
      <input
        value={reference}
        onChange={(event) => setReference(event.target.value)}
        placeholder="Bank or transfer reference (optional)"
        className="app-input mt-4 px-3.5 py-2.5"
      />
      <Button className="mt-4 w-full" size="lg" onClick={pay} disabled={busy}>
        {busy ? (
          <>
            <Spinner className="size-4" />
            Recording
          </>
        ) : isConnected ? (
          'Record payment'
        ) : (
          'Connect to pay'
        )}
      </Button>
      {error && <p className="app-error mt-3 p-3 text-xs">{error}</p>}
    </div>
  )
}

function MerchantPanel({
  obligation,
  isMerchant,
  onChanged,
}: {
  obligation: Obligation
  isMerchant: boolean
  onChanged: () => Promise<void>
}) {
  const { isConnected } = useWallet()
  const { open } = useWalletModal()
  const [evidence, setEvidence] = useState('')
  const [uri, setUri] = useState(obligation.evidenceUri)
  const [digest, setDigest] = useState(obligation.evidenceDigest)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const canVerify = obligation.status === 'SUBMITTED' || obligation.status === 'MORE_EVIDENCE_REQUIRED'
  const needsEvidence = obligation.status === 'MORE_EVIDENCE_REQUIRED'

  async function run() {
    if (!isConnected) {
      open()
      return
    }
    if (!isMerchant) {
      setError('Only the merchant who created this obligation can run verification.')
      return
    }
    if (!evidence.trim()) {
      setError('Paste the evidence the committee should read.')
      return
    }
    try {
      setBusy(true)
      setError(null)
      if (needsEvidence && (uri.trim() !== obligation.evidenceUri || digest.trim() !== obligation.evidenceDigest)) {
        await replaceEvidence(obligation.id, uri.trim(), digest.trim())
      }
      await submitVerification(obligation.id, evidence.trim())
      await onChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Verification could not be completed.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="border-t border-brand-100 bg-brand-50/60 px-6 py-6">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-display text-base font-semibold">Merchant controls</h2>
        <Button
          variant="secondary"
          size="sm"
          onClick={() =>
            navigator.clipboard.writeText(location.href.replace('?view=merchant', '')).then(() => setCopied(true))
          }
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {copied ? 'Copied' : 'Copy customer link'}
        </Button>
      </div>

      {obligation.status === 'PAID' ? (
        <p className="mt-3 text-sm text-night/60">This obligation is paid. No further action is available.</p>
      ) : canVerify ? (
        <>
          <p className="mt-3 text-sm leading-relaxed text-night/60">
            {needsEvidence
              ? 'The committee asked for more evidence. Update the manifest if the files changed, then run verification again.'
              : 'Hand the recorded evidence to the validator committee.'}
          </p>

          {needsEvidence && (
            <div className="mt-4 space-y-3">
              <input value={uri} onChange={(event) => setUri(event.target.value)} className="app-input px-3.5 py-2.5" placeholder="https://..." />
              <input
                value={digest}
                onChange={(event) => setDigest(event.target.value)}
                className="app-input px-3.5 py-2.5 font-mono text-xs"
                placeholder="sha256:..."
              />
            </div>
          )}

          <textarea
            rows={6}
            value={evidence}
            maxLength={MAX_EVIDENCE_CHARS}
            onChange={(event) => setEvidence(event.target.value)}
            className="app-input mt-4 resize-y px-3.5 py-2.5 font-mono text-xs leading-relaxed"
            placeholder="Paste the evidence for the committee."
          />
          <Button className="mt-4 w-full" size="lg" onClick={run} disabled={busy}>
            {busy ? (
              <>
                <Spinner className="size-4" />
                Committee reviewing
              </>
            ) : (
              'Run verification'
            )}
          </Button>
        </>
      ) : (
        <p className="mt-3 text-sm leading-relaxed text-night/60">
          The committee has already returned {obligation.decision}. A new decision needs a fresh review, which is not
          available at this revision.
        </p>
      )}

      {error && <p className="app-error mt-3 p-3 text-xs">{error}</p>}
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-brand-100 pb-3 text-sm">
      <span className="text-night/45">{label}</span>
      <span className="font-semibold text-night">{children}</span>
    </div>
  )
}

function Page({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh bg-brand-50/40">
      <header className="border-b border-brand-100 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-4">
          <Wordmark />
          <WalletButton />
        </div>
      </header>
      <main className="px-5 py-10">{children}</main>
      <footer className="py-6 text-center text-xs text-night/40">GenLayer Studionet · testnet only</footer>
    </div>
  )
}
