export async function confirmSettledInvoice(invoiceId: string, txHash: `0x${string}`): Promise<void> {
  const baseUrl = import.meta.env.VITE_SUPABASE_URL?.trim()
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim()
  if (!baseUrl || !anonKey) throw new Error('Settlement sync is not configured')
  const response = await fetch(`${baseUrl}/functions/v1/confirm-settlement`, {
    method: 'POST',
    headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ invoiceId, txHash }),
  })
  const data = await response.json().catch(() => ({})) as { error?: string }
  if (!response.ok) throw new Error(data.error ?? `Settlement sync failed with HTTP ${response.status}`)
}
