/**
 * Read-only projection API over the SQLite mirror.
 *
 * There is deliberately no endpoint that creates, verifies or pays an
 * obligation. Those actions belong to the Intelligent Contract and to the
 * wallet that signs them, so this service can never become a second source of
 * truth for money.
 */
import express from 'express'
import cors from 'cors'
import { getObligation, lastSync, listDecisions, listObligations, summary } from './db.js'
import { sync } from './sync.js'

const app = express()
app.use(cors())
app.use(express.json())

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'fluxa-api', storage: 'sqlite', lastSync: lastSync() })
})

app.get('/api/summary', (_req, res) => {
  res.json({ statuses: summary(), lastSync: lastSync() })
})

app.get('/api/obligations', (req, res) => {
  const merchant = typeof req.query.merchant === 'string' ? req.query.merchant : undefined
  res.json(listObligations(merchant))
})

app.get('/api/obligations/:id', (req, res) => {
  const row = getObligation(req.params.id)
  if (!row) return res.status(404).json({ error: 'not_found' })
  return res.json(row)
})

app.get('/api/obligations/:id/decisions', (req, res) => {
  res.json(listDecisions(req.params.id))
})

// Refreshing the mirror is the only write this service performs, and it only
// ever copies contract state into SQLite.
app.post('/api/sync', async (_req, res) => {
  try {
    res.json(await sync())
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : 'sync_failed' })
  }
})

const port = Number(process.env.PORT ?? 8787)
app.listen(port, () => {
  console.log(`Fluxa projection API listening on http://localhost:${port} (SQLite)`)
})
