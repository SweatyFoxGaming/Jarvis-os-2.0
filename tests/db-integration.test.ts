/**
 * Real-schema DB integration tests — everything in tests/index.test.ts
 * (npm test) specifically exercises the "Postgres unreachable" degrade
 * path, so it deliberately runs with no live database. This file is the
 * other half: it needs a real, reachable Postgres to mean anything, so it
 * lives in its own process/entry point (npm run test:db) rather than being
 * folded into index.test.ts — sharing one process would mean whichever file
 * calls getPool() first locks in that connection config for every test in
 * the whole run (db.ts's pool is a lazy module-level singleton), which
 * would silently break every "degrades cleanly" assertion in the main
 * suite the moment these tests also ran against a real database.
 *
 * Skips (not fails) when no Postgres is reachable — this keeps `npm run
 * test:db` safe to invoke in any environment, including the current CI
 * pipeline, which has no Postgres service wired up yet. Point
 * POSTGRES_HOST/POSTGRES_PORT/POSTGRES_USER/POSTGRES_PASSWORD/POSTGRES_DB
 * at a real (ideally disposable) database to actually exercise these.
 */
import { pingDatabase, initDatabase, getPool } from "../src/kernel/state/db.js";
import { runMigrations, ALL_MIGRATIONS } from "../src/kernel/state/migrations/index.js";
import { createUser, verifyCredentials, UsernameTakenError, ReservedUsernameError } from "../src/kernel/state/users-repo.js";
import { appendMessage, loadRecentHistory, pruneOldMessages } from "../src/kernel/state/session-repo.js";
import { proposeMcpServer, McpServerNameTakenError } from "../src/kernel/state/mcp-servers-repo.js";

interface TestDef {
  name: string;
  fn: () => Promise<void>;
}

const tests: TestDef[] = [];
function registerTest(name: string, fn: () => Promise<void>): void {
  tests.push({ name, fn });
}

// A fresh random suffix per run avoids collisions between repeated runs
// against a persistent (non-disposable) database someone points this at.
const RUN_ID = process.pid.toString(36) + "_" + process.hrtime.bigint().toString(36);

registerTest("initDatabase() creates the full schema and applies every migration cleanly", async () => {
  const ok = await initDatabase(1, 0);
  if (!ok) throw new Error("initDatabase() returned false against a live, reachable Postgres");

  const db = getPool();
  const { rows } = await db.query(`SELECT id FROM schema_migrations ORDER BY id`);
  const appliedIds = new Set(rows.map((r: any) => r.id));
  for (const m of ALL_MIGRATIONS) {
    if (!appliedIds.has(m.id)) {
      throw new Error(`migration "${m.id}" was not recorded as applied`);
    }
  }

  // Re-running must be a clean no-op — this is the actual guarantee the
  // "never re-run, never run out of order" comment in runner.ts promises,
  // and nothing in the unit-tested computePendingMigrations logic (pure,
  // no DB) proves it holds against a real schema_migrations table.
  await runMigrations(db, ALL_MIGRATIONS);
});

registerTest("createUser + verifyCredentials round-trip for real, and rejects a duplicate/reserved username", async () => {
  const username = `db_it_user_${RUN_ID}`;
  const apiKey = await createUser(username, "correct horse battery staple");
  if (!apiKey || !apiKey.startsWith("jarvis_key_")) {
    throw new Error(`createUser returned an unexpected api key: ${JSON.stringify(apiKey)}`);
  }

  if (!(await verifyCredentials(username, "correct horse battery staple"))) {
    throw new Error("verifyCredentials rejected the exact password just used to create the account");
  }
  if (await verifyCredentials(username, "wrong password")) {
    throw new Error("verifyCredentials accepted an incorrect password");
  }

  let threw = false;
  try {
    await createUser(username, "some other password");
  } catch (err) {
    threw = err instanceof UsernameTakenError;
  }
  if (!threw) throw new Error("createUser did not throw UsernameTakenError for a real duplicate username");

  let reservedThrew = false;
  try {
    await createUser("admin", "irrelevant");
  } catch (err) {
    reservedThrew = err instanceof ReservedUsernameError;
  }
  if (!reservedThrew) throw new Error("createUser did not throw ReservedUsernameError for \"admin\"");
});

registerTest("session-repo: real messages persist, load back in order, and pruneOldMessages actually deletes them", async () => {
  const username = `db_it_session_${RUN_ID}`;
  await appendMessage(username, "user", "hello from a real integration test");
  await appendMessage(username, "assistant", "hello back");

  const history = await loadRecentHistory(username);
  if (history.length !== 2 || history[0].content !== "hello from a real integration test" || history[1].content !== "hello back") {
    throw new Error(`loadRecentHistory returned unexpected content/order: ${JSON.stringify(history)}`);
  }

  // retentionDays=0 -> "created_at < now()" at DELETE time, which both rows
  // inserted moments ago already satisfy — this is what actually exercises
  // the retention job's real DELETE against real rows, not just its
  // no-DB-degrades-to-0 fallback (already covered in tests/index.test.ts).
  const pruned = await pruneOldMessages(0);
  if (pruned < 2) {
    throw new Error(`pruneOldMessages(0) reported pruning ${pruned} row(s), expected at least the 2 just inserted`);
  }
  const afterPrune = await loadRecentHistory(username);
  if (afterPrune.length !== 0) {
    throw new Error(`expected pruneOldMessages(0) to remove all of this user's history, ${afterPrune.length} row(s) remain`);
  }
});

registerTest("mcp-servers-repo: proposeMcpServer rejects a real duplicate name with a clean error, not a raw Postgres constraint error", async () => {
  const name = `db_it_mcp_${RUN_ID}`;
  const first = await proposeMcpServer(name, "http://example.invalid/mcp", "admin");
  if (first.name !== name) throw new Error(`unexpected row returned from the first insert: ${JSON.stringify(first)}`);

  let threw = false;
  let message = "";
  try {
    await proposeMcpServer(name, "http://example.invalid/mcp-2", "admin");
  } catch (err: any) {
    threw = err instanceof McpServerNameTakenError;
    message = err.message || "";
  }
  if (!threw) throw new Error("proposeMcpServer did not throw McpServerNameTakenError for a real duplicate name");
  if (message.toLowerCase().includes("constraint") || message.toLowerCase().includes("duplicate key")) {
    throw new Error(`McpServerNameTakenError's message still looks like a raw Postgres error: "${message}"`);
  }
});

async function main(): Promise<void> {
  const reachable = await pingDatabase();
  if (!reachable) {
    console.log(
      "\n[db-integration] No reachable Postgres (POSTGRES_HOST/PORT/USER/PASSWORD/DB) — " +
        "skipping all DB integration tests. This is expected in the default dev/CI environment; " +
        "point those env vars at a real database to actually run this suite.\n"
    );
    return;
  }

  let passedCount = 0;
  const results: { name: string; passed: boolean; error?: string }[] = [];
  for (const t of tests) {
    try {
      await t.fn();
      results.push({ name: t.name, passed: true });
      passedCount++;
    } catch (err: any) {
      results.push({ name: t.name, passed: false, error: err.message || String(err) });
    }
  }

  console.log("\n=====================================================");
  results.forEach(r => {
    if (r.passed) {
      console.log(`✅ [PASSED] ${r.name}`);
    } else {
      console.log(`❌ [FAILED] ${r.name}`);
      console.log(`    Error: ${r.error}`);
    }
  });
  console.log("=====================================================");
  console.log(`TOTALS: ${passedCount} / ${results.length} DB integration tests passed.`);
  console.log("=====================================================");

  const failed = results.length === 0 || passedCount < results.length;
  // Explicit exit, not a natural return: pingDatabase()'s own healthPool has
  // a 10s idleTimeoutMillis and would otherwise keep this short-lived CLI
  // script alive for up to that long after the last query, waiting on a
  // connection nothing here still needs.
  await getPool().end().catch(() => {});
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal DB integration test error:", err);
  process.exit(1);
});
