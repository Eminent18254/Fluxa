import { type ReactNode } from 'react'
import { useNavigate } from 'react-router'
import { useWallet } from '@/hooks/useWallet'
import { COSTON2, explorerAddress } from '@/config/flare'
import { formatAmount, shortenAddress } from '@/lib/format'
import { paths } from '@/routes'
import { Modal } from '@/components/Modal'
import { Button, Spinner } from '@/components/Button'
import { LogoMark } from '@/components/landing/Brand'
import { Icons } from '@/components/icons'
import { hasWalletSession, signInWithWallet } from '@/lib/walletAuth'
import { useEffect, useState } from 'react'
import { X } from 'lucide-react'

type Step = 'no-wallet' | 'connect' | 'wrong-network' | 'connected'

/**
 * The wallet flow, as a single modal that always reflects the true state of the
 * connection rather than a wizard the user clicks through. The step is derived,
 * not stored: install a wallet → connect it → land on Coston2 → you're in. The
 * wrong-network state is deliberately loud, because a silent wrong chain is the
 * most common reason a demo "does nothing".
 */
export function WalletModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [authenticating, setAuthenticating] = useState(false)
  const [authError, setAuthError] = useState<string | null>(null)
  const [authenticated, setAuthenticated] = useState(false)
  const [checkingAuth, setCheckingAuth] = useState(false)
  const navigate = useNavigate()
  const {
    address,
    isConnected,
    isConnecting,
    isWrongChain,
    isSwitching,
    hasWallet,
    nativeBalance,
    connect,
    disconnect,
    switchToCoston2,
    error,
  } = useWallet()

  const step: Step = !hasWallet
    ? 'no-wallet'
    : !isConnected
      ? 'connect'
      : isWrongChain
        ? 'wrong-network'
        : 'connected'

  const errorLine = error ? error.message.split('\n')[0] : null

  useEffect(() => {
    if (!open || !address || !isConnected || isWrongChain) {
      setAuthenticated(false)
      return
    }
    let active = true
    setCheckingAuth(true)
    hasWalletSession(address)
      .then((value) => { if (active) setAuthenticated(value) })
      .catch(() => { if (active) setAuthenticated(false) })
      .finally(() => { if (active) setCheckingAuth(false) })
    return () => { active = false }
  }, [open, address, isConnected, isWrongChain])

  function enterApp() {
    onClose()
    navigate(paths.invoices)
  }

  async function authenticate() {
    if (!address) return
    try { setAuthenticating(true); setAuthError(null); await signInWithWallet(address); setAuthenticated(true); enterApp() }
    catch { setAuthError('Wallet sign-in could not be completed. Try again.') }
    finally { setAuthenticating(false) }
  }

  return (
    <Modal open={open} onClose={onClose} labelledBy="wallet-modal-title">
      <div className="overflow-hidden rounded-t-[2rem] border border-white/80 bg-white/95 text-night shadow-[0_30px_90px_rgba(31,91,237,.2)] ring-1 ring-brand-100/70 backdrop-blur-xl sm:rounded-[2rem]">
        {/* Header */}
        <div className="flex items-center justify-between bg-gradient-to-br from-[#174fd8] via-[#3976ef] to-[#91bdfb] px-6 py-6 text-white">
          <div className="flex items-center gap-3">
            <span className="grid size-10 place-items-center rounded-2xl border border-white/25 bg-white/15 shadow-lg backdrop-blur-xl"><LogoMark className="size-7" /></span>
            <h2 id="wallet-modal-title" className="font-display text-lg font-semibold">
              {step === 'connected' ? 'Wallet connected' : 'Connect wallet'}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="app-icon-button size-9"
          >
            <X className="size-4.5" />
          </button>
        </div>

        {/* Body */}
        <div className="px-6 pb-7 pt-6">
          {step === 'no-wallet' && (
            <div className="text-center">
              <div className="mx-auto grid size-14 place-items-center rounded-2xl bg-brand-50 text-brand-600">
                <Icons.wallet className="size-7" />
              </div>
              <p className="mt-4 font-display text-base font-semibold">No wallet detected</p>
              <p className="mt-1.5 text-sm text-night/60">
                Fluxa connects through your browser wallet. Install MetaMask (or another
                injected wallet), then reload this page to continue.
              </p>
              <a href="https://metamask.io/download" target="_blank" rel="noreferrer" className="mt-5 block">
                <Button variant="primary" size="lg" className="w-full">
                  Get MetaMask
                  <Icons.arrowRight className="size-4" />
                </Button>
              </a>
            </div>
          )}

          {step === 'connect' && (
            <div>
              <button
                type="button"
                onClick={connect}
                disabled={isConnecting}
              className="group flex w-full items-center gap-3 rounded-2xl border border-brand-100 bg-gradient-to-br from-[#f0f5ff] via-white to-[#e7efff] p-4 text-left shadow-[0_12px_35px_rgba(36,82,224,.08)] transition-all hover:-translate-y-0.5 hover:border-brand-300 disabled:cursor-wait"
              >
                <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-brand-600 to-iris-500 text-white shadow-lg shadow-brand-600/20">
                  <Icons.wallet className="size-6" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block font-semibold">Browser wallet</span>
                  <span className="block text-sm text-night/55">MetaMask & injected wallets</span>
                </span>
                {isConnecting ? (
                  <Spinner className="size-5 text-brand-600" />
                ) : (
                  <Icons.arrowRight className="size-5 text-brand-400" />
                )}
              </button>
              <p className="mt-4 text-center text-xs text-night/50">
                You'll be asked to approve the connection in your wallet. Fluxa never moves
                funds without a transaction you sign.
              </p>
            </div>
          )}

          {step === 'wrong-network' && (
            <div>
              <div className="flex gap-3 rounded-2xl border border-warn-500/30 bg-warn-500/10 p-4">
                <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-warn-500/20 text-warn-500">
                  <Icons.globe className="size-6" />
                </span>
                <div>
                  <p className="font-semibold text-night">Wrong network</p>
                  <p className="mt-0.5 text-sm text-night/65">
                    Fluxa runs on <span className="font-medium">{COSTON2.name}</span>. Switch
                    networks to keep going — everything is testnet, no real funds move.
                  </p>
                </div>
              </div>
              <Button
                variant="primary"
                size="lg"
                onClick={switchToCoston2}
                disabled={isSwitching}
                className="mt-5 w-full"
              >
                {isSwitching ? (
                  <>
                    <Spinner className="size-4" /> Switching…
                  </>
                ) : (
                  <>Switch to Coston2</>
                )}
              </Button>
              <p className="mt-3 text-center text-xs text-night/50">
                Your wallet will prompt you to add or switch to the Coston2 test network.
              </p>
            </div>
          )}

          {step === 'connected' && (
            <div>
              <div className="rounded-2xl bg-gradient-to-br from-brand-600 via-[#3976ef] to-[#74a9fa] p-5 text-white shadow-[0_18px_45px_rgba(36,82,224,.2)]">
                <DetailRow label="Wallet">
                  {address ? (
                    <a
                      href={explorerAddress(address)}
                      target="_blank"
                      rel="noreferrer"
                      className="tabular inline-flex items-center gap-1 font-medium text-white hover:underline"
                    >
                      {shortenAddress(address)}
                      <Icons.arrowRight className="size-3.5 -rotate-45" />
                    </a>
                  ) : (
                    '—'
                  )}
                </DetailRow>
                <DetailRow label="Network">
                  <span className="inline-flex items-center gap-1.5 font-medium text-white">
                    <span className="size-2 rounded-full bg-white" />
                    Coston2
                  </span>
                </DetailRow>
                {nativeBalance && (
                  <DetailRow label="Balance">
                    <span className="tabular font-medium">
                      {formatAmount(nativeBalance.value, nativeBalance.decimals)}{' '}
                      {nativeBalance.symbol}
                    </span>
                  </DetailRow>
                )}
              </div>

              {nativeBalance?.value === 0n && (
                <a
                  href={COSTON2.faucet}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-3 flex items-center gap-2 rounded-xl bg-brand-600/5 px-3 py-2.5 text-xs text-brand-700 ring-1 ring-inset ring-brand-100 hover:bg-brand-600/10"
                >
                  <Icons.spark className="size-4 shrink-0" />
                  Need testnet funds? Get free C2FLR from the Flare faucet.
                </a>
              )}

              <div className="mt-5 flex gap-3">
                <Button variant="primary" size="lg" onClick={authenticated ? enterApp : authenticate} disabled={authenticating || checkingAuth} className="flex-1">
                  {checkingAuth ? <><Spinner className="size-4" /> Preparing…</> : authenticating ? <><Spinner className="size-4" /> Verify in wallet…</> : authenticated ? <>Open app</> : <>Verify wallet</>}
                  <Icons.arrowRight className="size-4" />
                </Button>
                <Button variant="secondary" size="lg" onClick={() => disconnect()}>
                  Disconnect
                </Button>
              </div>
              {authError && <p className="app-error mt-3 px-3 py-2 text-center text-xs font-medium">{authError}</p>}
            </div>
          )}

          {errorLine && step !== 'connected' && (
            <p className="app-error mt-4 px-3 py-2 text-center text-xs font-medium">
              Wallet request was not completed. Try again.
            </p>
          )}
        </div>
      </div>
    </Modal>
  )
}

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between py-1.5 text-sm">
      <span className="font-semibold tracking-[-.01em] text-white/75">{label}</span>
      {children}
    </div>
  )
}
