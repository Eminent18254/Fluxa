import { ExternalLink } from 'lucide-react'
import { Link, NavLink, Outlet } from 'react-router'
import { Wordmark } from '@/components/landing/Brand'
import { WalletButton } from '@/components/wallet/WalletButton'
import { Icons, type IconName } from '@/components/icons'
import { COSTON2 } from '@/config/flare'
import { paths } from '@/paths'

const nav: { to: string; label: string; icon: IconName; end: boolean }[] = [
  { to: paths.invoices, label: 'Invoices', icon: 'receipt', end: true },
  { to: paths.newInvoice, label: 'Create', icon: 'spark', end: false },
  { to: paths.docs, label: 'Docs', icon: 'book', end: true },
]

function WorkspaceNav({ mobile = false }: { mobile?: boolean }) {
  return (
    <nav className={mobile ? 'grid grid-cols-3 gap-1' : 'flex items-center gap-1'} aria-label="Merchant workspace">
      {nav.map((item) => {
        const Icon = Icons[item.icon]
        return (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) => `${mobile ? 'flex-1 justify-center' : ''} inline-flex h-10 items-center gap-2 rounded-full px-4 text-sm font-semibold transition-all ${
              isActive
                ? 'bg-white text-brand-700 shadow-[0_8px_24px_rgba(18,55,145,.1)] ring-1 ring-brand-100'
                : 'text-night/55 hover:bg-white/55 hover:text-night'
            }`}
          >
            <Icon className="size-4" strokeWidth={1.8} />
            {item.label}
          </NavLink>
        )
      })}
    </nav>
  )
}

export function AppLayout() {
  return (
    <div className="app-shell flex min-h-dvh flex-col overflow-x-hidden text-night">
      <header className="sticky top-0 z-30 px-3 pt-3 sm:px-5 sm:pt-4">
        <div className="liquid-nav mx-auto grid max-w-7xl grid-cols-[1fr_auto] items-center gap-4 rounded-full px-4 py-2.5 sm:px-5 md:grid-cols-[1fr_auto_1fr]">
          <Link to={paths.invoices} className="w-fit shrink-0 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-300">
            <Wordmark tone="dark" markClassName="size-8" textClassName="hidden text-lg sm:inline" />
          </Link>
          <div className="hidden justify-self-center md:block"><WorkspaceNav /></div>
          <div className="justify-self-end"><WalletButton surface="light" /></div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-7xl flex-1 px-4 pb-28 pt-8 sm:px-6 sm:pt-10 md:pb-12 lg:px-8">
        <Outlet />
      </main>

      <div className="fixed inset-x-3 bottom-3 z-30 rounded-2xl border border-white/80 bg-white/86 p-1.5 shadow-[0_18px_55px_rgba(18,55,145,.18)] backdrop-blur-2xl md:hidden">
        <WorkspaceNav mobile />
      </div>

      <footer className="hidden border-t border-brand-100/70 bg-white/55 backdrop-blur-xl md:block">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-8 py-5 text-xs text-night/45">
          <span className="inline-flex items-center gap-2"><span className="size-1.5 rounded-full bg-brand-500" />Coston2 testnet</span>
          <a href={COSTON2.explorer} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 font-medium text-brand-700 hover:text-brand-600">
            Block explorer <ExternalLink className="size-3.5" />
          </a>
        </div>
      </footer>
    </div>
  )
}
