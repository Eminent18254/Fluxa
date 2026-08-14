#!/usr/bin/env tsx
import { indexerConfig } from "../config.js";
import { makeProvider } from "../logs.js";
import { serviceClient } from "../supabase.js";

async function main(): Promise<void> {
  const config = indexerConfig(process.env.FLUXA_NETWORK ?? "coston2");
  const db = serviceClient();
  const provider = makeProvider(config);
  try {
    const [{ data, error }, head] = await Promise.all([
      db
        .from("sync_state")
        .select("id,chain_id,last_processed_block,deployed_at_block,contract_fingerprint,last_run_at,last_error")
        .eq("id", config.syncStateId)
        .maybeSingle(),
      provider.getBlockNumber(),
    ]);
    if (error) throw new Error(`reading sync_state: ${error.message}`);
    console.log(`Network       ${config.network}`);
    console.log(`Chain head    ${head}`);
    console.log(`V1 start      ${config.deployedAtBlock}`);
    console.log(`Fingerprint   ${config.fingerprint}`);
    if (!data) {
      console.log("Cursor        (not created)");
      return;
    }
    console.log(`Cursor        ${data.last_processed_block}`);
    console.log(`Blocks behind ${Math.max(0, head - Number(data.last_processed_block))}`);
    console.log(`Fingerprint   ${data.contract_fingerprint === config.fingerprint ? "current" : "stale"}`);
    console.log(`Last run      ${data.last_run_at ?? "(never)"}`);
    console.log(`Last error    ${data.last_error ?? "(none)"}`);
  } finally {
    provider.destroy();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
