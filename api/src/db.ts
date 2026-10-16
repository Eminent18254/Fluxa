/**
 * The SQLite mirror.
 *
 * The Intelligent Contract is the source of truth. This database exists so the
 * obligations can be queried and aggregated quickly, and so a decision history
 * survives even if the RPC is unavailable. Nothing here is authoritative, which
 * is why there is no code path that writes an obligation from an HTTP request.
 *
 * node:sqlite ships with Node 22.5+, so the mirror needs no server, no service
 * key and no hosted database.
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Resolve locations from this file, not from process.cwd(). `npm run sync` runs
// with the api/ directory as cwd, so a cwd-relative default wrote the mirror to
// api/api/data/ instead of api/data/. A relative FLUXA_DB_PATH is interpreted
// against the repository root, which is how .env documents it.
const apiRoot = fileURLToPath(new URL('..', import.meta.url))
const repoRoot = resolve(apiRoot, '..')
const configured = process.env.FLUXA_DB_PATH?.trim()
const path = configured ? resolve(repoRoot, configured) : resolve(apiRoot, 'data', 'fluxa.sqlite')
mkdirSync(dirname(path), { recursive: true })

export const db = new DatabaseSync(path)

db.exec(`
  create table if not exists obligations (
    id text primary key,
    external_id text not null,
    merchant_address text not null,
    buyer_address text not null,
    currency text not null,
    amount_minor text not null,
    due_at text not null,
    evidence_uri text not null,
    evidence_digest text not null,
    status text not null,
    decision text not null,
    confidence_band text not null,
    reason text not null,
    inconsistencies text not null,
    policy_version text not null,
    decision_revision integer not null default 0,
    evidence_revision integer not null default 0,
    evaluated_revision integer not null default 0,
    content_digest text not null default '',
    payment_reference text not null default '',
    synced_at text not null default (datetime('now'))
  );

  create index if not exists obligations_merchant_idx
    on obligations (merchant_address, due_at desc);

  create index if not exists obligations_status_idx
    on obligations (status);

  create table if not exists decisions (
    id integer primary key autoincrement,
    obligation_id text not null,
    decision text not null,
    confidence_band text not null,
    reason text not null,
    inconsistencies text not null,
    policy_version text not null,
    decision_revision integer not null,
    evidence_revision integer not null,
    content_digest text not null default '',
    observed_at text not null default (datetime('now')),
    unique (obligation_id, decision_revision)
  );
`)

/**
 * The mirror is disposable and `npm run sync` rebuilds it, but a file written by
 * an earlier version should still work rather than fail on its first write.
 */
function ensureColumn(table: string, column: string, definition: string): void {
  const columns = db.prepare(`pragma table_info(${table})`).all() as { name: string }[]
  if (!columns.some((entry) => entry.name === column)) {
    db.exec(`alter table ${table} add column ${column} ${definition}`)
  }
}

ensureColumn('obligations', 'evaluated_revision', 'integer not null default 0')
ensureColumn('obligations', 'content_digest', "text not null default ''")
ensureColumn('decisions', 'content_digest', "text not null default ''")

/** The shape the contract's serializers return. */
export type ContractObligation = {
  id: string
  externalId: string
  merchant: string
  buyer: string
  currency: string
  amountMinor: string
  dueAt: string
  evidenceUri: string
  evidenceDigest: string
  status: string
  decision: string
  confidenceBand: string
  reason: string
  inconsistencies: string[]
  policyVersion: string
  decisionRevision: number
  evidenceRevision: number
  evaluatedRevision: number
  contentDigest: string
  verdictIsCurrent: boolean
  paymentReference: string
}

const UPSERT = `
  insert into obligations (
    id, external_id, merchant_address, buyer_address, currency, amount_minor,
    due_at, evidence_uri, evidence_digest, status, decision, confidence_band,
    reason, inconsistencies, policy_version, decision_revision, evidence_revision,
    evaluated_revision, content_digest, payment_reference, synced_at
  ) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, datetime('now'))
  on conflict(id) do update set
    status = excluded.status,
    decision = excluded.decision,
    confidence_band = excluded.confidence_band,
    reason = excluded.reason,
    inconsistencies = excluded.inconsistencies,
    evidence_uri = excluded.evidence_uri,
    evidence_digest = excluded.evidence_digest,
    decision_revision = excluded.decision_revision,
    evidence_revision = excluded.evidence_revision,
    evaluated_revision = excluded.evaluated_revision,
    content_digest = excluded.content_digest,
    payment_reference = excluded.payment_reference,
    buyer_address = excluded.buyer_address,
    synced_at = datetime('now')
`

/** Mirror one contract record, and keep a row for each decision revision. */
export function upsertObligation(o: ContractObligation): void {
  db.prepare(UPSERT).run(
    o.id,
    o.externalId,
    o.merchant,
    o.buyer,
    o.currency,
    String(o.amountMinor),
    String(o.dueAt),
    o.evidenceUri,
    o.evidenceDigest,
    o.status,
    o.decision,
    o.confidenceBand,
    o.reason,
    JSON.stringify(o.inconsistencies ?? []),
    o.policyVersion,
    Number(o.decisionRevision) || 0,
    Number(o.evidenceRevision) || 0,
    Number(o.evaluatedRevision) || 0,
    o.contentDigest ?? '',
    o.paymentReference ?? '',
  )

  if (o.decision && o.decision !== 'NONE') {
    db.prepare(
      `insert or ignore into decisions (
         obligation_id, decision, confidence_band, reason, inconsistencies,
         policy_version, decision_revision, evidence_revision, content_digest
       ) values (?,?,?,?,?,?,?,?,?)`,
    ).run(
      o.id,
      o.decision,
      o.confidenceBand,
      o.reason,
      JSON.stringify(o.inconsistencies ?? []),
      o.policyVersion,
      Number(o.decisionRevision) || 0,
      Number(o.evidenceRevision) || 0,
      o.contentDigest ?? '',
    )
  }
}

export function listObligations(merchant?: string) {
  if (merchant) {
    return db
      .prepare('select * from obligations where lower(merchant_address) = lower(?) order by due_at desc')
      .all(merchant)
  }
  return db.prepare('select * from obligations order by due_at desc').all()
}

export function getObligation(id: string) {
  return db.prepare('select * from obligations where id = ?').get(id)
}

export function listDecisions(obligationId: string) {
  return db
    .prepare('select * from decisions where obligation_id = ? order by decision_revision asc')
    .all(obligationId)
}

export function summary() {
  return db
    .prepare(
      `select status, count(*) as count, coalesce(sum(cast(amount_minor as integer)), 0) as amount_minor
         from obligations group by status`,
    )
    .all()
}

export function lastSync() {
  const row = db.prepare('select max(synced_at) as at from obligations').get() as { at?: string } | undefined
  return row?.at ?? null
}
