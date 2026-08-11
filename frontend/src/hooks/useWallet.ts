/**
 * Wallet connection against Coston2.
 *
 * Wraps wagmi's connect/disconnect/switch primitives into the three facts the
 * UI actually needs: are we connected, are we on the right chain, and what
 * single action fixes whichever of those is false.
 */
import { useCallback } from 'react';
import {
  useAccount,
  useConnect,
  useDisconnect,
  useSwitchChain,
  useBalance,
} from 'wagmi';
import { coston2 } from '@/config/chains';

export function useWallet() {
  const { address, isConnected, chainId, status } = useAccount();
  const { connectors, connect, isPending: isConnecting, error: connectError } =
    useConnect();
  const { disconnect } = useDisconnect();
  const {
    switchChain,
    isPending: isSwitching,
    error: switchError,
  } = useSwitchChain();

  const injectedConnector =
    connectors.find((c) => c.type === 'injected') ?? connectors[0];

  // A wallet on the wrong chain is the most common demo failure — surface it
  // as its own state rather than letting reads silently return nothing.
  const isWrongChain = isConnected && chainId !== coston2.id;

  const balance = useBalance({
    address,
    chainId: coston2.id,
    query: { enabled: Boolean(address) },
  });

  const handleConnect = useCallback(() => {
    if (!injectedConnector) return;
    connect({ connector: injectedConnector, chainId: coston2.id });
  }, [connect, injectedConnector]);

  const handleSwitch = useCallback(() => {
    switchChain({ chainId: coston2.id });
  }, [switchChain]);

  return {
    address,
    isConnected,
    isConnecting: isConnecting || status === 'connecting' || status === 'reconnecting',
    isWrongChain,
    isSwitching,
    hasWallet: Boolean(injectedConnector),
    nativeBalance: balance.data,
    connect: handleConnect,
    disconnect,
    switchToCoston2: handleSwitch,
    error: connectError ?? switchError ?? null,
  };
}
