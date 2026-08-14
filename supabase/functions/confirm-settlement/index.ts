import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { createPublicClient, decodeEventLog, http } from 'https://esm.sh/viem@2.55.13'

const RPC_URL = 'https://coston2-api.flare.network/ext/C/rpc'
const SETTLEMENT_V1 = '0x4faaa888a4d220d060a1323a9831d846b055f0d2'
const SETTLEMENT_V2 = '0x7f4b2e77f0bbca9856c620f5606a9618809ee34a'
const TOKENS: Record<string, 'FXRP' | 'USDT0'> = {
  '0x0b6a3645c240605887a5532109323a3e12273dc7': 'FXRP',
  '0xc1a5b41512496b80903d1f32d6dea3a73212e71f': 'USDT0',
}
const settledAbi = [{
  type: 'event', name: 'InvoiceSettled',
  inputs: [
    { indexed: true, name: 'invoiceId', type: 'uint256' },
    { indexed: true, name: 'merchant', type: 'address' },
    { indexed: true, name: 'recipient', type: 'address' },
    { indexed: false, name: 'token', type: 'address' },
    { indexed: false, name: 'amountOut', type: 'uint256' },
  ],
}] as const
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-api-version',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'POST required' }, 405)
  try {
    const body = await req.json() as { invoiceId?: string; txHash?: `0x${string}` }
    if (!body.invoiceId || !/^[0-9a-f-]{36}$/i.test(body.invoiceId)) return json({ error: 'Invalid invoice id' }, 400)
    if (!body.txHash || !/^0x[0-9a-f]{64}$/i.test(body.txHash)) return json({ error: 'Invalid transaction hash' }, 400)

    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } })
    const { data: invoice, error: invoiceError } = await admin.from('invoices').select('id,status,onchain_invoice_id,contract_version').eq('id', body.invoiceId).maybeSingle()
    if (invoiceError) throw invoiceError
    if (!invoice || !invoice.onchain_invoice_id) return json({ error: 'Invoice is not linked on-chain' }, 404)
    if (invoice.status === 'SETTLED') return json({ settled: true, status: 'SETTLED' })

    const chain = createPublicClient({ transport: http(RPC_URL) })
    const receipt = await chain.getTransactionReceipt({ hash: body.txHash })
    if (receipt.status !== 'success') return json({ error: 'Settlement transaction reverted' }, 400)
    const expectedContract = Number(invoice.contract_version) === 2 ? SETTLEMENT_V2 : SETTLEMENT_V1
    const event = receipt.logs
      .filter((log) => log.address.toLowerCase() === expectedContract)
      .flatMap((log) => {
        try { return [{ decoded: decodeEventLog({ abi: settledAbi, data: log.data, topics: log.topics }), log }] }
        catch { return [] }
      })
      .find(({ decoded }) => decoded.eventName === 'InvoiceSettled' && decoded.args.invoiceId.toString() === String(invoice.onchain_invoice_id))
    if (!event || event.decoded.eventName !== 'InvoiceSettled') return json({ error: 'Matching settlement event not found' }, 400)

    const symbol = TOKENS[event.decoded.args.token.toLowerCase()]
    if (!symbol) return json({ error: 'Unsupported settlement token' }, 400)
    const block = await chain.getBlock({ blockNumber: receipt.blockNumber })
    const { error } = await admin.rpc('record_settlement', {
      p_invoice_id: invoice.id,
      p_tx_hash: body.txHash.toLowerCase(),
      p_token_symbol: symbol,
      p_amount_units: event.decoded.args.amountOut.toString(),
      p_to_address: event.decoded.args.recipient.toLowerCase(),
      p_settled_at: new Date(Number(block.timestamp) * 1000).toISOString(),
    })
    if (error) throw error
    return json({ settled: true, status: 'SETTLED' })
  } catch (error) {
    console.error('confirm-settlement failure', error)
    return json({ error: error instanceof Error ? error.message : 'Could not confirm settlement' }, 500)
  }
})
