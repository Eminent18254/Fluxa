import { supabase } from './supabase'

export async function publishConfirmedInvoice(invoiceId: string, txHash: `0x${string}`) {
  const client = supabase()
  const session = await client.auth.getSession()
  const accessToken = session.data.session?.access_token
  if (!accessToken) throw new Error('Wallet session expired. Reconnect your wallet.')
  const baseUrl = import.meta.env.VITE_SUPABASE_URL?.trim()
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim()
  if (!baseUrl || !anonKey) throw new Error('Supabase is not configured')
  const response = await fetch(`${baseUrl}/functions/v1/publish-invoice`, {
    method: 'POST',
    headers: { apikey: anonKey, Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ invoiceId, txHash }),
  })
  const data = await response.json().catch(() => ({})) as { error?: string; published?: boolean }
  if (!response.ok || !data.published) throw new Error(data.error ?? `Invoice publication failed (${response.status})`)
  return data
}
