import { useEffect, useState } from 'react'
import { Wordmark } from './Brand'
import { WalletButton } from '@/components/wallet/WalletButton'

const LINKS = [
  { href: '#product', label: 'Features' },
  { href: '#how', label: 'How Fluxa Works' },
  { href: '#flare', label: 'Why Flare' },
  { href: '/docs', label: 'Docs' },
] as const

/**
 * The landing nav. It floats transparent over the hero and fades in a blurred
 * blue bar once the page scrolls, so the wordmark never fights the hero gradient
 * but stays legible over the light sections below. The wallet control is the
 * only real action up here — everything else is an in-page anchor.
 */
export function LandingNav() {
  const [scrolled, setScrolled] = useState(false)

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 16)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  return (
    <header
      className={`fixed inset-x-0 top-0 z-40 transition-colors duration-300 ${
        scrolled ? 'border-b border-brand-100/70 bg-white/80 shadow-sm backdrop-blur-xl' : 'border-b border-transparent'
      }`}
    >
      <div className={`mx-auto mt-3 flex max-w-6xl items-center justify-between gap-4 rounded-full px-4 py-2.5 transition-all sm:px-5 ${scrolled ? 'mx-4 border border-white/70 bg-white/70 shadow-[0_16px_50px_rgba(22,48,110,.12)] backdrop-blur-2xl' : 'border border-white/35 bg-white/10 shadow-[inset_0_1px_0_rgba(255,255,255,.55)] backdrop-blur-md'}`}>
        <a href="#top" className="shrink-0 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-300">
          <Wordmark tone="dark" markClassName="size-8" textClassName="text-lg" />
        </a>

        <nav className="hidden items-center gap-1 md:flex">
          {LINKS.map((l) => (
            <a
              key={l.href}
              href={l.href}
              className="crystal-link rounded-full px-4 py-2 text-sm font-medium text-brand-950/70 transition-all hover:-translate-y-px hover:text-brand-950"
            >
              {l.label}
            </a>
          ))}
        </nav>

        <WalletButton />
      </div>
    </header>
  )
}
