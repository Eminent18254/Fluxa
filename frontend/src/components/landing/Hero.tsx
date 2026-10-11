import { GlowField } from './Decor'
import { Button } from '@/components/Button'
import { useWalletModal } from '@/components/wallet/WalletModalProvider'


export function Hero() {
  const { open } = useWalletModal()

  return (
    <section id="top" className="grain-overlay relative min-h-[50rem] overflow-hidden bg-gradient-to-br from-[#174fd8] via-[#3976ef] to-[#76a9fb]">
      <GlowField className="z-0" />
      <div className="pointer-events-none absolute left-1/2 top-8 z-[1] h-80 w-[58rem] -translate-x-1/2 rounded-full bg-white/20 blur-3xl" />
      <div className="absolute inset-x-0 bottom-0 z-[3] h-10 bg-white sm:h-14" aria-hidden="true" />

      <div className="relative z-10 mx-auto flex max-w-4xl flex-col items-center px-5 pb-28 pt-36 text-center sm:px-6 sm:pb-52 sm:pt-[24.5rem]">
        <h1 className="max-w-3xl font-display text-[3rem] font-medium leading-[0.98] tracking-[-0.06em] text-white sm:text-6xl md:text-[4.65rem]">
          Intelligent obligations.<br className="hidden sm:block" /> Decisions you can verify.
        </h1>

        <p className="mt-5 max-w-lg text-sm leading-relaxed text-white/72 sm:text-base">Create evidence-backed commercial obligations, verify them through intelligent contracts, and record payment on GenLayer.</p>

        <div className="mt-7 w-full max-w-[25rem] rounded-full bg-white/90 p-1.5 shadow-[0_12px_40px_rgba(22,48,110,.16)] ring-1 ring-black/10 backdrop-blur-xl">
          <div className="flex items-center gap-2 rounded-full bg-white px-2 py-1">
            <span className="flex-1 pl-3 text-left text-xs text-night/40">Start verifying obligations</span>
            <Button variant="primary" size="md" onClick={open} className="premium-button px-5 text-sm">Launch Fluxa</Button>
          </div>
        </div>
      </div>
    </section>
  )
}
