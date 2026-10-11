import type { ObligationStatus } from '@/lib/obligations'

/**
 * Obligation status as a chip, in the blue design system.
 *
 * The labels are the contract's own decision vocabulary, not softened synonyms.
 * A merchant needs to see "More evidence required" with the same weight the
 * committee gave it, because that is the state they have to act on.
 */
const STYLES: Record<ObligationStatus, { label: string; chip: string; dot: string }> = {
  SUBMITTED: {
    label: 'Awaiting review',
    chip: 'bg-brand-50 text-brand-700 ring-brand-100',
    dot: 'bg-brand-500',
  },
  VERIFIED: {
    label: 'Verified',
    chip: 'bg-signal-400/10 text-[#047857] ring-signal-400/25',
    dot: 'bg-signal-500',
  },
  MORE_EVIDENCE_REQUIRED: {
    label: 'More evidence required',
    chip: 'bg-warn-500/10 text-[#b45309] ring-warn-500/25',
    dot: 'bg-warn-500',
  },
  REJECTED: {
    label: 'Rejected',
    chip: 'bg-danger-500/8 text-[#dc2626] ring-danger-500/20',
    dot: 'bg-danger-500',
  },
  PAID: {
    label: 'Paid',
    chip: 'bg-brand-100 text-brand-700 ring-brand-200',
    dot: 'bg-brand-600',
  },
}

export function statusLabel(status: ObligationStatus): string {
  return STYLES[status]?.label ?? status
}

export function StatusBadge({ status, className = '' }: { status: ObligationStatus; className?: string }) {
  const style = STYLES[status] ?? STYLES.SUBMITTED
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset ${style.chip} ${className}`}>
      <span className={`size-1.5 rounded-full ${style.dot}`} />
      {style.label}
    </span>
  )
}
