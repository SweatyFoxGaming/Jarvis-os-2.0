// Brings up the CI job's real Postgres service (see .github/workflows/
// ci.yml's `services.postgres` block) to the same state a real deployment
// reaches at boot, before the test suite runs. Calls initDatabase() itself
// rather than reimplementing its sequence -- an earlier version of this
// script called runMigrations() directly and skipped createSchema(),
// which migration 001 (and others) assume already ran: it references
// build_requests, a table createSchema() owns, not any migration. A
// separate script rather than an inline `tsx -e` in the workflow YAML:
// esbuild's cjs output (what `tsx -e` uses) rejects top-level `await`, and
// this needs one.
import { initDatabase } from "../src/kernel/state/db.js";

async function main() {
  const ready = await initDatabase();
  if (!ready) {
    console.error("initDatabase() returned false — Postgres never became ready.");
    process.exit(1);
  }
  console.log("Database schema and migrations applied.");
  process.exit(0);
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
