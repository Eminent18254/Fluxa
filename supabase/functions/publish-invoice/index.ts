import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { createPublicClient, decodeEventLog, http } from 'https://esm.sh/viem@2.55.13'

const RPC_URL = 'https://coston2-api.flare.network/ext/C/rpc'
const INVOICE_CONTRACT_V1 = '0x3ceb0760c7f2bd58b1d2a60813112cfc42e9d9e4'
const DEPLOYED_INVOICE_CONTRACT_V2 = '0xa7a76084c0ad139504ef1184f2d0a6054c019aa0'
const FUNCTION_VERSION = '2026-08-14-v2-address-fallback'
const TOKENS = {
  FXRP: '0x0b6a3645c240605887a5532109323a3e12273dc7',
  USDT0: '0xc1a5b41512496b80903d1f32d6dea3a73212e71f',
} as const
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-api-version',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Expose-Headers': 'x-fluxa-function-version',
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: {
    ...cors,
    'Content-Type': 'application/json',
    'X-Fluxa-Function-Version': FUNCTION_VERSION,
  },
})
const invoiceCreatedAbi = [{
  type: 'event', name: 'InvoiceCreated',
  inputs: [
    { indexed: true, name: 'invoiceId', type: 'uint256' },
    { indexed: true, name: 'merchant', type: 'address' },
    { indexed: true, name: 'payToken', type: 'address' },
    { indexed: false, name: 'amount', type: 'uint256' },
    { indexed: false, name: 'dueAt', type: 'uint64' },
    { indexed: false, name: 'paymentRef', type: 'bytes32' },
  ],
}] as const
const invoiceCreatedV2Abi = [
  {
    type: 'event', name: 'InvoiceCreatedV2',
    inputs: [
      { indexed: true, name: 'invoiceId', type: 'uint256' },
      { indexed: true, name: 'merchant', type: 'address' },
      { indexed: true, name: 'settlementToken', type: 'address' },
      { indexed: false, name: 'usdAmount', type: 'uint256' },
      { indexed: false, name: 'dueAt', type: 'uint64' },
      { indexed: false, name: 'paymentRef', type: 'bytes32' },
    ],
  },
  {
    type: 'event', name: 'PaymentOptionSet',
    inputs: [
      { indexed: true, name: 'invoiceId', type: 'uint256' },
      { indexed: true, name: 'token', type: 'address' },
    ],
  },
] as const

function usdMicros(value: unknown): bigint {
  const text = String(value)
  if (!/^\d+(\.\d+)?$/.test(text)) throw new Error(`Invalid stored USD amount ${text}`)
  const [whole = '0', fraction = ''] = text.split('.')
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0').slice(0, 6))
}

function sameSet(left: string[], right: string[]): boolean {
  return [...new Set(left.map((value) => value.toLowerCase()))].sort().join(',') ===
    [...new Set(right.map((value) => value.toLowerCase()))].sort().join(',')
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'POST required' }, 405)
  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return json({ error: 'Authentication required' }, 401)
    const url = Deno.env.get('SUPABASE_URL')!
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const session = createClient(url, anonKey, { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false } })
    const identity = await session.auth.getUser()
    if (identity.error || !identity.data.user) return json({ error: 'Invalid session' }, 401)

    const body = await req.json() as { invoiceId?: string; txHash?: `0x${string}` }
    if (!body.invoiceId || !/^[0-9a-f-]{36}$/i.test(body.invoiceId)) return json({ error: 'Invalid invoice id' }, 400)
    if (!body.txHash || !/^0x[0-9a-f]{64}$/i.test(body.txHash)) return json({ error: 'Invalid transaction hash' }, 400)

    const admin = createClient(url, serviceKey, { auth: { persistSession: false } })
    const { data: merchant } = await admin.from('merchants').select('id,wallet_address').eq('auth_user_id', identity.data.user.id).maybeSingle()
    if (!merchant) return json({ error: 'Merchant profile not found' }, 403)
    const { data: invoice } = await admin.from('invoices').select(
      'id,status,invoice_reference,token_amount,token_symbol,usd_amount,due_at,contract_version,accepted_payment_assets,settlement_token_symbol',
    ).eq('id', body.invoiceId).eq('merchant_id', merchant.id).maybeSingle()
    if (!invoice) return json({ error: 'Invoice not found' }, 404)
    if (invoice.status !== 'DRAFT') return json({ published: true, status: invoice.status })

    const chain = createPublicClient({ transport: http(RPC_URL) })
    const receipt = await chain.getTransactionReceipt({ hash: body.txHash })
    if (receipt.status !== 'success') return json({ error: 'Invoice transaction reverted' }, 400)
    const contractVersion = Number(invoice.contract_version ?? 1)
    let onchainInvoiceId: bigint
    let onchainDueAt: bigint

    if (contractVersion === 2) {
      const configuredInvoiceContractV2 = (Deno.env.get('FLUXA_INVOICE_V2_ADDRESS') ?? '')
        .trim()
        .toLowerCase()
      const invoiceContractV2 = /^0x[0-9a-f]{40}$/.test(configuredInvoiceContractV2)
        ? configuredInvoiceContractV2
        : DEPLOYED_INVOICE_CONTRACT_V2
      const decoded = receipt.logs
        .filter((entry) => entry.address.toLowerCase() === invoiceContractV2)
        .flatMap((entry) => {
          try {
            return [decodeEventLog({ abi: invoiceCreatedV2Abi, data: entry.data, topics: entry.topics })]
          } catch {
            return []
          }
        })
      const created = decoded.find((entry) => entry.eventName === 'InvoiceCreatedV2')
      if (!created || created.eventName !== 'InvoiceCreatedV2') {
        return json({ error: 'InvoiceCreatedV2 event not found' }, 400)
      }
      const args = created.args
      if (args.merchant.toLowerCase() !== String(merchant.wallet_address).toLowerCase()) return json({ error: 'Transaction merchant does not match session' }, 403)
      if (args.paymentRef.toLowerCase() !== String(invoice.invoice_reference).toLowerCase()) return json({ error: 'Transaction reference does not match invoice' }, 400)
      if (BigInt(args.usdAmount) !== usdMicros(invoice.usd_amount)) return json({ error: 'Transaction USD amount does not match invoice' }, 400)
      const settlementAddress = TOKENS[invoice.settlement_token_symbol as keyof typeof TOKENS]
      if (!settlementAddress || args.settlementToken.toLowerCase() !== settlementAddress) return json({ error: 'Transaction settlement asset does not match invoice' }, 400)

      const optionAddresses = decoded
        .filter((entry) => entry.eventName === 'PaymentOptionSet' && entry.args.invoiceId === args.invoiceId)
        .map((entry) => entry.eventName === 'PaymentOptionSet' ? entry.args.token.toLowerCase() : '')
      const storedAddresses = (invoice.accepted_payment_assets as string[]).map(
        (symbol) => TOKENS[symbol as keyof typeof TOKENS] ?? '',
      )
      if (storedAddresses.some((address) => !address) || !sameSet(optionAddresses, storedAddresses)) {
        return json({ error: 'Transaction payment assets do not match invoice' }, 400)
      }
      onchainInvoiceId = args.invoiceId
      onchainDueAt = args.dueAt
    } else {
      const decoded = receipt.logs
        .filter((entry) => entry.address.toLowerCase() === INVOICE_CONTRACT_V1)
        .flatMap((entry) => {
          try {
            return [decodeEventLog({ abi: invoiceCreatedAbi, data: entry.data, topics: entry.topics })]
          } catch {
            return []
          }
        })
      const created = decoded.find((entry) => entry.eventName === 'InvoiceCreated')
      if (!created) return json({ error: 'InvoiceCreated event not found' }, 400)
      const args = created.args
      if (args.merchant.toLowerCase() !== String(merchant.wallet_address).toLowerCase()) return json({ error: 'Transaction merchant does not match session' }, 403)
      if (args.paymentRef.toLowerCase() !== String(invoice.invoice_reference).toLowerCase()) return json({ error: 'Transaction reference does not match invoice' }, 400)
      if (BigInt(args.amount) !== BigInt(invoice.token_amount)) return json({ error: 'Transaction amount does not match invoice' }, 400)
      const payToken = TOKENS[invoice.token_symbol as keyof typeof TOKENS]
      if (!payToken || args.payToken.toLowerCase() !== payToken) return json({ error: 'Transaction payment asset does not match invoice' }, 400)
      onchainInvoiceId = args.invoiceId
      onchainDueAt = args.dueAt
    }

    const storedDueAt = Math.floor(new Date(String(invoice.due_at)).getTime() / 1000)
    if (BigInt(storedDueAt) !== onchainDueAt) return json({ error: 'Transaction due date does not match invoice' }, 400)

    const { error } = await admin.from('invoices').update({
      status: 'OPEN',
      onchain_invoice_id: onchainInvoiceId.toString(),
      due_at: new Date(Number(onchainDueAt) * 1000).toISOString(),
    }).eq('id', invoice.id).eq('status', 'DRAFT')
    if (error) throw error
    return json({ published: true, status: 'OPEN', onchainInvoiceId: onchainInvoiceId.toString() })
  } catch (error) {
    console.error('publish-invoice failure', error)
    return json({ error: error instanceof Error ? error.message : 'Could not publish invoice' }, 500)
  }
})
