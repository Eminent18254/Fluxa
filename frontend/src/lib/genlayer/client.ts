/**
 * The only module that talks to GenLayer.
 *
 * Built on `genlayer-js` 1.x, the same SDK line the GenLayer CLI bundles. The
 * 2.0.0-rc.1 release encodes a call with an empty method key, which the
 * Studionet runtime rejects (`call to private method __handle_undefined_method__`),
 * so every read and write against a CLI-deployed contract fails. 1.x sends the
 * `method` key the runtime expects.
 *
 * Four failure modes are handled here, all observed against the deployed
 * contracts on this machine:
 *
 *   1. A write is not finished when the hash comes back. Nothing is reported as
 *      done until the transaction reaches ACCEPTED and the leader receipt says
 *      SUCCESS.
 *   2. The RPC occasionally drops a connection or answers with an empty body, so
 *      the transport is retried instead of failing the whole write.
 *   3. Contract failures come back base64-encoded inside the receipt, so the
 *      human message has to be recovered before it can be shown.
 *   4. The wallet can leave the chain after connecting, so the chain is
 *      re-asserted on every write and that becomes a prompt instead of a dead
 *      submit button.
 *
 * Wallets are injected EIP-1193 providers. Keys are never created or held here.
 * Reads work without a wallet so an obligation link opens for anyone; writes
 * require a connection.
 */
import { createClient } from 'genlayer-js';
import { TransactionStatus } from 'genlayer-js/types';
import { GENLAYER, GENLAYER_CHAIN, isConfigured } from '@/config/genlayer';
import type { Obligation } from '@/lib/obligations';

type Eip1193Provider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  on?: (event: string, handler: (...args: never[]) => void) => void;
  removeListener?: (event: string, handler: (...args: never[]) => void) => void;
};

export type WalletState = {
  address: string | null;
  isConnecting: boolean;
  isWrongChain: boolean;
};

const CHAIN_HEX = `0x${GENLAYER_CHAIN.id.toString(16)}`;
const MODE_KEY = 'fluxa.wallet.mode';

let provider: Eip1193Provider | null = null;
let state: WalletState = { address: null, isConnecting: false, isWrongChain: false };
let cachedClient: ReturnType<typeof createClient> | null = null;
const listeners = new Set<(next: WalletState) => void>();

function emit(): void {
  for (const listener of listeners) listener({ ...state });
}

function setState(next: Partial<WalletState>): void {
  state = { ...state, ...next };
  cachedClient = null;
  emit();
}

export function subscribe(listener: (next: WalletState) => void): () => void {
  listeners.add(listener);
  listener({ ...state });
  return () => listeners.delete(listener);
}

export function walletState(): WalletState {
  return { ...state };
}

function injected(): Eip1193Provider | null {
  if (typeof window === 'undefined') return null;
  return (window as Window & { ethereum?: Eip1193Provider }).ethereum ?? null;
}

export function hasBrowserWallet(): boolean {
  return Boolean(injected());
}

function getClient() {
  if (cachedClient) return cachedClient;
  // The account is deliberately left off the client. The SDK routes signing
  // methods to the injected provider only when no account object is configured,
  // which is exactly what we want: reads go to the RPC, writes go to the wallet.
  cachedClient = provider
    ? createClient({ chain: GENLAYER_CHAIN, provider: provider as never })
    : createClient({ chain: GENLAYER_CHAIN });
  return cachedClient;
}

function activeAccount() {
  return state.address ? { address: state.address as `0x${string}`, type: 'json-rpc' as const } : undefined;
}

// ------------------------------------------------------------------ the wallet

async function currentChainId(): Promise<string | null> {
  if (!provider) return null;
  try {
    return String(await provider.request({ method: 'eth_chainId' }));
  } catch {
    return null;
  }
}

async function syncChain(): Promise<void> {
  const active = await currentChainId();
  setState({ isWrongChain: Boolean(active && active.toLowerCase() !== CHAIN_HEX) });
}

export async function connect(): Promise<void> {
  const found = injected();
  if (!found) throw new Error('No browser wallet found. Install MetaMask to continue.');

  setState({ isConnecting: true });
  try {
    provider = found;
    const accounts = (await found.request({ method: 'eth_requestAccounts' })) as string[];
    const address = Array.isArray(accounts) ? accounts[0] ?? null : null;
    if (!address) throw new Error('The wallet did not share an account.');

    window.localStorage.setItem(MODE_KEY, 'browser');
    found.on?.('accountsChanged' as never, ((next: string[]) => {
      setState({ address: Array.isArray(next) ? next[0] ?? null : null });
    }) as never);
    found.on?.('chainChanged' as never, (() => void syncChain()) as never);

    setState({ address, isConnecting: false });
    await syncChain();
  } catch (error) {
    setState({ isConnecting: false });
    throw new Error(readError(error));
  }
}

export function disconnect(): void {
  window.localStorage.removeItem(MODE_KEY);
  provider = null;
  setState({ address: null, isWrongChain: false });
}

/** Re-attach to an already-authorised wallet on page load. */
export async function restore(): Promise<void> {
  const found = injected();
  if (!found || window.localStorage.getItem(MODE_KEY) !== 'browser') return;
  try {
    const accounts = (await found.request({ method: 'eth_accounts' })) as string[];
    const address = Array.isArray(accounts) ? accounts[0] ?? null : null;
    if (!address) return;
    provider = found;
    setState({ address });
    await syncChain();
  } catch {
    // A wallet that refuses to answer is simply not connected.
  }
}

/** Ask the wallet to move to the GenLayer chain this app is built for. */
export async function switchToGenLayer(): Promise<void> {
  if (!provider) throw new Error('Connect a wallet before continuing.');
  const result = await provider.request({ method: 'eth_chainId' });
  if (String(result).toLowerCase() === CHAIN_HEX) {
    setState({ isWrongChain: false });
    return;
  }
  try {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CHAIN_HEX }] });
  } catch {
    await provider.request({
      method: 'wallet_addEthereumChain',
      params: [
        {
          chainId: CHAIN_HEX,
          chainName: GENLAYER_CHAIN.name,
          nativeCurrency: GENLAYER_CHAIN.nativeCurrency,
          rpcUrls: [...GENLAYER_CHAIN.rpcUrls.default.http],
        },
      ],
    });
  }
  await syncChain();
}

// ------------------------------------------------------------------- errors

type Receipt = {
  execution_result?: string;
  result?: string;
  stderr?: string;
  error?: string;
  genvm_result?: { stderr?: string; stdout?: string };
  consensus_data?: { leader_receipt?: Receipt[] };
};

/** The last non-empty line of a GenVM traceback is the message worth showing. */
function lastTracebackLine(text: string): string {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length > 0 ? lines[lines.length - 1] : '';
}

/** Contract failures come back base64 inside receipt.result with an ERROR status. */
function decodeContractError(error: unknown): string {
  let node = error as { data?: { receipt?: Receipt }; receipt?: Receipt; cause?: unknown } | undefined;
  for (let depth = 0; node && depth < 6; depth += 1) {
    const receipt = node.data?.receipt ?? node.receipt;
    if (receipt && receipt.execution_result && receipt.execution_result !== 'SUCCESS') {
      const encoded = receipt.result;
      if (typeof encoded === 'string' && encoded.length > 0) {
        try {
          const decoded = typeof atob === 'function' ? atob(encoded) : Buffer.from(encoded, 'base64').toString('utf8');
          // GenVM prefixes the payload with a control byte, so strip it.
          if (decoded && /[a-zA-Z]/.test(decoded)) return decoded.replace(/^[\u0000-\u001f]+/, '').trim();
        } catch {
          // Not base64 after all; fall through to the traceback.
        }
      }
      const traceback = receipt.genvm_result?.stderr || receipt.stderr;
      if (typeof traceback === 'string' && traceback.trim()) {
        const line = lastTracebackLine(traceback);
        if (line) return line;
      }
    }
    node = node.cause as typeof node;
  }
  return '';
}

const TRANSIENT_RPC =
  /Unexpected token|unknown RPC error|failed to fetch|fetch failed|load failed|ECONNRESET|socket hang up|network error|timed out|timeout|502|503|504/i;

function isTransientRpc(value: unknown): boolean {
  const node = value as { details?: string; shortMessage?: string; message?: string };
  const raw = node?.details || node?.shortMessage || node?.message || String(value);
  return TRANSIENT_RPC.test(String(raw));
}

/** Turn an SDK, wallet or contract failure into something a merchant can read. */
export function readError(error: unknown): string {
  const node = error as { details?: string; shortMessage?: string; message?: string };
  const raw = node?.details || node?.shortMessage || node?.message || String(error);
  const text = decodeContractError(error) || String(raw);

  if (/undetermined|VALIDATORS_TIMEOUT|LEADER_TIMEOUT/i.test(text)) return 'The validator committee could not reach agreement. Nothing was changed - try again.';
  if (/Only the merchant/i.test(text)) return 'Only the merchant who created this obligation can do that.';
  if (/Only the recorded buyer/i.test(text)) return 'Only the buyer recorded on this obligation can record its payment.';
  if (/Only a verified obligation/i.test(text)) return 'This obligation has not been verified, so no payment can be recorded.';
  if (/already been used/i.test(text)) return 'That reference is already in use. Choose another one.';
  if (/Unsupported decision|unsupported decision/i.test(text)) return 'The committee returned a decision outside the supported set.';
  if (/value must be at least 1/i.test(text)) return 'Connect the wallet that signs this obligation before continuing.';
  if (/must be connected|No account/i.test(text)) return 'Connect a wallet before continuing.';
  if (/chainId should be same as current chainId|wrong network|does not match the target chain|Chain mismatch/i.test(text)) {
    return `Your wallet is on a different network than ${GENLAYER_CHAIN.name} (chain ${GENLAYER_CHAIN.id}). Switch networks and try again.`;
  }
  if (/user rejected|User denied|4001/i.test(text)) return 'You rejected the request in your wallet.';
  if (isTransientRpc(text)) return 'The RPC dropped the connection before it answered. Nothing is guaranteed to have changed - check the latest state and try again.';
  return text;
}

// ------------------------------------------------------------------- writes

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type WriteResult = { hash: string; receipt: Receipt };

async function send(functionName: string, args: unknown[]): Promise<WriteResult> {
  if (!isConfigured()) throw new Error('The Fluxa obligation contract is not configured.');
  if (!state.address) throw new Error('Connect a wallet before continuing.');

  // The wallet can be moved to another network after it was connected, and the
  // SDK then refuses to sign. Re-assert the chain so that becomes a prompt
  // instead of a dead submit button.
  if (provider) {
    await switchToGenLayer();
    const active = await currentChainId();
    if (String(active).toLowerCase() !== CHAIN_HEX) {
      throw new Error(`Your wallet is on a different network than ${GENLAYER_CHAIN.name} (chain ${GENLAYER_CHAIN.id}).`);
    }
  }

  const client = getClient();

  // The RPC occasionally answers with an empty body or drops the connection.
  // Retry the transport rather than failing the whole write on one bad response.
  let hash: string | null = null;
  for (let attempt = 0; ; attempt += 1) {
    try {
      hash = (await client.writeContract({
        account: activeAccount(),
        address: GENLAYER.obligationContract as `0x${string}`,
        functionName,
        args: args as never[],
        value: 0n,
      })) as unknown as string;
      break;
    } catch (error) {
      if (attempt >= 1 || !isTransientRpc(error)) throw new Error(readError(error));
      await sleep(1800);
    }
  }

  // A hash is not a result. Wait for the committee to accept it.
  let receipt: Receipt | null = null;
  for (let attempt = 0; ; attempt += 1) {
    try {
      receipt = (await client.waitForTransactionReceipt({
        hash: hash as never,
        status: TransactionStatus.ACCEPTED,
        retries: 400,
        interval: 3000,
      })) as unknown as Receipt;
      break;
    } catch (error) {
      if (attempt >= 3 || !isTransientRpc(error)) throw new Error(readError(error));
      await sleep(2500);
    }
  }

  const leader = receipt?.consensus_data?.leader_receipt?.[0];
  if (leader && leader.execution_result && leader.execution_result !== 'SUCCESS') {
    // The revert message lives base64-encoded in the leader receipt, so hand the
    // receipt itself to readError rather than a flattened string.
    throw new Error(readError({ data: { receipt: leader } }));
  }
  return { hash: hash as string, receipt: receipt as Receipt };
}

// -------------------------------------------------------------------- reads

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

async function read(functionName: string, args: unknown[] = []): Promise<string> {
  if (!isConfigured()) throw new Error('The Fluxa obligation contract is not configured.');
  const raw = await getClient().readContract({
    account: activeAccount(),
    address: GENLAYER.obligationContract as `0x${string}`,
    functionName,
    args: args as never[],
  });
  return typeof raw === 'string' ? raw : JSON.stringify(raw);
}

export async function fetchObligation(id: string): Promise<Obligation> {
  const parsed = parseJson<Obligation | null>(await read('get_obligation', [id]), null);
  if (!parsed || !parsed.id) throw new Error('That obligation could not be found.');
  return parsed;
}

export async function fetchObligations(): Promise<Obligation[]> {
  const list = parseJson<Obligation[]>(await read('get_obligations'), []);
  return Array.isArray(list) ? list : [];
}

export async function fetchMyObligations(merchant: string): Promise<Obligation[]> {
  const list = parseJson<Obligation[]>(await read('get_my_obligations', [merchant]), []);
  return Array.isArray(list) ? list : [];
}

export async function fetchPayableObligations(buyer: string): Promise<Obligation[]> {
  const list = parseJson<Obligation[]>(await read('get_payable_obligations', [buyer]), []);
  return Array.isArray(list) ? list : [];
}

// --------------------------------------------------------------- obligation ops

export function createObligation(input: {
  externalId: string;
  buyer: string;
  currency: string;
  amountMinor: string;
  dueAt: string;
  evidenceUri: string;
  evidenceDigest: string;
}): Promise<WriteResult> {
  return send('create_obligation', [
    input.externalId,
    input.buyer,
    input.currency,
    input.amountMinor,
    input.dueAt,
    input.evidenceUri,
    input.evidenceDigest,
  ]);
}

export function submitVerification(obligationId: string, evidence: string): Promise<WriteResult> {
  return send('submit_verification', [obligationId, evidence]);
}

export function replaceEvidence(obligationId: string, evidenceUri: string, evidenceDigest: string): Promise<WriteResult> {
  return send('replace_evidence', [obligationId, evidenceUri, evidenceDigest]);
}

export function recordPayment(obligationId: string, paymentReference: string): Promise<WriteResult> {
  return send('record_payment', [obligationId, paymentReference]);
}