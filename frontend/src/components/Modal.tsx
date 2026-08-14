import { useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/**
 * A minimal accessible modal: portalled to <body>, a click-through scrim, Escape
 * to close, and a body scroll-lock while open. It only owns the overlay and the
 * centring — the caller styles the panel it passes as children.
 *
 * On small screens the panel docks to the bottom as a sheet; on sm+ it centres.
 */
export function Modal({
  open,
  onClose,
  children,
  labelledBy,
}: {
  open: boolean
  onClose: () => void
  children: ReactNode
  labelledBy?: string
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = previousOverflow
    }
  }, [open, onClose])

  if (!open) return null

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby={labelledBy}
    >
      <button
        type="button"
        aria-label="Close"
        tabIndex={-1}
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-brand-950/45 backdrop-blur-md"
      />
      <div className="animate-rise relative w-full max-w-md px-2 pb-2 sm:px-0 sm:pb-0">{children}</div>
    </div>,
    document.body,
  )
}
