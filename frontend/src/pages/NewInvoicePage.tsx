import { ChevronLeft, Coins, Eye, ReceiptText } from 'lucide-react'
import { useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router'
import { TOKENS, TOKEN_SYMBOLS, type TokenSymbol } from '@/config/flare'
import { useFtsoPrices, usdToTokenUnits } from '@/hooks/useFtsoPrices'
import { formatAmount, formatAge, formatUsd } from '@/lib/format'
import type { CreateInvoiceInput } from '@/lib/db'
import { Button, Spinner } from '@/components/Button'
import { Modal } from '@/components/Modal'
import { Icons } from '@/components/icons'
import { paths } from '@/routes'
import { createInvoiceDraft, prepareInvoiceV2, getCurrentMerchant } from '@/lib/db'
import { hasSupabaseConfig, supabase } from '@/lib/supabase'
import { useWallet } from '@/hooks/useWallet'
import { useWalletModal } from '@/components/wallet/WalletModalProvider'
import { usePublicClient, useWriteContract } from 'wagmi'
import { fluxaInvoiceV2Abi } from '@/lib/abi'
import { FLUXA_CONTRACTS } from '@/config/flare'
import { publishConfirmedInvoice } from '@/lib/publishInvoice'
import { parseUnits } from 'viem'

/**
 * Create-invoice form, in the blue design system.
 *
 * The form is bound to a live receipt preview on the right: as the merchant types
 * an amount and picks a settlement asset, the preview shows the customer's-eye
 * view and the FTSOv2 quote the invoice would price against — the same oracle the
 * pay page reads, so what the merchant sees here is what the customer will pay.
 *
 * Submission is a local draft in this design build: it assembles a real
 * `CreateInvoiceInput` and shows the shareable link. Wiring `createInvoiceDraft`
 * is then a single call in `handleSubmit`.
 */
const inputBase =
  'app-input px-3.5 py-2.5 placeholder:text-night/30'

const HEX_ADDRESS = /^0x[a-fA-F0-9]{40}$/

function defaultDueDate(): string {
  const d = new Date()
  d.setDate(d.getDate() + 14)
  return d.toISOString().slice(0, 10)
}

type Draft = CreateInvoiceInput & {
  id: string
  acceptedPaymentAssets: TokenSymbol[]
  settlementTokenSymbol: TokenSymbol
}

function dueAtFor(value: string): Date {
  return new Date(`${value}T23:59:59.000`)
}

export function NewInvoicePage() {
  const navigate = useNavigate()
  const [title, setTitle] = useState('')
  const [amount, setAmount] = useState('')
  const [customer, setCustomer] = useState('')
  const [description, setDescription] = useState('')
  const [acceptedTokens, setAcceptedTokens] = useState<TokenSymbol[]>([...TOKEN_SYMBOLS])
  const [settlementToken, setSettlementToken] = useState<TokenSymbol>('USDT0')
  const [dueDate, setDueDate] = useState(defaultDueDate)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [created, setCreated] = useState<Draft | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [previewOpen, setPreviewOpen] = useState(false)
  const { isConnected, isWrongChain } = useWallet()
  const { open: openWallet } = useWalletModal()
  const publicClient = usePublicClient()
  const { writeContractAsync } = useWriteContract()
  const usd = Number.parseFloat(amount)
  const usdUnits = useMemo(() => {
    try {
      const units = parseUnits(amount.trim(), 6)
      return units > 0n ? units : null
    } catch {
      return null
    }
  }, [amount])
  const usdValid = Number.isFinite(usd) && usdUnits !== null

  function toggleAcceptedToken(symbol: TokenSymbol) {
    setAcceptedTokens((current) => current.includes(symbol)
      ? current.filter((candidate) => candidate !== symbol)
      : TOKEN_SYMBOLS.filter((candidate) => current.includes(candidate) || candidate === symbol))
  }

  function validate(): Record<string, string> {
    const next: Record<string, string> = {}
    if (!title.trim()) next.title = 'Give the invoice a title.'
    if (!amount.trim()) next.amount = 'Enter an amount.'
    else if (!usdValid) next.amount = 'Enter a positive invoice value with no more than 6 decimals.'
    if (acceptedTokens.length === 0) next.assets = 'Select at least one payment asset.'
    if (dueAtFor(dueDate).getTime() <= Date.now()) next.due = 'Choose a future due date.'
    if (customer.trim() && !HEX_ADDRESS.test(customer.trim()))
      next.customer = 'That doesn’t look like a 0x wallet address.'
    return next
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    const found = validate()
    setErrors(found)
    if (Object.keys(found).length > 0) return

    // The exact shape createInvoiceDraft(db, …) takes. Swapping to the live call
    // is: `await createInvoiceDraft(db, draft)` then navigate to the returned id.
    if (!isConnected || isWrongChain) { openWallet(); return }
    if (!hasSupabaseConfig()) { setSubmitError('Supabase is not configured. Add the authenticated merchant database before publishing.'); return }
    if (!FLUXA_CONTRACTS.invoiceV2 || !FLUXA_CONTRACTS.settlementV2) {
      setSubmitError('Fluxa V2 is not configured. Set the V2 invoice and settlement addresses.')
      return
    }
    if (usdUnits === null) return
    try {
      setIsSubmitting(true); setSubmitError(null)
      const client = supabase(); const merchant = await getCurrentMerchant(client)
      if (!merchant) throw new Error('No authenticated merchant profile exists for this wallet.')
      const dueAt = dueAtFor(dueDate)
      const invoice = await createInvoiceDraft(client, {
        merchantId: merchant.id,
        title: title.trim(),
        usdAmount: amount.trim(),
        tokenSymbol: settlementToken,
        acceptedPaymentAssets: acceptedTokens,
        settlementTokenSymbol: settlementToken,
        dueAt,
        customerAddress: customer.trim() || null,
        description: description.trim() || null,
      })
      const reference = await prepareInvoiceV2(client, invoice.id)
      const hash = await writeContractAsync({
        address: FLUXA_CONTRACTS.invoiceV2 as `0x${string}`,
        abi: fluxaInvoiceV2Abi,
        functionName: 'createInvoice',
        args: [
          acceptedTokens.map((symbol) => TOKENS[symbol].address),
          TOKENS[settlementToken].address,
          usdUnits,
          BigInt(Math.floor(dueAt.getTime() / 1000)),
          reference as `0x${string}`,
        ],
      })
      if (!publicClient) throw new Error('Coston2 client unavailable.')
      const receipt = await publicClient.waitForTransactionReceipt({ hash })
      if (receipt.status !== 'success') throw new Error('Invoice creation failed on-chain.')
      await publishConfirmedInvoice(invoice.id, hash)
      setCreated({
        id: invoice.id,
        merchantId: merchant.id,
        title: title.trim(),
        usdAmount: amount.trim(),
        tokenSymbol: settlementToken,
        acceptedPaymentAssets: [...acceptedTokens],
        settlementTokenSymbol: settlementToken,
        dueAt,
        customerAddress: customer.trim() || null,
        description: description.trim() || null,
      })
    } catch (error) { setSubmitError(error instanceof Error ? error.message : 'Invoice publishing failed.') }
    finally { setIsSubmitting(false) }
  }

  if (created) {
    return <CreatedView draft={created} onReset={() => resetTo(
      setCreated, setTitle, setAmount, setCustomer, setDescription, setAcceptedTokens, setSettlementToken,
    )} />
  }

  return (
    <div className="mx-auto max-w-5xl">
      <section className="grain-overlay relative overflow-hidden rounded-[2rem] bg-gradient-to-br from-[#174fd8] via-[#4f89f2] to-[#a9cafa] p-2 text-white shadow-[0_28px_80px_rgba(31,91,237,.24)] sm:p-3">
        <div className="pointer-events-none absolute -right-24 -top-24 size-80 rounded-full border-[3.5rem] border-white/10" />
        <div className="pointer-events-none absolute bottom-24 left-10 h-24 w-80 rounded-full bg-white/15 blur-3xl" />
      <div className="relative px-3 py-5 sm:px-6 sm:py-6">
        <div className="relative z-10 flex items-center gap-4">
        <button
          type="button"
          onClick={() => navigate(paths.invoices)}
          className="grid size-10 place-items-center rounded-full border border-white/25 bg-white/12 text-white backdrop-blur-xl transition-colors hover:bg-white/20"
          aria-label="Back to invoices"
        >
          <ChevronLeft className="size-5" />
        </button>
        <div>
          <h1 className="font-display text-3xl font-semibold text-white">Create invoice</h1>
          <p className="mt-1 text-sm text-white/70">Set the terms once. Your customer gets a clear live checkout.</p>
        </div>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="relative mx-auto max-w-none">
        {/* Fields */}
        <div className="space-y-6 rounded-[1.55rem] border border-white/90 bg-white/95 p-5 text-night shadow-[0_24px_60px_rgba(15,51,139,.18)] backdrop-blur-xl sm:p-8 lg:px-10">
          <div className="flex items-center gap-3 border-b border-brand-100/70 pb-5">
            <span className="grid size-9 place-items-center rounded-xl bg-brand-50 text-brand-600"><ReceiptText className="size-4" /></span>
            <div><h2 className="font-display text-base font-semibold text-night">Invoice details</h2><p className="text-xs text-night/45">The essentials your customer will see.</p></div>
          </div>
          <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Title" htmlFor="title" error={errors.title}>
            <input
              id="title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Design retainer — August"
              className={inputBase}
            />
          </Field>

          <Field label="Invoice value" htmlFor="amount" hint="USD pricing only" error={errors.amount}>
            <div className="relative">
              <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-night/40">$</span>
              <input
                id="amount"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                inputMode="decimal"
                placeholder="0.00"
                className={`${inputBase} tabular pl-7`}
              />
            </div>
          </Field>
          </div>

          <Field label="Accepted payment assets" htmlFor="accepted-assets" hint="customer chooses" error={errors.assets}>
            <div id="accepted-assets" className="grid gap-2 sm:grid-cols-2">
              {TOKEN_SYMBOLS.map((sym) => {
                const active = acceptedTokens.includes(sym)
                return (
                  <button
                    key={sym}
                    type="button"
                    aria-pressed={active}
                    onClick={() => toggleAcceptedToken(sym)}
                    className={`flex min-h-20 items-center gap-3 rounded-2xl border px-4 text-left transition-all hover:-translate-y-0.5 ${
                      active
                        ? 'border-brand-300 bg-gradient-to-br from-brand-50 to-white text-night shadow-[0_10px_26px_rgba(18,55,145,.08)]'
                        : 'border-brand-100 bg-white/60 text-night/55 hover:border-brand-200 hover:bg-white'
                    }`}
                  >
                    <span className={`grid size-8 shrink-0 place-items-center rounded-lg ${active ? 'bg-brand-600 text-white' : 'bg-night/[0.05] text-night/40'}`}>
                      {active ? <Icons.check className="size-4" /> : <Coins className="size-4" />}
                    </span>
                    <span>
                      <span className="block text-sm font-semibold">{TOKENS[sym].label}</span>
                      <span className="block text-xs opacity-60">ERC-20 on Coston2</span>
                    </span>
                  </button>
                )
              })}
            </div>
            <p className="mt-2 text-xs text-night/45">C2FLR remains gas-only and is never used as an invoice payment asset.</p>
          </Field>

          <Field label="Settlement asset" htmlFor="settlement-token" hint="what you receive">
            <div className="grid grid-cols-2 gap-2 rounded-2xl border border-brand-100 bg-brand-50/70 p-1.5">
              {TOKEN_SYMBOLS.map((sym) => {
                const active = sym === settlementToken
                return (
                  <button
                    key={sym}
                    id={sym === TOKEN_SYMBOLS[0] ? 'settlement-token' : undefined}
                    type="button"
                    onClick={() => setSettlementToken(sym)}
                    className={`rounded-xl px-3 py-2.5 text-sm font-semibold transition-all ${
                      active
                        ? 'bg-paper text-brand-700 shadow-sm ring-1 ring-brand-100'
                        : 'text-night/55 hover:text-night'
                    }`}
                  >
                    {TOKENS[sym].label}
                  </button>
                )
              })}
            </div>
          </Field>

          <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Customer wallet" htmlFor="customer" hint="optional" error={errors.customer}>
            <input
              id="customer"
              value={customer}
              onChange={(e) => setCustomer(e.target.value)}
              placeholder="0x…"
              className={`${inputBase} tabular`}
            />
          </Field>

          <Field label="Due date" htmlFor="due" error={errors.due}>
            <input
              id="due"
              type="date"
              value={dueDate}
              min={new Date().toISOString().slice(0, 10)}
              onChange={(e) => setDueDate(e.target.value)}
              className={`${inputBase} tabular`}
            />
          </Field>
          </div>

          <Field label="Description" htmlFor="description" hint="optional">
            <textarea
              id="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              placeholder="A note your customer will see on the payment page."
              className={`${inputBase} resize-none`}
            />
          </Field>

          <div className="flex flex-col-reverse gap-3 border-t border-brand-100/70 pt-6 sm:flex-row sm:items-center">
            <Button type="submit" variant="primary" size="lg" disabled={isSubmitting}>
              {isSubmitting ? <Spinner className="size-4" /> : <Icons.spark className="size-4" />}
              {isSubmitting ? 'Publishing invoice…' : 'Create invoice'}
            </Button>
            <Button type="button" variant="secondary" size="lg" onClick={() => setPreviewOpen(true)}>
              <Eye className="size-4" /> Preview invoice
            </Button>
            <Link
              to={paths.invoices}
              className="text-sm font-medium text-night/55 transition-colors hover:text-night"
            >
              Cancel
            </Link>
          </div>
          {submitError && <p className="app-error px-3.5 py-3 text-sm font-medium">Invoice could not be published. Check your wallet and try again.</p>}
        </div>

      </form>
      </section>
      <Modal open={previewOpen} onClose={() => setPreviewOpen(false)} labelledBy="invoice-preview-title">
        <div className="app-panel max-h-[92dvh] overflow-y-auto rounded-t-3xl p-2 sm:rounded-3xl">
          <div className="flex items-center justify-between px-4 py-3">
            <div><p className="text-xs font-semibold uppercase tracking-[.14em] text-brand-600">Customer view</p><h2 id="invoice-preview-title" className="mt-1 text-lg font-semibold text-night">Invoice preview</h2></div>
            <button type="button" onClick={() => setPreviewOpen(false)} className="app-icon-button" aria-label="Close preview"><ChevronLeft className="size-5 -rotate-90" /></button>
          </div>
          <PreviewCard title={title} usd={usdValid ? usd : null} acceptedTokens={acceptedTokens} settlementToken={settlementToken} dueDate={dueDate} description={description} />
        </div>
      </Modal>
    </div>
  )
}

/** Reset the form back to an empty state after "Create another". */
function resetTo(
  setCreated: (v: null) => void,
  setTitle: (v: string) => void,
  setAmount: (v: string) => void,
  setCustomer: (v: string) => void,
  setDescription: (v: string) => void,
  setAcceptedTokens: (v: TokenSymbol[]) => void,
  setSettlementToken: (v: TokenSymbol) => void,
) {
  setCreated(null)
  setTitle('')
  setAmount('')
  setCustomer('')
  setDescription('')
  setAcceptedTokens([...TOKEN_SYMBOLS])
  setSettlementToken('USDT0')
}

function Field({
  label,
  htmlFor,
  hint,
  error,
  children,
}: {
  label: string
  htmlFor: string
  hint?: string
  error?: string
  children: ReactNode
}) {
  return (
    <div>
      <label htmlFor={htmlFor} className="block text-sm font-semibold text-night/80">
        {label}
        {hint && <span className="ml-1.5 font-normal text-night/40">{hint}</span>}
      </label>
      <div className="mt-1.5">{children}</div>
      {error && <p className="mt-1.5 text-xs font-medium text-danger-500">{error}</p>}
    </div>
  )
}

/**
 * The customer's-eye receipt, bound to the form and the live oracle. This is the
 * same quote maths the pay page runs (`usdToTokenUnits` against the FTSOv2 feed
 * for the chosen asset), so the number the merchant sees while creating is the
 * number the customer will be asked to pay.
 */
function PreviewCard({
  title,
  usd,
  acceptedTokens,
  settlementToken,
  dueDate,
  description,
}: {
  title: string
  usd: number | null
  acceptedTokens: TokenSymbol[]
  settlementToken: TokenSymbol
  dueDate: string
  description: string
}) {
  const { prices, isLoading, isError } = useFtsoPrices()
  const quotes = useMemo(() => acceptedTokens.map((symbol) => {
    const price = prices[TOKENS[symbol].feed]
    let units: bigint | null = null
    if (usd !== null && price) {
      try {
        units = usdToTokenUnits(BigInt(Math.round(usd * 100)), price, TOKENS[symbol].decimals)
      } catch {
        units = null
      }
    }
    return { symbol, price, units }
  }), [acceptedTokens, prices, usd])

  const due = new Date(dueDate)
  const dueLabel = Number.isNaN(due.getTime())
    ? '—'
    : due.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

  return (
    <div className="app-panel overflow-hidden rounded-3xl">
      <div className="flex items-center justify-between border-b border-brand-100/70 bg-gradient-to-r from-brand-50/90 to-white px-5 py-4">
        <span className="text-xs font-semibold uppercase tracking-wide text-night/40">Preview</span>
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-night/45">
          <span className="size-1.5 rounded-full bg-brand-500" />
          What your customer sees
        </span>
      </div>

      <div className="px-5 py-5">
        <p className="text-sm text-night/50">Invoice from Fluxa merchant</p>
        <p className="mt-1 font-display text-lg font-semibold text-night">
          {title.trim() || <span className="text-night/30">Untitled invoice</span>}
        </p>
        {description.trim() && <p className="mt-1 text-sm text-night/55">{description.trim()}</p>}

        <div className="mt-5">
          <p className="text-xs uppercase tracking-wide text-night/40">Amount due</p>
          <p className="tabular mt-1 font-display text-4xl font-bold text-night">
            {usd === null ? '$0.00' : formatUsd(usd)}
          </p>
        </div>

        {/* Live quote */}
        <div className="mt-5 rounded-2xl border border-brand-100 bg-gradient-to-br from-brand-50 to-white p-4">
          <div className="flex items-center justify-between">
            <span className="text-sm text-night/55">Settles to</span>
            <span className="font-semibold text-night">{TOKENS[settlementToken].label}</span>
          </div>
          <div className="mt-3 space-y-2 border-t border-brand-100 pt-3">
            {acceptedTokens.length === 0 ? (
              <p className="text-sm text-night/45">Select at least one payment asset.</p>
            ) : quotes.map(({ symbol, price, units }) => (
              <div key={symbol} className="flex items-center justify-between gap-3">
                <span className="text-sm text-night/55">Pay with {symbol}</span>
                <span className="tabular text-right font-display font-bold text-brand-700">
                  {isLoading && !price ? (
                    <Spinner className="size-4 text-brand-400" />
                  ) : units !== null ? (
                    `${formatAmount(units, TOKENS[symbol].decimals)} ${symbol}`
                  ) : '—'}
                </span>
              </div>
            ))}
          </div>
          <p className="mt-3 flex items-center gap-1.5 text-xs text-night/45">
            <Icons.network className="size-3.5 text-brand-400" />
            {isError
              ? 'Oracle rate unavailable'
              : quotes.some(({ price }) => price)
                ? `FTSOv2 live quotes · updated ${formatAge(quotes.find(({ price }) => price)!.price!.ageSeconds)}`
                : 'Fetching live rates…'}
          </p>
        </div>

        <div className="mt-4 flex items-center justify-between text-sm">
          <span className="text-night/50">Due</span>
          <span className="tabular font-medium text-night">{dueLabel}</span>
        </div>

        <div className="mt-5 w-full rounded-full bg-gradient-to-b from-brand-500 to-brand-700 py-3 text-center text-sm font-semibold text-white shadow-lg shadow-brand-600/20">
          Pay invoice
        </div>
      </div>
    </div>
  )
}

/** Post-submit confirmation: the draft is created and its share link is ready. */
function CreatedView({ draft, onReset }: { draft: Draft; onReset: () => void }) {
  const [copied, setCopied] = useState(false)
  const shareUrl = `${window.location.origin}${paths.pay(draft.id)}`

  async function copy() {
    try {
      await navigator.clipboard.writeText(shareUrl)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="mx-auto max-w-xl py-8">
      <div className="app-panel rounded-3xl p-8 text-center sm:p-10">
        <div className="mx-auto grid size-14 place-items-center rounded-2xl bg-brand-50 text-brand-600 ring-1 ring-brand-100">
          <Icons.check className="size-7" />
        </div>
        <h1 className="mt-4 font-display text-2xl font-bold text-night">Invoice published</h1>
        <p className="mx-auto mt-1.5 max-w-sm text-sm text-night/55">
          <span className="font-medium text-night">{draft.title}</span> ·{' '}
          {formatUsd(Number(draft.usdAmount))} · accepts {draft.acceptedPaymentAssets.join(' or ')}
          {' '}and settles to {draft.settlementTokenSymbol}. Share this link to collect payment.
        </p>

        <div className="mt-6 flex items-center gap-2 rounded-xl border border-brand-100 bg-paper-soft/60 p-1.5 pl-4">
          <span className="tabular min-w-0 flex-1 truncate text-left text-sm text-night/70">
            {shareUrl}
          </span>
          <Button type="button" variant="primary" size="sm" onClick={copy}>
            {copied ? (
              <>
                <Icons.check className="size-4" /> Copied
              </>
            ) : (
              <>
                <Icons.link className="size-4" /> Copy
              </>
            )}
          </Button>
        </div>

        <div className="mt-6 flex items-center justify-center gap-3">
          <Link to={paths.pay(draft.id)} className="inline-flex h-11 items-center justify-center gap-2 rounded-full bg-brand-600 px-5 text-sm font-semibold text-white shadow-sm shadow-brand-900/20 transition-colors hover:bg-brand-500">
            Preview pay page
            <Icons.arrowRight className="size-4" />
          </Link>
          <button
            type="button"
            onClick={onReset}
            className="inline-flex h-11 items-center justify-center rounded-full px-5 text-sm font-semibold text-brand-700 ring-1 ring-inset ring-brand-200 transition-colors hover:bg-brand-50"
          >
            Create another
          </button>
        </div>

        <Link
          to={paths.invoices}
          className="mt-4 inline-block text-sm font-medium text-night/50 transition-colors hover:text-night"
        >
          Back to invoices
        </Link>
      </div>
    </div>
  )
}
