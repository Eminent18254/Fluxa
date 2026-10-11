/**
 * Optional SQLite projection API.
 *
 * The Intelligent Contract is the source of truth for every obligation and every
 * decision; this client only reads the SQLite mirror that `npm run sync` builds
 * from contract state. Nothing here can create or change an obligation, so a
 * stale mirror can never be mistaken for authority.
 */
const API_URL = (import.meta.env.VITE_FLUXA_API_URL ?? 'http://localhost:8787').replace(/\/$/, '')

export type ProjectedObligation = {
  id: string
  external_id: string
  merchant_address: string
  buyer_address: string | null
  currency: string
  amount_minor: string
  due_at: string
  evidence_uri: string
  evidence_digest: string
  status: string
  decision: string
  decision_reason: string | null
  payment_reference: string | null
  genlayer_tx_hash: string | null
  created_at?: string
  updated_at?: string
}

async function request<T>(path: string): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, { headers: { accept: 'application/json' } })
  const body = (await response.json().catch(() => ({}))) as { error?: string }
  if (!response.ok) throw new Error(body.error ?? `Projection API request failed (${response.status})`)
  return body as T
}

export const projectionApi = {
  health: () => request<{ ok: boolean; service: string }>('/health'),
  listObligations: (merchant: string) =>
    request<ProjectedObligation[]>(`/api/obligations?merchant=${encodeURIComponent(merchant)}`),
  getObligation: (id: string) => request<ProjectedObligation>(`/api/obligations/${encodeURIComponent(id)}`),
}
