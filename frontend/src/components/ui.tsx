import type { ReactNode } from 'react'

type Tone = 'default' | 'success' | 'warn' | 'danger' | 'flare'

const toneClasses: Record<Tone, string> = {
  default: 'border-brand-100 bg-brand-50 text-brand-700',
  success: 'border-brand-200 bg-brand-50 text-brand-700',
  warn: 'border-warn-500/25 bg-warn-500/10 text-amber-800',
  danger: 'border-danger-500/20 bg-danger-500/8 text-danger-500',
  flare: 'border-brand-200 bg-brand-50 text-brand-700',
}

export function Badge({ tone = 'default', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold ${toneClasses[tone]}`}>{children}</span>
}

export function Card({ title, subtitle, action, children }: { title?: string; subtitle?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="app-panel rounded-2xl p-5">
      {(title || action) && (
        <header className="mb-4 flex items-start justify-between gap-4">
          <div>
            {title && <h2 className="font-display text-sm font-semibold text-night">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-xs text-night/50">{subtitle}</p>}
          </div>
          {action}
        </header>
      )}
      {children}
    </section>
  )
}

export { Button } from './Button'
