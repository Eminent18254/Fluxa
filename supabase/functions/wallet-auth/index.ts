import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { verifyMessage } from 'https://esm.sh/viem@2.55.13'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-supabase-api-version, x-fluxa-client',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'POST required' }, 405)
  const url = Deno.env.get('SUPABASE_URL')!
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } })
  let stage = 'parse-request'
  try {
    const body = await req.json() as { action?: string; address?: string; nonce?: string; signature?: `0x${string}`; displayName?: string }
    const address = body.address?.toLowerCase()
    if (!address || !/^0x[0-9a-f]{40}$/.test(address)) return json({ error: 'Invalid wallet address' }, 400)

    if (body.action === 'challenge') {
      stage = 'create-challenge'
      const nonce = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '')
      const message = `Fluxa wallet sign-in\n\nWallet: ${address}\nNonce: ${nonce}\nExpires: ${new Date(Date.now() + 5 * 60_000).toISOString()}`
      const { error } = await admin.from('wallet_auth_challenges').insert({ nonce, wallet_address: address, message, expires_at: new Date(Date.now() + 5 * 60_000).toISOString() })
      if (error) return json({ error: error.message }, 500)
      return json({ nonce, message })
    }

    if (body.action !== 'verify' || !body.nonce || !body.signature) return json({ error: 'Invalid authentication request' }, 400)
    stage = 'load-challenge'
    const { data: challenge, error: challengeError } = await admin.from('wallet_auth_challenges').select('*').eq('nonce', body.nonce).eq('wallet_address', address).is('consumed_at', null).gt('expires_at', new Date().toISOString()).maybeSingle()
    if (challengeError || !challenge) return json({ error: 'Challenge is invalid, expired, or already used' }, 401)
    stage = 'verify-signature'
    const valid = await verifyMessage({ address: address as `0x${string}`, message: challenge.message, signature: body.signature })
    if (!valid) return json({ error: 'Wallet signature did not verify' }, 401)
    stage = 'consume-challenge'
    const consumed = await admin.from('wallet_auth_challenges').update({ consumed_at: new Date().toISOString() }).eq('nonce', body.nonce)
    if (consumed.error) return json({ error: `consume-challenge: ${consumed.error.message}` }, 500)

    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return json({ error: 'verify-session: anonymous session required' }, 401)
    stage = 'verify-session'
    const sessionClient = createClient(url, Deno.env.get('SUPABASE_ANON_KEY') ?? '', { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false } })
    const identity = await sessionClient.auth.getUser()
    if (identity.error || !identity.data.user) return json({ error: `verify-session: ${identity.error?.message ?? 'invalid session'}` }, 401)
    const userId = identity.data.user.id
    stage = 'link-merchant'
    const { error: merchantError } = await admin.from('merchants').upsert({ wallet_address: address, auth_user_id: userId, display_name: body.displayName ?? null }, { onConflict: 'wallet_address' })
    if (merchantError) return json({ error: merchantError.message }, 500)
    return json({ authenticated: true, user: identity.data.user })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Wallet authentication failed'
    console.error('wallet-auth failure', { stage, message })
    return json({ error: `${stage}: ${message}` }, 500)
  }
})
