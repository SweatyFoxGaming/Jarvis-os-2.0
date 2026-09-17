import type { Pool, PoolClient } from "pg";
import { ObservationPlatform } from "../../observation.js";

const observation = ObservationPlatform.getInstance();

/**
 * Real migration discipline, replacing "add another ALTER TABLE ... ADD
 * COLUMN IF NOT EXISTS line to createSchema()" as the pattern for schema
 * changes (see db.ts's own comment on createSchema — that function is now
 * the frozen baseline every fresh install and every existing deployment
 * already has; it is not where new tables/columns get added anymore).
 *
 * Deliberately minimal — no down-migrations, no CLI, no templating. Each
 * migration is a plain function run once, in declared order, inside its own
 * transaction, tracked by id in `schema_migrations`. That's enough to solve
 * the actual problem (schema changes need a record of what ran and when,
 * and must never silently re-run or run out of order) without building a
 * general-purpose migration tool this single-deployment-per-checkout
 * project doesn't need.
 */
export interface Migration {
  // Sortable, unique, and permanent once shipped — never renamed or reused,
  // even if the migration is later found to be wrong (fix it with a new
  // migration, the way you'd fix any other shipped mistake).
  id: string;
  description: string;
  up: (client: PoolClient) => Promise<void>;
}

// Pure and DB-free on purpose — this is the actual logic worth a unit test
// (declaration order preserved, already-applied ids excluded), independent
// of whether a live Postgres is reachable, matching every other pure-logic
// test in this codebase.
export function computePendingMigrations(all: Migration[], appliedIds: ReadonlySet<string>): Migration[] {
  return all.filter((m) => !appliedIds.has(m.id));
}

export async function runMigrations(pool: Pool, migrations: Migration[]): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  const { rows } = await pool.query<{ id: string }>(`SELECT id FROM schema_migrations`);
  const applied = new Set(rows.map((r) => r.id));
  const pending = computePendingMigrations(migrations, applied);

  for (const migration of pending) {
    // A fresh connection per migration (not the pool's default query path)
    // so each one gets its own real transaction — a migration that touches
    // two statements (e.g. CREATE TABLE + CREATE UNIQUE INDEX) must not be
    // left half-applied if the second statement fails.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await migration.up(client);
      await client.query(`INSERT INTO schema_migrations (id) VALUES ($1)`, [migration.id]);
      await client.query("COMMIT");
      observation.logTelemetry("info", "Database", `Applied migration "${migration.id}": ${migration.description}`);
    } catch (err: any) {
      await client.query("ROLLBACK").catch(() => {});
      observation.logTelemetry("error", "Database", `Migration "${migration.id}" failed: ${err.message}`);
      // Stop entirely rather than continue to the next migration — a later
      // migration may assume this one's schema change already landed.
      throw err;
    } finally {
      client.release();
    }
  }
}
