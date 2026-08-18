// Applies every tracked migration to the CI job's real Postgres service
// (see .github/workflows/ci.yml's `services.postgres` block) before the
// test suite runs. A separate script rather than an inline `tsx -e` in the
// workflow YAML: esbuild's cjs output (what `tsx -e` uses) rejects
// top-level `await`, and this needs one.
import { getPool } from "../src/kernel/state/db.js";
import { runMigrations, ALL_MIGRATIONS } from "../src/kernel/state/migrations/index.js";

async function main() {
  await runMigrations(getPool(), ALL_MIGRATIONS);
  console.log(`Applied ${ALL_MIGRATIONS.length} migration(s).`);
  process.exit(0);
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
