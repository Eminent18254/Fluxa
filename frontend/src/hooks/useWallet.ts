/**
 * React view over the wallet store in lib/genlayer/client.
 *
 * The store owns the connection; this only subscribes to it, so every component
 * sees the same address and the same wrong-chain verdict.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  connect as connectWallet,
  disconnect as disconnectWallet,
  hasBrowserWallet,
  restore,
  subscribe,
  switchToGenLayer,
  walletState,
  type WalletState,
} from '@/lib/genlayer/client';

export function useWallet() {
  const [state, setState] = useState<WalletState>(walletState);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void restore();
    const unsubscribe = subscribe((next) => {
      if (!cancelled) setState(next);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const connect = useCallback(async () => {
    setError(null);
    try {
      await connectWallet();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not connect the wallet.');
    }
  }, []);

  const switchChain = useCallback(async () => {
    setError(null);
    try {
      await switchToGenLayer();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not switch networks.');
    }
  }, []);

  const disconnect = useCallback(() => {
    setError(null);
    disconnectWallet();
  }, []);

  return {
    address: state.address,
    isConnected: Boolean(state.address),
    isConnecting: state.isConnecting,
    isWrongChain: state.isWrongChain,
    hasWallet: hasBrowserWallet(),
    connect,
    disconnect,
    switchChain,
    error,
  };
}
