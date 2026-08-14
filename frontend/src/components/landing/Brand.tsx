import { type ReactNode } from 'react'

type Tone = 'light' | 'dark'

/**
 * The Fluxa mark — a rounded tile carrying a stylised "flux" ripple: a nod to
 * flow (money moving) and to the XRP Ledger Fluxa settles against. Scales from
 * the nav to the hero via `className`.
 */
export function LogoMark({ className = 'size-9' }: { className?: string }) {
  return (
    <span
      className={`relative inline-grid place-items-center text-brand-700 drop-shadow-[0_8px_12px_rgba(36,82,224,.22)] ${className}`}
    >
      <svg viewBox="0 0 40 40" fill="none" className="relative size-full" aria-hidden="true">
        <defs><linearGradient id="fluxa-mark" x1="5" y1="5" x2="35" y2="35"><stop stopColor="#70a2ff"/><stop offset=".48" stopColor="#2452e0"/><stop offset="1" stopColor="#5a45e6"/></linearGradient></defs>
        <path d="M6.5 12.5c4.3-5 9.1-5 13.4 0s9.1 5 13.6 0" stroke="url(#fluxa-mark)" strokeWidth="5" strokeLinecap="round" />
        <path d="M6.5 27.5c4.3 5 9.1 5 13.4 0s9.1-5 13.6 0" stroke="url(#fluxa-mark)" strokeWidth="5" strokeLinecap="round" />
        <circle cx="20" cy="20" r="3.25" fill="#8b7cf4" stroke="white" strokeWidth="1.5" />
      </svg>
    </span>
  )
}

/** Mark + "Fluxa" wordmark. `tone` picks the text colour for its surface. */
export function Wordmark({
  tone = 'light',
  className = '',
  markClassName = 'size-9',
  textClassName = 'text-xl',
}: {
  tone?: Tone
  className?: string
  markClassName?: string
  textClassName?: string
}) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      <LogoMark className={markClassName} />
      <span
        className={`font-display font-bold tracking-tight ${textClassName} ${
          tone === 'light' ? 'text-paper' : 'text-night'
        }`}
      >
        Fluxa
      </span>
    </span>
  )
}

/**
 * The pill badge from the references — the "Our Solution" / "The future is
 * here" chip. Two tones: on light sections, and on the blue bands.
 */
export function Pill({
  children,
  icon,
  tone = 'onLight',
  className = '',
}: {
  children: ReactNode
  icon?: ReactNode
  tone?: 'onLight' | 'onDark'
  className?: string
}) {
  const styles =
    tone === 'onDark'
      ? 'bg-white/10 text-brand-100 ring-white/15'
      : 'bg-brand-50 text-brand-700 ring-brand-100'
  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 text-sm font-medium ring-1 ring-inset ${styles} ${className}`}
    >
      {icon}
      {children}
    </span>
  )
}
