/**
 * Route path constants, in their own leaf module.
 *
 * Kept out of `routes.tsx` on purpose. `routes.tsx` imports the layout and the
 * pages, and `AppLayout` reads `paths` at module load (its nav array). Defining
 * `paths` there created an import cycle — routes.tsx → AppLayout → routes.tsx —
 * in which AppLayout ran before `export const paths` had initialized, throwing
 * "Cannot access 'paths' before initialization" and blanking the page in dev.
 *
 * This module imports nothing, so `paths` is always initialized before any
 * consumer's module body runs. `routes.tsx` re-exports it, so `@/routes` imports
 * keep working unchanged.
 */
export const paths = {
  landing: '/',
  invoices: '/invoices',
  newInvoice: '/invoices/new',
  docs: '/docs',
  pay: (invoiceId: string) => `/i/${invoiceId}`,
} as const;
