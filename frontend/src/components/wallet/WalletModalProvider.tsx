import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { WalletModal } from './WalletModal'

/**
 * Mounts a single WalletModal for the whole app and exposes open/close through
 * context, so any button — the nav, a hero CTA, a checkout page — triggers the
 * same flow without each one owning modal state.
 */
type WalletModalCtx = { open: () => void; close: () => void; isOpen: boolean }

const Ctx = createContext<WalletModalCtx | null>(null)

export function WalletModalProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false)
  const open = useCallback(() => setIsOpen(true), [])
  const close = useCallback(() => setIsOpen(false), [])
  const value = useMemo(() => ({ open, close, isOpen }), [open, close, isOpen])

  return (
    <Ctx.Provider value={value}>
      {children}
      <WalletModal open={isOpen} onClose={close} />
    </Ctx.Provider>
  )
}

export function useWalletModal(): WalletModalCtx {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useWalletModal must be used within <WalletModalProvider>')
  return ctx
}
