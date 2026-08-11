/**
 * Wallet connection control.
 *
 * Three states get distinct treatment because they need different actions:
 * no wallet installed, connected-but-wrong-chain, and connected. The wrong-chain
 * case is the one most likely to bite during a live demo, so it is loud.
 */
import { useWallet } from '@/hooks/useWallet';
import { shortenAddress } from '@/lib/format';
import { COSTON2 } from '@/config/flare';
import { Badge, Button } from './ui';

export function ConnectWallet() {
  const {
    address,
    isConnected,
    isConnecting,
    isWrongChain,
    isSwitching,
    hasWallet,
    connect,
    disconnect,
    switchToCoston2,
    error,
  } = useWallet();

  if (!hasWallet) {
    return (
      <a
        href="https://metamask.io/download/"
        target="_blank"
        rel="noreferrer"
        className="rounded-lg border border-ink-600 px-4 py-2 text-sm text-ink-200 hover:bg-ink-800"
      >
        Install a wallet
      </a>
    );
  }

  if (!isConnected) {
    return (
      <div className="flex flex-col items-end gap-1">
        <Button onClick={connect} disabled={isConnecting}>
          {isConnecting ? 'Connecting…' : 'Connect wallet'}
        </Button>
        {error && (
          <span className="text-xs text-danger-500">{error.message}</span>
        )}
      </div>
    );
  }

  if (isWrongChain) {
    return (
      <div className="flex items-center gap-3">
        <Badge tone="warn">Wrong network</Badge>
        <Button onClick={switchToCoston2} disabled={isSwitching}>
          {isSwitching ? 'Switching…' : `Switch to ${COSTON2.name}`}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3">
      <Badge tone="success">
        <span className="size-1.5 rounded-full bg-signal-400" />
        Coston2
      </Badge>
      <button
        onClick={() => disconnect()}
        className="tabular rounded-lg border border-ink-600 px-3 py-2 font-mono text-sm text-ink-200 hover:bg-ink-800"
        title="Disconnect"
      >
        {address ? shortenAddress(address) : ''}
      </button>
    </div>
  );
}
