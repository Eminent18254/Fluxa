import { useWallet } from '@/hooks/useWallet'
import { shortenAddress } from '@/lib/format'
import { Icons } from '@/components/icons'
import { Spinner } from '@/components/Button'
import { useWalletModal } from './WalletModalProvider'

/**
 * The nav's wallet control. It reflects connection status at a glance and opens
 * the modal for the actual work, so one button covers connect, switch-network
 * and account.
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
      ? 'border border-white/40 bg-white/10 text-white hover:bg-white/20'
      : 'border border-brand-100 bg-white/80 text-night hover:bg-white'

  if (isConnecting) {
    return (
      <span className={`${base} ${neutral}`}>
        <Spinner className="size-4" />
        Connecting
      </span>
    )
  }

  if (isConnected && address) {
    return (
      <button type="button" onClick={open} className={`${base} ${neutral} ${className}`}>
        <span className={`size-2 rounded-full ${isWrongChain ? 'bg-warn-500' : 'bg-signal-400'}`} />
        <span className="tabular truncate">{shortenAddress(address)}</span>
      </button>
    )
  }

  return (
    <button type="button" onClick={open} className={`${base} bg-brand-600 text-white hover:bg-brand-500 ${className}`}>
      <Icons.wallet className="size-4" />
      Connect wallet
    </button>
  )
}
