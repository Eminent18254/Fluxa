import type { Invoice } from '@/lib/db'
import type { AssetSymbol, InvoiceStatus, PaymentRail } from '@/types/database'

/**
 * Sample invoices for the design/demo surface.
 *
 * These exist so the workspace renders a real, populated UI before the Supabase
 * client and merchant session are wired. The shapes are the domain `Invoice`
 * type exactly — so the eventual swap is mechanical: replace `SAMPLE_INVOICES`
 * with `useQuery({ queryKey: keys…, queryFn: () => listInvoices(db, filter) })`
 * and delete this file. Nothing downstream changes.
 */

type Seed = {
  title: string
  usd: number
  status: InvoiceStatus
  token: AssetSymbol
  rail?: PaymentRail
  customer?: string | null
  description?: string | null
  /** Due date relative to now, in days (negative = past). */
  dueInDays: number
  /** How long ago it was created, in hours (drives ordering). */
  createdHoursAgo: number
}

const SEEDS: Seed[] = [
  { title: 'Design retainer — March', usd: 2500, status: 'OPEN', token: 'FXRP', customer: '0x8b2f1e4A9c7D3b6E5f0A1c2D3e4F5a6B7c8D9e0F', description: 'Monthly product design retainer', dueInDays: 5, createdHoursAgo: 6 },
  { title: 'Motion graphics reel', usd: 3400, status: 'OPEN', token: 'FXRP', customer: '0x3A1b2C3d4E5f6a7B8c9D0e1F2a3B4c5D6e7F8a9B', description: '30-second launch animation', dueInDays: 9, createdHoursAgo: 20 },
  { title: 'Q1 maintenance', usd: 950, status: 'PENDING', token: 'USDT0', rail: 'XRPL_NATIVE', customer: '0x9F8e7D6c5B4a3928170615243342516078A9b0C1', description: 'Payment seen — confirming on-chain', dueInDays: 1, createdHoursAgo: 30 },
  { title: 'Logo & brand system', usd: 1800, status: 'PAID', token: 'USDT0', customer: '0x1122334455667788990011223344556677889900', description: 'Identity design + guidelines', dueInDays: -2, createdHoursAgo: 74 },
  { title: 'Website build — milestone 2', usd: 4200, status: 'SETTLED', token: 'FXRP', customer: '0xAbC1230000dEf4560000789A0000bCdE0000f012', description: 'Frontend + CMS integration', dueInDays: -6, createdHoursAgo: 120 },
  { title: 'Consulting call (2h)', usd: 300, status: 'OPEN', token: 'FXRP', customer: null, description: 'Architecture review session', dueInDays: 2, createdHoursAgo: 4 },
  { title: 'Photography package', usd: 1200, status: 'DRAFT', token: 'FXRP', customer: null, description: 'Not sent yet', dueInDays: 14, createdHoursAgo: 2 },
  { title: 'Legacy subscription', usd: 99, status: 'EXPIRED', token: 'USDT0', customer: '0x5566778899001122334455667788990011223344', description: 'Payment window elapsed', dueInDays: -10, createdHoursAgo: 400 },
  { title: 'Cancelled order', usd: 560, status: 'CANCELLED', token: 'FXRP', customer: '0x0099887766554433221100998877665544332211', description: 'Withdrawn by merchant', dueInDays: -1, createdHoursAgo: 90 },
]

const HOUR = 3_600_000
const DAY = 86_400_000

function makeInvoice(seed: Seed, i: number): Invoice {
  const now = Date.now()
  const created = new Date(now - seed.createdHoursAgo * HOUR)
  const settled = seed.status === 'PAID' || seed.status === 'SETTLED'
  // Stable pseudo-UUID so React keys and pay links don't churn between renders.
  const id = `f1000000-0000-4000-8000-${String(100000000000 + i).slice(-12)}`

  return {
    id,
    merchantId: 'demo-merchant',
    customerAddress: seed.customer ?? null,
    title: seed.title,
    description: seed.description ?? null,
    currencyCode: 'USD',
    usdAmount: seed.usd.toFixed(2),
    usdAmountNumber: seed.usd,
    tokenAmount: null,
    tokenSymbol: seed.token,
    price: null,
    contractVersion: 1,
    acceptedPaymentAssets: [seed.token],
    settlementTokenSymbol: seed.token,
    status: seed.status,
    dueAt: new Date(now + seed.dueInDays * DAY).toISOString(),
    paidAt: settled ? new Date(now - seed.createdHoursAgo * HOUR + 2 * HOUR).toISOString() : null,
    expiresAt: null,
    reference: null,
    onchainInvoiceId: null,
    paymentTxHash: null,
    rail: seed.rail ?? 'FLARE_ERC20',
    discountPercent: '0',
    totalWithDiscount: null,
    settlement: null,
    createdAt: created.toISOString(),
    updatedAt: created.toISOString(),
  }
}

export const SAMPLE_INVOICES: Invoice[] = SEEDS.map(makeInvoice)
