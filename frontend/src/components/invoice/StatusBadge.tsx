import type { InvoiceStatus } from '@/types/database'

/**
 * Invoice status as a chip, in the blue design system. One place decides how each
 * lifecycle state looks, so the list, the pay page, and any receipt agree — a
 * SETTLED invoice is the same green everywhere.
 */
const STYLES: Record<InvoiceStatus, { label: string; chip: string; dot: string }> = {
  DRAFT: {
    label: 'Draft',
    chip: 'bg-night/[0.06] text-night/55 ring-night/10',
    dot: 'bg-night/30',
  },
  OPEN: {
    label: 'Open',
    chip: 'bg-brand-50 text-brand-700 ring-brand-100',
    dot: 'bg-brand-500',
  },
  PENDING: {
    label: 'Pending',
    chip: 'bg-warn-500/10 text-[#b45309] ring-warn-500/20',
    dot: 'bg-warn-500',
  },
  PAID: {
    label: 'Paid',
    chip: 'bg-brand-50 text-brand-700 ring-brand-200',
    dot: 'bg-brand-500',
  },
  SETTLED: {
    label: 'Settled',
    chip: 'bg-iris-400/12 text-iris-600 ring-iris-400/25',
    dot: 'bg-iris-500',
  },
  EXPIRED: {
    label: 'Expired',
    chip: 'bg-night/[0.06] text-night/50 ring-night/10',
    dot: 'bg-night/30',
  },
  CANCELLED: {
    label: 'Cancelled',
    chip: 'bg-danger-500/8 text-[#dc2626] ring-danger-500/20',
    dot: 'bg-danger-500',
  },
}

export function statusLabel(status: InvoiceStatus): string {
  return STYLES[status].label
}

export function StatusBadge({ status, className = '' }: { status: InvoiceStatus; className?: string }) {
  const s = STYLES[status]
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset ${s.chip} ${className}`}
    >
      <span className={`size-1.5 rounded-full ${s.dot}`} />
      {s.label}
    </span>
  )
}
