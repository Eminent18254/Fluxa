import { useWallet } from '@/hooks/useWallet'
import { shortenAddress } from '@/lib/format'
import { Icons } from '@/components/icons'
import { Spinner } from '@/components/Button'
import { useWalletModal } from './WalletModalProvider'

/**
 * The nav's wallet control. It reflects connection status at a glance and opens
 * the modal for the actual work, so one button covers connect, switch-network,
 * and account — the state lives in wagmi, not here.
 *
 * `surface` tunes it to its background: `dark` for the landing page's blue nav,
 * `light` for the merchant workspace's paper header, where a plain white pill
 * would vanish.
 */
export function WalletButton({
  className = '',
  surface = 'dark',
}: {
  className?: string
  surface?: 'dark' | 'light'
}) {
  const { open } = useWalletModal()
  const { address, isConnected, isConnecting, isWrongChain } = useWallet()

  const ringOffset = surface === 'dark' ? 'focus-visible:ring-offset-brand-950' : 'focus-visible:ring-offset-paper'
  const base = `inline-flex h-10 max-w-[10.5rem] items-center gap-2 rounded-full px-3 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-300 focus-visible:ring-offset-2 sm:max-w-none sm:px-4 ${ringOffset}`

  const neutral =
    surface === 'dark'
      ? 'bg-white/10 text-brand-100 hover:bg-white/15'
      : 'bg-brand-50 text-brand-700 ring-1 ring-inset ring-brand-200 hover:bg-brand-100'

  if (isConnecting) {
    return (
      <button type="button" onClick={open} className={`${base} ${neutral} !text-brand-950 ${className}`}>
        <Spinner className="size-4" /> Connecting…
      </button>
    )
  }

  if (isConnected && isWrongChain) {
    return (
      <button
        type="button"
        onClick={open}
        className={`${base} bg-warn-500 text-night hover:bg-warn-500/90 ${className}`}
      >
        <span className="size-2 rounded-full bg-night/70" />
        Wrong network
      </button>
    )
  }

  if (isConnected && address) {
    return (
      <button type="button" onClick={open} className={`${base} ${neutral} ${className}`}>
        <span className="size-2 rounded-full bg-brand-500" />
        <span className="tabular truncate">{shortenAddress(address)}</span>
      </button>
    )
  }

  return (
    <button
      type="button"
      onClick={open}
      className={`${base} bg-brand-600 text-white hover:bg-brand-500 ${className}`}
    >
      <Icons.wallet className="size-4" />
      Connect wallet
    </button>
  )
}
