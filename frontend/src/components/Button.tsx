import { type ButtonHTMLAttributes, type ReactNode } from 'react'

/**
 * The button of the blue design system (shared by the landing page, the wallet
 * modal, and the app pages). Pill-shaped, matching the reference CTAs.
 *
 * The dark app's original `ui.tsx` Button still exists for pages not yet
 * migrated; new surfaces use this one.
 */
type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'
type Size = 'sm' | 'md' | 'lg'

const VARIANTS: Record<Variant, string> = {
  primary: 'premium-button bg-gradient-to-b from-[#4c7ff0] to-brand-700 text-white hover:brightness-105 shadow-[inset_0_1px_0_rgba(255,255,255,.38),0_12px_28px_rgba(36,82,224,.24)]',
  secondary: 'border border-brand-100 bg-white/78 text-brand-700 hover:border-brand-200 hover:bg-white backdrop-blur-xl shadow-[inset_0_1px_0_white,0_8px_24px_rgba(18,55,145,.06)]',
  ghost: 'text-brand-700 hover:bg-brand-50/80',
  danger: 'border border-danger-500/20 bg-white text-danger-500 hover:bg-danger-500/5',
}

const SIZES: Record<Size, string> = {
  sm: 'h-9 gap-1.5 px-3.5 text-sm',
  md: 'h-11 gap-2 px-5 text-sm',
  lg: 'h-12 gap-2 px-6 text-base',
}

export function Button({
  variant = 'primary',
  size = 'md',
  className = '',
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size; children: ReactNode }) {
  return (
    <button
      className={`inline-flex items-center justify-center rounded-full font-semibold transition-[transform,filter,background-color,border-color] duration-200 hover:-translate-y-0.5 active:translate-y-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 focus-visible:ring-offset-2 disabled:translate-y-0 disabled:cursor-not-allowed disabled:opacity-55 ${VARIANTS[variant]} ${SIZES[size]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  )
}

/** Inline loading spinner, sized by `className` (e.g. size-4). */
export function Spinner({ className = 'size-4' }: { className?: string }) {
  return (
    <svg className={`animate-spin ${className}`} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  )
}
