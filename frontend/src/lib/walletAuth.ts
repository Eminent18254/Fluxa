import { supabase } from './supabase'
import type { Address } from 'viem'
import { getCurrentMerchant } from './db'

type EthereumProvider = { request(args: { method: string; params?: unknown[] }): Promise<unknown> }
function provider(): EthereumProvider {
  const ethereum = (window as Window & { ethereum?: EthereumProvider }).ethereum
  if (!ethereum) throw new Error('No browser wallet detected')
  return ethereum
}

export async function signInWithWallet(address: Address, displayName?: string | null) {
  const client = supabase()
  const baseUrl = import.meta.env.VITE_SUPABASE_URL?.trim()
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim()
  if (!baseUrl || !anonKey) throw new Error('Supabase is not configured')
  const endpoint: string = `${baseUrl}/functions/v1/wallet-auth`
  const publishableKey: string = anonKey
  const existing = await client.auth.getSession()
  if (existing.data.session) {
    const merchant = await getCurrentMerchant(client)
    if (merchant?.walletAddress.toLowerCase() === address.toLowerCase()) return existing.data
    await client.auth.signOut()
  }
  const anonymous = await client.auth.signInAnonymously()
  if (anonymous.error || !anonymous.data.session) throw new Error(anonymous.error?.message ?? 'Enable Anonymous Auth in Supabase first')

  async function call(body: Record<string, unknown>, accessToken = anonKey) {
    let response: Response
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          apikey: publishableKey,
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      })
    } catch (error) {
      throw new Error(`Could not reach wallet-auth: ${error instanceof Error ? error.message : 'network request failed'}`)
    }
    const text = await response.text()
    let data: Record<string, any> = {}
    try { data = text ? JSON.parse(text) : {} } catch { throw new Error(`wallet-auth returned invalid JSON (${response.status})`) }
    if (!response.ok) throw new Error(data.error ?? `wallet-auth failed with HTTP ${response.status}`)
    return data
  }

  const data = await call({ action: 'challenge', address, displayName })
  if (!data.message || !data.nonce) throw new Error(data.error ?? 'Could not start wallet sign-in')
  const signature = await provider().request({ method: 'personal_sign', params: [data.message, address] })
  const verified = await call(
    { action: 'verify', address, nonce: data.nonce, signature, displayName },
    anonymous.data.session.access_token,
  )
  if (!verified.authenticated) throw new Error(verified.error ?? 'Could not verify wallet signature')
  return anonymous.data
}

export async function hasWalletSession(address: Address): Promise<boolean> {
  const client = supabase()
  const session = await client.auth.getSession()
  if (!session.data.session) return false
  const merchant = await getCurrentMerchant(client)
  return merchant?.walletAddress.toLowerCase() === address.toLowerCase()
}
