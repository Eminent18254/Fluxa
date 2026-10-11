/**
 * Pull every obligation from the contract into the SQLite mirror.
 *
 * Safe to run repeatedly: rows are upserted by obligation id and each decision
 * revision is inserted once, so running it twice changes nothing the second time.
 *
 *   npm run sync
 */
import { lastSync, summary, upsertObligation } from './db.js'
import { readObligations } from './contract.js'

export async function sync(): Promise<{ obligations: number; at: string | null }> {
  const obligations = await readObligations()
  for (const obligation of obligations) upsertObligation(obligation)
  return { obligations: obligations.length, at: lastSync() }
}

const invokedDirectly = process.argv[1] && process.argv[1].includes('sync')

if (invokedDirectly) {
  try {
    const result = await sync()
    console.log(`Synced ${result.obligations} obligation(s). Last write: ${result.at ?? 'never'}`)
    console.table(summary())
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
