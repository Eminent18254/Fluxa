import { useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { ReceiptText } from 'lucide-react'
import { Button, Spinner } from '@/components/Button'
import { useWalletModal } from '@/components/wallet/WalletModalProvider'
import { useWallet } from '@/hooks/useWallet'
import { createObligation, fetchObligations, submitVerificationAndConfirm } from '@/lib/genlayer/client'
import {
  defaultDueDate,
  formatMinorUnits,
  hasErrors,
  toMinorUnits,
  toUnixSeconds,
  validateDraft,
  type DraftErrors,
  type Obligation,
} from '@/lib/obligations'
import { paths } from '@/routes'

const inputClass = 'app-input px-3.5 py-2.5 placeholder:text-night/30'

type Stage = 'idle' | 'recording' | 'verifying'

/**
 * Creating an obligation is two contract calls, and the UI says so rather than
 * pretending it is one.
 *
 *   1. `create_obligation` writes the commercial terms. Fast, deterministic.
 *   2. `submit_verification` makes the validator committee fetch the manifest
 *      this obligation points at and rule on it. Slow, and it can legitimately
 *      come back as more-evidence-required.
 *
 * Splitting them means a merchant never waits on a committee to find out whether
 * their terms were even accepted.
 */
export function NewInvoicePage() {
  const { address, isConnected, isWrongChain } = useWallet()
  const { open } = useWalletModal()

  const [form, setForm] = useState({
    externalId: '',
    buyer: '',
    currency: 'USD',
    amount: '',
    dueDate: defaultDueDate(),
    evidenceUri: '',
    evidenceDigest: '',
  })
  const [errors, setErrors] = useState<DraftErrors>({})
  const [stage, setStage] = useState<Stage>('idle')
  const [failure, setFailure] = useState<string | null>(null)
  const [created, setCreated] = useState<Obligation | null>(null)

  function update<K extends keyof typeof form>(key: K, value: string) {
    setForm((current) => ({ ...current, [key]: value }))
  }

  const busy = stage !== 'idle'

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!isConnected || !address) {
      open()
      return
    }
    if (isWrongChain) {
      setFailure('Switch your wallet to the GenLayer network first.')
      return
    }

    const found = validateDraft(form)
    setErrors(found)
    if (hasErrors(found)) return

    try {
      setFailure(null)
      setStage('recording')

      await createObligation({
        externalId: form.externalId.trim(),
        buyer: form.buyer.trim(),
        currency: form.currency.trim().toUpperCase(),
        amountMinor: toMinorUnits(form.amount),
        dueAt: toUnixSeconds(form.dueDate),
        evidenceUri: form.evidenceUri.trim(),
        evidenceDigest: form.evidenceDigest.trim(),
      })

      // The contract assigns the id, so read it back rather than guessing.
      const mine = await fetchObligations()
      const match = mine.find(
        (item) => item.externalId === form.externalId.trim() && item.merchant.toLowerCase() === address.toLowerCase(),
      )
      if (!match) throw new Error('The obligation was recorded but could not be read back from the contract.')
      setCreated(match)

      setStage('verifying')
      await submitVerificationAndConfirm(match.id)

      const [fresh] = await Promise.all([fetchObligations().then((rows) => rows.find((row) => row.id === match.id))])
      if (fresh) setCreated(fresh)
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : 'The obligation could not be submitted.')
      setStage('idle')
      return
    }
    setStage('idle')
  }

  if (created) {
    return (
      <div className="mx-auto max-w-xl py-16 text-center">
        <ReceiptText className="mx-auto size-10 text-brand-600" />
        <h1 className="mt-5 font-display text-3xl font-semibold">Obligation recorded</h1>
        <p className="mt-3 text-night/55">
          The committee fetched the manifest, checked it against the recorded digest, and wrote its decision on chain.
          Changing that decision needs a new evidence revision.
        </p>
        <div className="mt-6 rounded-2xl border border-brand-100 bg-white p-5 text-left">
          <Row label="Reference">{created.externalId}</Row>
          <Row label="Amount">{formatMinorUnits(created.amountMinor, created.currency)}</Row>
          <Row label="Decision">{created.decision}</Row>
          <Row label="Confidence">{created.confidenceBand}</Row>
          {created.reason && <p className="mt-3 text-sm leading-relaxed text-night/60">{created.reason}</p>}
        </div>
        <Link to={paths.pay(created.id)} className="mt-6 inline-flex text-sm font-semibold text-brand-700">
          Open the obligation
        </Link>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-3xl py-8">
      <div className="mb-7">
        <p className="text-xs font-semibold uppercase text-brand-600">GenLayer obligation</p>
        <h1 className="mt-2 font-display text-3xl font-semibold">Record an evidence-backed obligation</h1>
        <p className="mt-2 max-w-2xl text-sm text-night/55">
          The commercial terms are stored on chain. A validator committee then reads the evidence against those terms and
          publishes a bounded decision.
        </p>
      </div>

      <form onSubmit={submit} className="space-y-5 rounded-2xl border border-brand-100 bg-white p-6 shadow-lg sm:p-8">
        <Grid>
          <Field label="Reference" error={errors.externalId}>
            <input
              value={form.externalId}
              onChange={(event) => update('externalId', event.target.value)}
              className={inputClass}
              placeholder="INV-2026-014"
            />
          </Field>
          <Field label="Amount" error={errors.amount}>
            <div className="flex gap-2">
              <input
                value={form.amount}
                onChange={(event) => update('amount', event.target.value)}
                className={inputClass}
                placeholder="1250.00"
                inputMode="decimal"
              />
              <input
                value={form.currency}
                onChange={(event) => update('currency', event.target.value)}
                className={`${inputClass} w-24 uppercase`}
                placeholder="USD"
                maxLength={3}
              />
            </div>
            {errors.currency && <span className="mt-1 block text-xs font-medium text-danger-500">{errors.currency}</span>}
          </Field>
        </Grid>

        <Grid>
          <Field label="Buyer wallet" error={errors.buyer}>
            <input
              value={form.buyer}
              onChange={(event) => update('buyer', event.target.value)}
              className={inputClass}
              placeholder="0x..."
            />
          </Field>
          <Field label="Due date" error={errors.dueDate}>
            <input
              type="date"
              value={form.dueDate}
              onChange={(event) => update('dueDate', event.target.value)}
              className={inputClass}
            />
          </Field>
        </Grid>

        <Field label="Evidence manifest URL" error={errors.evidenceUri}>
          <input
            value={form.evidenceUri}
            onChange={(event) => update('evidenceUri', event.target.value)}
            className={inputClass}
            placeholder="https://..."
          />
        </Field>

        <Field label="Evidence SHA-256 digest" error={errors.evidenceDigest}>
          <input
            value={form.evidenceDigest}
            onChange={(event) => update('evidenceDigest', event.target.value)}
            className={inputClass}
            placeholder="sha256:<64 hex characters>"
          />
        </Field>

        <p className="rounded-xl bg-brand-50 p-3 text-xs leading-relaxed text-night/60">
          The committee fetches this URL itself and refuses to rule unless the bytes it downloads hash to the digest above,
          so the manifest has to be public and stable. Whatever it contains is treated as untrusted content, never as
          instructions.
        </p>

        {failure && <p className="app-error p-3 text-sm">{failure}</p>}

        <div className="flex items-center gap-3 border-t border-brand-100 pt-5">
          <Button type="submit" size="lg" disabled={busy}>
            {busy ? (
              <>
                <Spinner className="size-4" />
                {stage === 'recording' ? 'Recording terms' : 'Committee reviewing'}
              </>
            ) : (
              'Record and verify'
            )}
          </Button>
          <Link to={paths.invoices} className="text-sm text-night/55">
            Cancel
          </Link>
        </div>
      </form>
    </div>
  )
}

function Field({ label, error, children }: { label: string; error?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-2 block text-sm font-semibold text-night">{label}</span>
      {children}
      {error && <span className="mt-1 block text-xs font-medium text-danger-500">{error}</span>}
    </label>
  )
}

function Grid({ children }: { children: React.ReactNode }) {
  return <div className="grid gap-5 sm:grid-cols-2">{children}</div>
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between border-b border-brand-50 py-2 text-sm last:border-0">
      <span className="text-night/45">{label}</span>
      <span className="font-semibold text-night">{children}</span>
    </div>
  )
}
