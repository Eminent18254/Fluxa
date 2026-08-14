import { LogoMark } from '@/components/landing/Brand'

export function LoadingState({ label = 'Loading', compact = false }: { label?: string; compact?: boolean }) {
  return (
    <div className={`grid place-items-center ${compact ? 'min-h-64' : 'min-h-[55vh]'}`} role="status" aria-live="polite">
      <div className="w-full max-w-sm text-center">
        <div className="relative mx-auto grid size-20 place-items-center">
          <span className="absolute inset-0 rounded-full bg-brand-300/25 blur-xl" />
          <span className="absolute inset-1 animate-spin rounded-full border-2 border-brand-100 border-r-brand-600 border-t-iris-500" />
          <span className="relative grid size-14 place-items-center rounded-full bg-white/85 shadow-[0_16px_45px_rgba(36,82,224,.14)] backdrop-blur-xl"><LogoMark className="size-8" /></span>
        </div>
        <span className="sr-only">{label}</span>
      </div>
    </div>
  )
}
