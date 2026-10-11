/**
 * Route table.
 *
 * The split that matters here is not visual, it is an access boundary:
 *
 *   /                 the public landing page - the product pitch and the wallet
 *                     modal. No shell, no wallet, renders for anyone.
 *
 *   /i/:obligationId  the link a merchant sends a buyer. It must work for a
 *                     visitor with no wallet and no account, so it lives outside
 *                     the merchant shell. It reads the obligation straight from
 *                     the Intelligent Contract.
 *
 *   /invoices...      the merchant's own workspace, behind the AppLayout shell
 *                     and assuming a connected wallet on GenLayer.
 *
 * There is no dashboard: the obligation list is the merchant's home. Keeping the
 * review page outside the shell means a buyer never hits a "connect your wallet"
 * wall before they know what they are being asked to pay.
 */
import { Routes, Route, Navigate } from 'react-router';
import { AppLayout } from '@/components/AppLayout';
import { LandingPage } from '@/pages/LandingPage';
import { InvoicesPage } from '@/pages/InvoicesPage';
import { NewInvoicePage } from '@/pages/NewInvoicePage';
import { PayInvoicePage } from '@/pages/PayInvoicePage';
import { NotFoundPage } from '@/pages/NotFoundPage';
import { DocsPage } from '@/pages/DocsPage';

// `paths` lives in its own leaf module (@/paths) so AppLayout can read it at
// module load without the routes.tsx <-> AppLayout import cycle reaching it
// before initialization. Re-exported here so existing `@/routes` imports keep
// working.
export { paths } from '@/paths';

export function AppRoutes() {
  return (
    <Routes>
      {/* Public: no wallet required. */}
      <Route path="/" element={<LandingPage />} />
      <Route path="/i/:invoiceId" element={<PayInvoicePage />} />
      <Route path="/docs" element={<DocsPage />} />

      {/* Merchant workspace. */}
      <Route element={<AppLayout />}>
        <Route path="invoices" element={<InvoicesPage />} />
        <Route path="invoices/new" element={<NewInvoicePage />} />
        <Route path="404" element={<NotFoundPage />} />
        <Route path="*" element={<Navigate to="/404" replace />} />
      </Route>
    </Routes>
  );
}
