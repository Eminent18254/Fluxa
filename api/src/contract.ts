/**
 * Server-side reads of the Fluxa Intelligent Contract.
 *
 * Reads need no account: the obligation views are public, so the mirror can be
 * rebuilt by anyone without a key.
 *
 * The deployed address is compiled in because `.env` is gitignored and a host
 * with no env vars would otherwise refuse to sync at all. An environment
 * override is validated before it is trusted, because a stale or truncated
 * value is truthy and would silently replace a working address.
 */
import { createClient } from 'genlayer-js'
import { studionet } from 'genlayer-js/chains'
import type { ContractObligation } from './db.js'

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/
const DEPLOYED_CONTRACT = '0x9eBE9664a68faA688FB95F058c30763a25846b79'

function contractAddress(): string {
  const configured = String(process.env.GENLAYER_OBLIGATION_CONTRACT ?? '').trim()
  return ADDRESS_PATTERN.test(configured) ? configured : DEPLOYED_CONTRACT
}

function client() {
  return createClient({ chain: studionet })
}

function parse<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

export async function readObligations(): Promise<ContractObligation[]> {
  const raw = await client().readContract({
    address: contractAddress() as `0x${string}`,
    functionName: 'get_obligations',
  })
  const list = parse<ContractObligation[]>(raw, [])
  return Array.isArray(list) ? list : []
}