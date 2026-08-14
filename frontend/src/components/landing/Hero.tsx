import { lazy, Suspense, useEffect, useState } from 'react'
import { GlowField } from './Decor'
import { Button } from '@/components/Button'
import { useWalletModal } from '@/components/wallet/WalletModalProvider'

const CoinCluster = lazy(() => import('./Coins').then((module) => ({ default: module.CoinCluster })))

export function Hero() {
  const { open } = useWalletModal()
  const [showCoins, setShowCoins] = useState(false)

  useEffect(() => {
    const media = window.matchMedia('(min-width: 640px) and (prefers-reduced-motion: no-preference)')
    const update = () => setShowCoins(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  return (
    <section id="top" className="grain-overlay relative min-h-[50rem] overflow-hidden bg-gradient-to-br from-[#174fd8] via-[#3976ef] to-[#76a9fb]">
      <GlowField className="z-0" />
      <div className="pointer-events-none absolute left-1/2 top-8 z-[1] h-80 w-[58rem] -translate-x-1/2 rounded-full bg-white/20 blur-3xl" />
      {showCoins && <Suspense fallback={<div className="absolute inset-x-0 top-20 z-[2] mx-auto h-64 max-w-3xl rounded-full bg-white/10 blur-3xl" />}>
        <CoinCluster className="z-[2]" />
      </Suspense>}
      <div className="absolute inset-x-0 bottom-0 z-[3] h-10 bg-white sm:h-14" aria-hidden="true" />

      <div className="relative z-10 mx-auto flex max-w-4xl flex-col items-center px-5 pb-32 pt-40 text-center sm:px-6 sm:pb-52 sm:pt-[24.5rem]">
        <h1 className="max-w-3xl font-display text-[3rem] font-medium leading-[0.98] tracking-[-0.06em] text-white sm:text-6xl md:text-[4.65rem]">
          Crypto invoices.<br className="hidden sm:block" /> Settlement on your terms.
        </h1>

        <p className="mt-5 max-w-lg text-sm leading-relaxed text-white/72 sm:text-base">Set invoice values in USD for clear pricing. Customers pay with FXRP or USDT0, and you receive your selected supported settlement asset.</p>

        <div className="mt-7 w-full max-w-[25rem] rounded-full bg-white/90 p-1.5 shadow-[0_12px_40px_rgba(22,48,110,.16)] ring-1 ring-black/10 backdrop-blur-xl">
          <div className="flex items-center gap-2 rounded-full bg-white px-2 py-1">
            <span className="flex-1 pl-3 text-left text-xs text-night/40">Start accepting crypto</span>
            <Button variant="primary" size="md" onClick={open} className="premium-button px-5 text-sm">Launch Fluxa</Button>
          </div>
        </div>
      </div>
    </section>
  )
}
