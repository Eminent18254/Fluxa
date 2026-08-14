import { BrowserRouter } from 'react-router';
import { AppRoutes } from '@/routes';
import { WalletModalProvider } from '@/components/wallet/WalletModalProvider';

export function App() {
  return (
    <BrowserRouter>
      <WalletModalProvider>
        <AppRoutes />
      </WalletModalProvider>
    </BrowserRouter>
  );
}
