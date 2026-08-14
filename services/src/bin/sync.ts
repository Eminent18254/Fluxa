#!/usr/bin/env tsx
import { indexerConfig } from "../config.js";
import { sync } from "../indexer.js";
import { hasSupabaseCredentials, serviceClient } from "../supabase.js";

/**
 * `npm run sync` — keep Supabase level with the chain.
 *
 * Flags, read from argv because Hardhat is not involved here and there is no
 * task runner to argue with:
 *
 *   --once     one catch-up pass, then exit. What CI and a cron job want.
 *   --reset    start again from the deployment block. Idempotent writes make
 *              this safe; it is the recovery path after a redeploy.
 *   --network  which deployment record to follow. Defaults to FLUXA_NETWORK,
 *              then coston2.
 */

const argv = process.argv.slice(2);
const flag = (name: string): boolean => argv.includes(`--${name}`);

function option(name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`--${name} needs a value`);
  }
  return value;
}

async function main(): Promise<void> {
  const network = option("network") ?? process.env.FLUXA_NETWORK ?? "coston2";

  if (!hasSupabaseCredentials()) {
    // Named separately from any other failure, because this one is not a bug and
    // has a specific fix. The reducer that decides every write in this service
    // is covered by `npm test`, which needs no credentials at all.
    console.error(
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are not set.\n\n" +
        "  1. Create a project at https://supabase.com\n" +
        "  2. Run database/migrations/0001..0004 in the SQL editor, in order\n" +
        "  3. Copy Project URL and the service_role key into .env at the repo root\n\n" +
        "The service_role key bypasses Row Level Security. Keep it out of the\n" +
        "frontend and out of commits.\n\n" +
        "To exercise the chain-to-database mapping without credentials:\n" +
        "  npm run verify:mapping -- --network localhost",
    );
    process.exitCode = 1;
    return;
  }

  const config = indexerConfig(network, (message) => console.warn(`warning: ${message}`));

  console.log(`network      ${config.network} (chain ${config.chainId})`);
  console.log(`rpc          ${config.rpcUrl}`);
  console.log(`invoice      ${config.addresses.invoice}`);
  console.log(`settlement   ${config.addresses.settlement}`);
  console.log(`rail         ${config.addresses.rail ?? "(not deployed)"}`);
  console.log(`fingerprint  ${config.fingerprint}`);
  console.log(`tokens       ${[...config.tokens.values()].join(", ") || "(none)"}`);
  console.log("");

  const db = serviceClient();
  const summaries = await sync(db, config, {
    once: flag("once"),
    reset: flag("reset"),
    log: (message) => console.log(message),
  });

  const totals = summaries.reduce(
    (acc, s) => ({
      events: acc.events + s.eventsSeen,
      applied: acc.applied + s.applied,
      skipped: acc.skipped + s.skipped,
      errors: acc.errors + s.warnings.filter((w) => w.severity === "error").length,
    }),
    { events: 0, applied: 0, skipped: 0, errors: 0 },
  );

  console.log(
    `\n${totals.events} events, ${totals.applied} writes applied, ` +
      `${totals.skipped} skipped, ${totals.errors} errors`,
  );

  // A skipped payment means money moved with nowhere to record it. Exiting
  // non-zero is how a cron job or CI step finds out.
  if (totals.errors > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
