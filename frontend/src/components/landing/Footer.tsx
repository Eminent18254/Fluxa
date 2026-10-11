import { Wordmark } from './Brand'
import { GENLAYER } from '@/config/genlayer'

const COLUMNS: { title: string; links: { label: string; href: string; external?: boolean }[] }[] = [
  { title: 'Product', links: [{ label: 'Features', href: '#product' }, { label: 'How it works', href: '#how' }, { label: 'GenLayer integration', href: '#genlayer' }, { label: 'Fluxa docs', href: '/docs' }] },
  { title: 'Build on GenLayer', links: [{ label: 'GenLayer docs', href: 'https://docs.genlayer.com', external: true }, { label: 'Intelligent contracts', href: 'https://docs.genlayer.com/developers/intelligent-contracts/introduction', external: true }] },
  { title: 'Testnet', links: [{ label: 'GenLayer explorer', href: GENLAYER.explorerUrl, external: true }] },
]

export function Footer() {
  return (
    <footer className="grain-overlay relative overflow-hidden bg-gradient-to-br from-[#174fd8] via-[#2f6eea] to-[#76a9fb] text-brand-950/70">
      <div className="pointer-events-none absolute -right-32 -top-36 size-[28rem] rounded-full border-[5rem] border-white/[.07]" />
      <div className="pointer-events-none absolute -bottom-40 left-1/4 size-[30rem] rounded-full bg-white/10 blur-3xl" />
      <div className="mx-auto max-w-6xl px-6 py-16">
        <div className="relative grid gap-12 md:grid-cols-[1.4fr_repeat(3,1fr)]">
          <div>
            <Wordmark tone="dark" markClassName="size-9" textClassName="text-xl" />
            <p className="mt-4 max-w-xs text-sm font-medium leading-relaxed text-brand-950/70">Verify real-world obligations from commercial evidence and coordinate payment through GenLayer intelligent contracts.</p>
          </div>
          {COLUMNS.map((column) => (
            <div key={column.title}>
              <h3 className="font-display text-sm font-semibold text-brand-950">{column.title}</h3>
              <ul className="mt-4 space-y-3">
                {column.links.map((link) => <li key={link.label}><a href={link.href} {...(link.external ? { target: '_blank', rel: 'noreferrer' } : {})} className="text-sm font-medium text-brand-950/70 transition-colors hover:text-brand-950">{link.label}</a></li>)}
              </ul>
            </div>
          ))}
        </div>
        <div className="relative mt-14 flex flex-col items-start justify-between gap-4 border-t border-brand-950/15 pt-8 text-xs font-medium text-brand-950/65 sm:flex-row sm:items-center">
          <p>© 2026 Fluxa. All rights reserved.</p>
          <p>Built for GenLayer Studionet.</p>
        </div>
      </div>
    </footer>
  )
}
