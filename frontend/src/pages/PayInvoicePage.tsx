/**
 * Public payment page — the link a merchant sends a customer.
 *
 * Deliberately outside AppLayout: no nav, no merchant chrome, and no wallet
 * requirement to *view*. A customer sees what they owe before being asked to
 * connect anything. It is status-aware — an OPEN invoice shows the pay flow, a
 * PAID one shows a receipt, an expired/cancelled one says so plainly.
 *
 * In production the data comes from get_public_invoice(uuid) as a
 * `PublicInvoiceView` (no anon SELECT on the invoices table, so the route can't
 * enumerate other merchants' invoices). Here it resolves against SAMPLE_INVOICES
 * so the whole flow is reviewable without a backend; the display fields used
 * below all exist on `PublicInvoiceView`, so the swap is a data-source change.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link, useParams } from 'react-router'
import type { FeedName, TokenSymbol } from '@/config/flare'
import type { PublicInvoiceView } from '@/lib/db'
import { useFtsoPrices, usdToTokenUnits } from '@/hooks/useFtsoPrices'
import { useWallet } from '@/hooks/useWallet'
import { usePublicClient, useWriteContract } from 'wagmi'
import {
  erc20Abi,
  fluxaInvoiceAbi,
  fluxaInvoiceV2Abi,
  fluxaSettlementAbi,
  fluxaSettlementV2Abi,
} from '@/lib/abi'
import { FLUXA_CONTRACTS, TOKENS } from '@/config/flare'
import { useWalletModal } from '@/components/wallet/WalletModalProvider'
import { WalletButton } from '@/components/wallet/WalletButton'
import { Wordmark } from '@/components/landing/Brand'
import { Button, Spinner } from '@/components/Button'
import { LoadingState } from '@/components/LoadingState'
import { statusLabel } from '@/components/invoice/StatusBadge'
import { Icons, type IconName } from '@/components/icons'
import { formatAmount, formatAge, formatPrice, formatUsd } from '@/lib/format'
import { paths } from '@/routes'
import { getPublicInvoicePage } from '@/lib/db'
import { hasSupabaseConfig, supabase } from '@/lib/supabase'

/** Both tokens and native XRP quote at 6 decimals in this app. */
const PAY_DECIMALS = 6
type PayPageInvoice = PublicInvoiceView

type PayMethod = {
  symbol: TokenSymbol
  feed: FeedName
  /** The FTSO pair's base asset, for the "$/XRP" rate line. */
  base: string
  title: string
  sub: string
  icon: IconName
}

export function PayInvoicePage() {
  const { invoiceId } = useParams<{ invoiceId: string }>()
  const configured = hasSupabaseConfig()
  const [invoice, setInvoice] = useState<PayPageInvoice | null>(null)
  const [loading, setLoading] = useState(hasSupabaseConfig())
  const [loadError, setLoadError] = useState<string | null>(configured ? null : 'Supabase is not configured.')

  useEffect(() => {
    if (!hasSupabaseConfig() || !invoiceId) return
    let active = true
    async function load(initial = false) {
      if (initial) setLoading(true)
      try {
        const page = await getPublicInvoicePage(supabase(), invoiceId!)
        if (!active) return
        setLoadError(null)
        setInvoice(page?.invoice ?? null)
      } catch (cause) {
        if (active) setLoadError(cause instanceof Error ? cause.message : 'Could not load this invoice.')
      } finally {
        if (active && initial) setLoading(false)
      }
    }
    void load(true)
    const timer = window.setInterval(() => void load(false), 15_000)
    return () => { active = false; window.clearInterval(timer) }
  }, [invoiceId])

  return (
    <div className="app-shell flex min-h-dvh flex-col text-night">
      <header className="sticky top-0 z-30 px-3 pt-3 sm:px-5 sm:pt-4">
        <div className="liquid-nav mx-auto flex max-w-2xl items-center justify-between gap-4 rounded-full px-4 py-2.5 sm:px-5">
          <Link
            to={paths.landing}
            className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-300"
          >
            <Wordmark tone="dark" markClassName="size-8" textClassName="text-lg" />
          </Link>
          <WalletButton surface="light" />
        </div>
      </header>

      <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-8 sm:px-6 sm:py-12">
        {loading
          ? <LoadingState label="Loading secure invoice" compact />
          : invoice
            ? <PayCard invoice={invoice} />
            : loadError
              ? <Unavailable />
              : <NotFound />}
      </main>

      <footer className="border-t border-brand-100/70 bg-white/55 backdrop-blur-xl">
        <div className="mx-auto flex max-w-2xl items-center justify-between gap-2 px-6 py-5 text-xs text-night/42">
          <span>Fluxa on Flare</span>
          <span className="inline-flex items-center gap-2">
            <span className="size-1.5 rounded-full bg-brand-500" />
            Coston2 testnet — no real funds move.
          </span>
        </div>
      </footer>
    </div>
  )
}

function PayCard({ invoice }: { invoice: PayPageInvoice }) {
  const payable = invoice.status === 'OPEN' || invoice.status === 'PENDING'
  const done = invoice.status === 'PAID' || invoice.status === 'SETTLED'

  return (
    <div className="rounded-[2.2rem] bg-gradient-to-br from-brand-600 via-[#76a9fb] to-iris-500 p-1.5 shadow-[0_30px_90px_rgba(36,82,224,.22)] sm:p-2">
    <div className="overflow-hidden rounded-[1.75rem] border border-white/90 bg-white/95 backdrop-blur-xl">
      {/* Header band */}
      <div className="relative overflow-hidden bg-gradient-to-br from-[#174fd8] via-[#3976ef] to-[#8ebafa] px-6 py-7 text-white">
        <span className="absolute -right-16 -top-20 size-56 rounded-full border-[2.5rem] border-white/10" />
        <div className="relative flex items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[.16em] text-white/60">Payment request</p>
          <p className="mt-2 font-display text-lg font-semibold">
            {invoice.merchantName?.trim() || 'Fluxa merchant'}
          </p>
        </div>
        <span className="rounded-full border border-white/25 bg-white/15 px-3 py-1.5 text-xs font-semibold backdrop-blur-xl">{statusLabel(invoice.status)}</span>
        </div>
      </div>

      <div className="px-6 py-6">
        {/* What & how much */}
        <h1 className="font-display text-xl font-bold text-night">{invoice.title}</h1>
        {invoice.description && <p className="mt-1.5 text-sm text-night/60">{invoice.description}</p>}

        <div className="mt-6 rounded-3xl border border-brand-100/80 bg-gradient-to-br from-[#eef4ff] via-white to-[#e7efff] p-6 shadow-[inset_0_1px_0_white]">
          <p className="text-xs uppercase tracking-wide text-night/40">Amount due</p>
          <p className="tabular mt-1 font-display text-5xl font-bold tracking-tight text-night">
            {formatUsd(invoice.usdAmountNumber)}
          </p>
          <p className="mt-1 text-sm text-night/45">Priced in USD · settled in crypto at the live rate</p>
        </div>

        {payable ? (
          <PayFlow invoice={invoice} />
        ) : done ? (
          <PaidReceipt invoice={invoice} />
        ) : (
          <ClosedNotice invoice={invoice} />
        )}
      </div>
    </div>
    </div>
  )
}

/** OPEN / PENDING → the customer picks a rail, sees the live quote, and pays. */
function PayFlow({ invoice }: { invoice: PayPageInvoice }) {
  const acceptedAssets = useMemo<TokenSymbol[]>(() => {
    if (invoice.contractVersion !== 2) {
      return [invoice.tokenSymbol === 'USDT0' ? 'USDT0' : 'FXRP']
    }
    return invoice.acceptedPaymentAssets.filter(
      (symbol): symbol is TokenSymbol => symbol === 'FXRP' || symbol === 'USDT0',
    )
  }, [invoice.acceptedPaymentAssets, invoice.contractVersion, invoice.tokenSymbol])
  const [selected, setSelected] = useState<TokenSymbol>(acceptedAssets[0] ?? 'FXRP')
  useEffect(() => {
    if (!acceptedAssets.includes(selected)) setSelected(acceptedAssets[0] ?? 'FXRP')
  }, [acceptedAssets, selected])

  const method = useMemo<PayMethod>(() => ({
    symbol: selected,
    feed: selected === 'USDT0' ? 'USDT/USD' : 'XRP/USD',
    base: selected === 'USDT0' ? 'USDT' : 'XRP',
    title: `Pay with ${selected}`,
    sub: 'ERC-20 on Coston2',
    icon: 'coins',
  }), [selected])

  const { prices, isLoading, isError } = useFtsoPrices()
  const price = prices[method.feed]
  const quoteClient = usePublicClient()
  const [contractUnits, setContractUnits] = useState<bigint | null>(null)
  const [quoteError, setQuoteError] = useState<string | null>(null)
  const [quoteLoading, setQuoteLoading] = useState(invoice.contractVersion === 2)
  const [reserveCapacity, setReserveCapacity] = useState<{
    required: bigint
    available: bigint
    sufficient: boolean
  } | null>(null)

  useEffect(() => {
    if (invoice.contractVersion !== 2) {
      setContractUnits(null)
      setQuoteError(null)
      setQuoteLoading(false)
      setReserveCapacity(null)
      return
    }
    if (!quoteClient || !invoice.onchainInvoiceId || !FLUXA_CONTRACTS.invoiceV2 || !FLUXA_CONTRACTS.settlementV2) {
      setQuoteError('This V2 invoice is not connected to the deployed contracts.')
      setQuoteLoading(false)
      return
    }

    let active = true
    setQuoteLoading(true)
    setQuoteError(null)
    const invoiceId = BigInt(invoice.onchainInvoiceId)
    const tokenAddress = TOKENS[selected].address
    Promise.all([
      quoteClient.readContract({
        address: FLUXA_CONTRACTS.invoiceV2,
        abi: fluxaInvoiceV2Abi,
        functionName: 'quotePaymentAmount',
        args: [invoiceId, tokenAddress],
      }),
      quoteClient.readContract({
        address: FLUXA_CONTRACTS.settlementV2,
        abi: fluxaSettlementV2Abi,
        functionName: 'capacityFor',
        args: [invoiceId, tokenAddress],
      }),
    ]).then(([quoted, capacity]) => {
      if (!active) return
      setContractUnits(quoted)
      setReserveCapacity({ required: capacity[0], available: capacity[1], sufficient: capacity[2] })
    }).catch((cause) => {
      if (!active) return
      setContractUnits(null)
      setReserveCapacity(null)
      setQuoteError(cause instanceof Error ? cause.message : 'The on-chain quote is unavailable.')
    }).finally(() => {
      if (active) setQuoteLoading(false)
    })
    return () => { active = false }
  }, [invoice.contractVersion, invoice.onchainInvoiceId, quoteClient, selected])

  const liveUnits = useMemo(() => {
    if (!price) return null
    try {
      return usdToTokenUnits(BigInt(Math.round(invoice.usdAmountNumber * 100)), price, PAY_DECIMALS)
    } catch {
      return null
    }
  }, [price, invoice.usdAmountNumber])

  const units = invoice.contractVersion === 2 ? contractUnits : invoice.tokenAmount ?? liveUnits
  const amountLabel = units !== null ? `${formatAmount(units, PAY_DECIMALS)} ${method.symbol}` : null

  return (
    <div className="mt-7">
      <p className="text-sm font-medium text-night">Payment asset</p>
      <div className="mt-2.5 grid gap-2 sm:grid-cols-2">
        {acceptedAssets.map((symbol) => {
          const active = symbol === selected
          return (
            <button
              key={symbol}
              type="button"
              aria-pressed={active}
              onClick={() => setSelected(symbol)}
              className={`flex items-start gap-3 rounded-2xl border p-4 text-left transition-all hover:-translate-y-0.5 ${
                active ? 'border-brand-300 bg-gradient-to-br from-brand-50 to-white shadow-[0_10px_26px_rgba(18,55,145,.08)]' : 'border-brand-100 bg-white/65 hover:border-brand-200 hover:bg-white'
              }`}
            >
              <span className={`grid size-9 shrink-0 place-items-center rounded-xl ${active ? 'bg-brand-600 text-white' : 'bg-night/[0.05] text-night/45'}`}>
                <Icons.coins className="size-5" />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-night">Pay with {symbol}</span>
                <span className="block text-xs text-night/55">ERC-20 on Coston2</span>
              </span>
            </button>
          )
        })}
      </div>
      <p className="mt-2 text-xs text-night/45">C2FLR is required separately for network gas.</p>

      {/* Live quote */}
      <div className="mt-4 rounded-2xl border border-brand-200/80 bg-gradient-to-br from-[#e9f1ff] via-[#f5f8ff] to-[#e2ecff] p-5 text-brand-950 shadow-[0_14px_38px_rgba(36,82,224,.10)]">
        <div className="flex items-center justify-between text-sm font-semibold text-brand-700">
          <span>You pay</span>
          <span className="inline-flex items-center gap-1.5">
            <Icons.network className="size-3.5" />
            FTSOv2 live rate
          </span>
        </div>
        <div className="mt-1.5 flex items-baseline gap-2">
          <span className="tabular font-display text-3xl font-bold text-brand-950">
            {(isLoading || quoteLoading) && !amountLabel ? (
              <span className="inline-flex items-center gap-2 text-2xl">
                <Spinner className="size-5" /> Fetching…
              </span>
            ) : (
              amountLabel ?? '—'
            )}
          </span>
        </div>
        <p className="mt-2 text-xs font-medium text-brand-700/75">
          {isError ? (
            'Live rate unavailable — try again in a moment.'
          ) : price ? (
            <>
              1 {method.base} = {formatPrice(price.price)} · updated {formatAge(price.ageSeconds)} ·
              {' '}locked at payment
            </>
          ) : (
            'Reading the on-chain oracle…'
          )}
        </p>
        {invoice.contractVersion === 2 && (
          <p className="mt-1 text-xs text-brand-100/75">Protected against quote increases above 1%.</p>
        )}
      </div>

      {quoteError && (
        <p className="app-error mt-3 px-3.5 py-3 text-xs font-medium">
          The exact contract quote is unavailable. Refresh before attempting payment.
        </p>
      )}
      {reserveCapacity && !reserveCapacity.sufficient && (
        <p className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-3 text-xs text-amber-800">
          {selected} payment is temporarily unavailable because the {invoice.settlementTokenSymbol} settlement reserve needs{' '}
          {formatAmount(reserveCapacity.required - reserveCapacity.available, PAY_DECIMALS)} more {invoice.settlementTokenSymbol}.
        </p>
      )}

      <PayButton
        amountLabel={amountLabel}
        invoiceId={invoice.onchainInvoiceId}
        merchantAddress={invoice.merchantAddress}
        token={method.symbol}
        tokenAmount={units}
        contractVersion={invoice.contractVersion}
        settlementToken={invoice.settlementTokenSymbol}
        reserveSufficient={reserveCapacity?.sufficient ?? invoice.contractVersion !== 2}
      />

      <p className="mt-4 flex items-center justify-center gap-1.5 text-center text-xs text-night/45">
        <Icons.shield className="size-3.5" />
        Non-custodial — funds move only when you sign. Coston2 testnet.
      </p>
    </div>
  )
}

/**
 * The pay action reflects the true wallet state, reusing the same connect modal
 * as the rest of the app. On testnet the signed settlement call lands with the
 * FluxaInvoice contract; here the connect flow is live and the signature step is
 * shown as the clearly-labelled next step rather than faked.
 */
function PayButton({
  amountLabel,
  invoiceId,
  merchantAddress,
  token,
  tokenAmount,
  contractVersion,
  settlementToken,
  reserveSufficient,
}: {
  amountLabel: string | null
  invoiceId?: string | null
  merchantAddress?: string | null
  token: TokenSymbol
  tokenAmount?: bigint | null
  contractVersion: number
  settlementToken: PayPageInvoice['settlementTokenSymbol']
  reserveSufficient: boolean
}) {
  const { address, isConnected, isWrongChain } = useWallet()
  const { open } = useWalletModal()
  const [phase, setPhase] = useState<'idle' | 'approving' | 'paying' | 'paid' | 'settling' | 'done'>('idle')
  const [error, setError] = useState<string | null>(null)
  const [txHash, setTxHash] = useState<`0x${string}` | null>(null)
  const { writeContractAsync } = useWriteContract()
  const publicClient = usePublicClient()

  const isV2 = contractVersion === 2
  const invoiceAddress = isV2 ? FLUXA_CONTRACTS.invoiceV2 : FLUXA_CONTRACTS.invoice
  const settlementAddress = isV2 ? FLUXA_CONTRACTS.settlementV2 : FLUXA_CONTRACTS.settlement
  const configured = Boolean(invoiceAddress && settlementAddress && invoiceId && tokenAmount)
  const tokenAddress = TOKENS[token].address
  const maximumAmount = tokenAmount ? tokenAmount + ((tokenAmount * 100n + 9_999n) / 10_000n) : null

  async function finishSettlement() {
    if (!settlementAddress || !invoiceId || !publicClient) {
      setPhase('paid')
      setError('Payment is confirmed, but the settlement contract is not configured. The invoice cannot be charged again.')
      return
    }
    try {
      setError(null)
      setPhase('settling')
      const settlementHash = isV2
        ? await writeContractAsync({
            address: settlementAddress,
            abi: fluxaSettlementV2Abi,
            functionName: 'settleInvoice',
            args: [BigInt(invoiceId)],
          })
        : await writeContractAsync({
            address: settlementAddress,
            abi: fluxaSettlementAbi,
            functionName: 'settleInvoice',
            args: [BigInt(invoiceId)],
          })
      setTxHash(settlementHash)
      const settlementReceipt = await publicClient.waitForTransactionReceipt({ hash: settlementHash })
      if (settlementReceipt.status !== 'success') throw new Error('Invoice settlement failed on-chain.')
      setPhase('done')
    } catch (cause) {
      setPhase('paid')
      setError(`Payment is confirmed and cannot be charged again. Settlement is still pending: ${cause instanceof Error ? cause.message : 'retry the settlement transaction.'}`)
    }
  }

  async function begin() {
    if (!configured || !invoiceAddress || !settlementAddress || !invoiceId || !tokenAmount || !maximumAmount || !publicClient || !address) {
      setError('This invoice is not connected to a deployed Fluxa contract yet.')
      return
    }
    if (!reserveSufficient) {
      setError(`${token} payment is temporarily unavailable because the ${settlementToken} settlement reserve is insufficient.`)
      return
    }
    if (address && merchantAddress && address.toLowerCase() === merchantAddress.toLowerCase()) {
      setError('The merchant wallet cannot pay its own invoice. Connect a different customer wallet.')
      return
    }
    try {
      setError(null)
      const payerBalance = await publicClient.readContract({
        address: tokenAddress,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [address as `0x${string}`],
      })
      if (payerBalance < tokenAmount) {
        throw new Error(`Insufficient ${token} balance. This invoice currently requires ${amountLabel ?? `${tokenAmount} ${token}`}; Coston2 gas tokens do not count as ${token}.`)
      }
      const allowance = await publicClient.readContract({
        address: tokenAddress,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [address, invoiceAddress],
      })
      if (allowance < maximumAmount) {
        setPhase('approving')
        const approvalHash = await writeContractAsync({
          address: tokenAddress,
          abi: erc20Abi,
          functionName: 'approve',
          args: [invoiceAddress, maximumAmount],
        })
        setTxHash(approvalHash)
        const approvalReceipt = await publicClient.waitForTransactionReceipt({ hash: approvalHash })
        if (approvalReceipt.status !== 'success') throw new Error('Token approval failed on-chain.')
      }

      // Run the exact payment call as a read-only simulation before asking the
      // wallet to sign it. This exposes custom contract errors immediately.
      try {
        if (isV2) {
          await publicClient.simulateContract({
            account: address,
            address: invoiceAddress,
            abi: fluxaInvoiceV2Abi,
            functionName: 'payInvoice',
            args: [BigInt(invoiceId), tokenAddress, maximumAmount],
          })
        } else {
          await publicClient.simulateContract({
            account: address,
            address: invoiceAddress,
            abi: fluxaInvoiceAbi,
            functionName: 'payInvoice',
            args: [BigInt(invoiceId)],
          })
        }
      } catch (simulationError) {
        const message = simulationError instanceof Error ? simulationError.message : String(simulationError)
        if (/MerchantIsPayer/i.test(message)) throw new Error('The merchant wallet cannot pay its own invoice.')
        if (/AlreadyPaid|0x3292084c/i.test(message)) throw new Error('This invoice has already been paid. Refresh the page to view its payment status.')
        if (/InsufficientReserve/i.test(message)) throw new Error(`The ${settlementToken} settlement reserve changed and can no longer support this payment. No customer funds moved.`)
        if (/QuoteExceeded/i.test(message)) throw new Error('The live FTSOv2 quote moved by more than 1%. Refresh to approve the new amount.')
        if (/UnsupportedPaymentToken/i.test(message)) throw new Error(`${token} is not accepted for this invoice.`)
        if (/IncorrectPaymentAmount|transferFrom|insufficient|balance/i.test(message)) throw new Error(`The payer wallet cannot transfer enough ${token} to this invoice. Check its token balance and allowance.`)
        throw new Error('Payment could not be prepared. Refresh the quote or try another accepted asset.')
      }

      setPhase('paying')
      const paymentHash = isV2
        ? await writeContractAsync({
            address: invoiceAddress,
            abi: fluxaInvoiceV2Abi,
            functionName: 'payInvoice',
            args: [BigInt(invoiceId), tokenAddress, maximumAmount],
          })
        : await writeContractAsync({
            address: invoiceAddress,
            abi: fluxaInvoiceAbi,
            functionName: 'payInvoice',
            args: [BigInt(invoiceId)],
          })
      setTxHash(paymentHash)
      const paymentReceipt = await publicClient.waitForTransactionReceipt({ hash: paymentHash })
      if (paymentReceipt.status !== 'success') throw new Error('Invoice payment failed on-chain.')
      setPhase('paid')
      await finishSettlement()
    } catch (cause) {
      setPhase('idle')
      setError(cause instanceof Error ? cause.message.split('\n')[0] : 'Payment could not be completed.')
    }
  }

  if (phase !== 'idle') {
    return (
      <div className="app-panel-soft mt-5 rounded-2xl p-4">
        <div className="flex items-center gap-3">
          {phase === 'done' || phase === 'paid'
            ? <Icons.check className={`size-5 ${phase === 'done' ? 'text-brand-600' : 'text-iris-500'}`} />
            : <Spinner className="size-5 text-brand-600" />}
          <div>
            <p className="text-sm font-semibold text-night">{phase === 'approving' ? 'Approve token access' : phase === 'paying' ? 'Payment submitted' : phase === 'paid' ? 'Payment confirmed' : phase === 'settling' ? 'Settlement in progress' : 'Payment settled'}</p>
            <p className="text-xs text-night/55">{phase === 'done' ? 'The merchant has received the settled funds.' : phase === 'paid' ? 'Customer funds are secured on-chain; only settlement remains.' : 'Confirm the transaction in your wallet. Fluxa will advance automatically.'}</p>
          </div>
        </div>
        {phase === 'paid' && (
          <Button type="button" variant="secondary" size="sm" className="mt-3" onClick={() => void finishSettlement()}>
            Retry settlement
          </Button>
        )}
        {error && <p className="app-error mt-3 px-3 py-2 text-xs font-medium">{error}</p>}
        {txHash && <a className="mt-3 block text-xs font-medium text-brand-700 hover:underline" href={`https://coston2-explorer.flare.network/tx/${txHash}`} target="_blank" rel="noreferrer">View transaction</a>}
      </div>
    )
  }

  if (!isConnected) {
    return (
      <Button variant="primary" size="lg" className="mt-5 w-full" onClick={open}>
        <Icons.wallet className="size-5" />
        Connect wallet to pay
      </Button>
    )
  }

  if (isWrongChain) {
    return (
      <Button variant="primary" size="lg" className="mt-5 w-full" onClick={open}>
        <Icons.globe className="size-5" />
        Switch to Coston2 to pay
      </Button>
    )
  }

  return (
    <>
    <Button variant="primary" size="lg" className="mt-5 w-full" onClick={begin} disabled={!reserveSufficient || !tokenAmount}>
      Pay {amountLabel ?? 'now'}
      <Icons.arrowRight className="size-5" />
    </Button>
    {error && <p className="app-error mt-3 px-3 py-2 text-center text-xs font-medium">{error}</p>}
    </>
  )
}

/** PAID / SETTLED → a receipt rather than a pay button. */
function PaidReceipt({ invoice }: { invoice: PayPageInvoice }) {
  const settled = invoice.status === 'SETTLED'
  const paidOn = invoice.paidAt
    ? new Date(invoice.paidAt).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })
    : null

  return (
    <div className="mt-7 overflow-hidden rounded-3xl border border-brand-100/70 bg-gradient-to-br from-white via-[#f8faff] to-brand-50/80 shadow-[0_20px_55px_rgba(36,82,224,.12)]">
      <div className="relative overflow-hidden bg-gradient-to-br from-[#1f5bed] via-[#3976ef] to-[#87b5fa] px-5 py-6 text-white">
        <span className="absolute -right-10 -top-12 size-36 rounded-full border-[1.8rem] border-white/10" />
        <div className="relative flex items-start justify-between gap-4">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/12 px-3 py-1.5 text-xs font-semibold backdrop-blur-xl">
              <Icons.check className="size-3.5" />
              {settled ? 'Settlement complete' : 'Payment confirmed'}
            </div>
            <p className="mt-5 text-xs font-medium uppercase text-white/60">Amount paid</p>
            <p className="tabular mt-1 font-display text-4xl font-semibold">{formatUsd(invoice.usdAmountNumber)}</p>
          </div>
          <span className="grid size-12 shrink-0 place-items-center rounded-2xl border border-white/25 bg-white/15 shadow-xl backdrop-blur-xl">
            <Icons.receipt className="size-6" />
          </span>
        </div>
        <p className="relative mt-5 max-w-sm text-sm leading-relaxed text-white/72">
          {settled
            ? `Funds were delivered to the merchant in ${invoice.settlementTokenSymbol}.`
            : 'The payment is confirmed on-chain and settlement is being completed.'}
        </p>
      </div>

      <dl className="space-y-3 px-5 py-5 text-sm">
        <Row label="Amount">
          <span className="tabular font-semibold text-night">{formatUsd(invoice.usdAmountNumber)}</span>
        </Row>
        <Row label="Settled in">
          <span className="font-medium text-night">{invoice.settlementTokenSymbol}</span>
        </Row>
        {paidOn && (
          <Row label="Paid on">
            <span className="tabular font-medium text-night">{paidOn}</span>
          </Row>
        )}
        <Row label="Status">
          <span className="inline-flex items-center gap-1.5 font-semibold text-brand-700"><i className="size-1.5 rounded-full bg-brand-500" />{statusLabel(invoice.status)}</span>
        </Row>
      </dl>
    </div>
  )
}

/** DRAFT / EXPIRED / CANCELLED → nothing to pay; say why. */
function ClosedNotice({ invoice }: { invoice: PayPageInvoice }) {
  const copy: Record<string, { icon: IconName; title: string; body: string }> = {
    DRAFT: {
      icon: 'clock',
      title: 'Not published yet',
      body: 'This invoice is still a draft. Ask the merchant to send it once it’s ready.',
    },
    EXPIRED: {
      icon: 'clock',
      title: 'This link has expired',
      body: 'The payment window for this invoice has closed. Ask the merchant to reissue it.',
    },
    CANCELLED: {
      icon: 'shield',
      title: 'This invoice was cancelled',
      body: 'The merchant withdrew this request, so there is nothing to pay.',
    },
  }
  const c = copy[invoice.status] ?? copy.EXPIRED
  const Icon = Icons[c.icon]

  return (
    <div className="mt-7 rounded-2xl border border-brand-100 bg-paper-soft/60 p-5 text-center">
      <div className="mx-auto grid size-12 place-items-center rounded-2xl bg-night/[0.05] text-night/45">
        <Icon className="size-6" />
      </div>
      <p className="mt-3 font-display font-semibold text-night">{c.title}</p>
      <p className="mx-auto mt-1 max-w-xs text-sm text-night/55">{c.body}</p>
    </div>
  )
}

function NotFound() {
  return (
    <div className="app-panel rounded-3xl px-6 py-16 text-center">
      <div className="mx-auto grid size-14 place-items-center rounded-2xl bg-brand-50 text-brand-600">
        <Icons.receipt className="size-7" />
      </div>
      <h1 className="mt-4 font-display text-xl font-bold text-night">Invoice not found</h1>
      <p className="mx-auto mt-1.5 max-w-sm text-sm text-night/55">
        This payment link is invalid or has been removed. Check the link, or ask the merchant to
        resend it.
      </p>
      <Link
        to={paths.landing}
        className="mt-6 inline-flex h-11 items-center justify-center gap-2 rounded-full bg-brand-600 px-5 text-sm font-semibold text-white shadow-sm shadow-brand-900/20 transition-colors hover:bg-brand-500"
      >
        Go to Fluxa
        <Icons.arrowRight className="size-4" />
      </Link>
    </div>
  )
}

function Unavailable() {
  return (
    <div className="app-panel rounded-3xl px-6 py-16 text-center">
      <div className="mx-auto grid size-14 place-items-center rounded-2xl bg-brand-50 text-brand-600">
        <Icons.network className="size-7" />
      </div>
      <h1 className="mt-4 font-display text-xl font-bold text-night">Invoice temporarily unavailable</h1>
      <p className="mx-auto mt-1.5 max-w-sm text-sm text-night/55">
        Fluxa could not reach the invoice service. Check your connection and refresh; this does not mean the link was removed.
      </p>
      <Button type="button" variant="primary" size="md" className="mt-6" onClick={() => window.location.reload()}>
        Try again
      </Button>
    </div>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-night/55">{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}
