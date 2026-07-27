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
 * at a real, disposable/empty database to actually exercise these — and
 * see assertSafeToRunDestructiveTests() below for the two gates (an
 * explicit opt-in env var, plus proof the database is actually empty) that
 * make a reachable-but-wrong database a hard failure instead of quietly
 * running destructive operations against it.
 */
import { pingDatabase, initDatabase, getPool } from "../src/kernel/state/db.js";
import { runMigrations, ALL_MIGRATIONS } from "../src/kernel/state/migrations/index.js";
import { createUser, verifyCredentials, UsernameTakenError, ReservedUsernameError } from "../src/kernel/state/users-repo.js";
import { appendMessage, loadRecentHistory, pruneOldMessages } from "../src/kernel/state/session-repo.js";
import { proposeMcpServer, McpServerNameTakenError } from "../src/kernel/state/mcp-servers-repo.js";
import { upsertEntity, searchEntities, listAllEntities } from "../src/kernel/state/knowledge-graph-repo.js";
import { addSelfReflection, getRecentSelfReflections } from "../src/kernel/state/identity-repo.js";

// pruneOldMessages(0) below deletes every row in conversation_history with
// created_at < now() — not scoped to this test's own user, because the real
// function it's testing isn't scoped that way either (it's a global
// retention sweep). Reachability alone (pingDatabase()) says nothing about
// whether POSTGRES_HOST/PORT/USER/PASSWORD/DB happen to point at a real,
// populated database instead of a disposable one — someone with the live
// app's env already exported in their shell running `npm run test:db` out
// of curiosity would otherwise silently wipe every real user's conversation
// history. Two independent gates before anything destructive runs:
// (1) an explicit, unusual-on-purpose opt-in env var (not just "=1", which
// is too easy to have already set for something unrelated), and (2) proof
// the target database is actually empty of pre-existing data, not just
// reachable — so even a mistaken opt-in against the wrong database still
// refuses to proceed.
const CONFIRM_ENV_VAR = "DB_INTEGRATION_TEST_CONFIRM";
const REQUIRED_CONFIRM_VALUE = "i-accept-data-loss-in-this-database";

async function assertSafeToRunDestructiveTests(): Promise<void> {
  if (process.env[CONFIRM_ENV_VAR] !== REQUIRED_CONFIRM_VALUE) {
    throw new Error(
      `Refusing to run: this suite runs destructive, unscoped operations (e.g. deleting every row in ` +
        `conversation_history) against whatever database POSTGRES_HOST/PORT/USER/PASSWORD/DB point at. ` +
        `Set ${CONFIRM_ENV_VAR}=${REQUIRED_CONFIRM_VALUE} only once you're certain that database is disposable.`
    );
  }

  const db = getPool();
  for (const table of ["users", "conversation_history", "mcp_servers"]) {
    try {
      const { rows } = await db.query(`SELECT COUNT(*)::int AS n FROM ${table}`);
      if (rows[0].n > 0) {
        throw new Error(
          `Refusing to run: table "${table}" already has ${rows[0].n} row(s) — this database doesn't look ` +
            `disposable/empty, even though ${CONFIRM_ENV_VAR} is set. Point this at a truly fresh database instead.`
        );
      }
    } catch (err: any) {
      // Postgres error code 42P01 = "relation does not exist" — expected
      // and safe on a genuinely fresh database that initDatabase() hasn't
      // touched yet. Any other failure (a real connectivity/permission
      // error) must not be swallowed as if it meant "table's empty."
      if (err.code !== "42P01") throw err;
    }
  }
}

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

// Best-effort, independent per statement: this suite's own
// assertSafeToRunDestructiveTests() requires an empty database on every
// run, so leftover rows from a prior run (a real failure part-way through,
// or someone Ctrl-C'ing a run) would otherwise lock out every future run
// against the same (reused, non-CI-disposable) database until manually
// cleared. api_keys cascades on the users delete (see db.ts's schema), so
// deleting the user row is enough there.
async function cleanupTestData(): Promise<void> {
  const db = getPool();
  await db.query(`DELETE FROM users WHERE username = $1`, [`db_it_user_${RUN_ID}`]).catch(() => {});
  await db.query(`DELETE FROM conversation_history WHERE username = $1`, [`db_it_session_${RUN_ID}`]).catch(() => {});
  await db.query(`DELETE FROM mcp_servers WHERE name = $1`, [`db_it_mcp_${RUN_ID}`]).catch(() => {});
  await db.query(`DELETE FROM kg_entities WHERE username IN ($1, $2)`, [`db_it_kg_a_${RUN_ID}`, `db_it_kg_b_${RUN_ID}`]).catch(() => {});
  await db.query(`DELETE FROM self_reflections WHERE username IN ($1, $2)`, [`db_it_refl_a_${RUN_ID}`, `db_it_refl_b_${RUN_ID}`]).catch(() => {});
}

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

registerTest("knowledge-graph-repo: entities are scoped per username — one user's search/list never surfaces another's", async () => {
  const userA = `db_it_kg_a_${RUN_ID}`;
  const userB = `db_it_kg_b_${RUN_ID}`;

  await upsertEntity(userA, "SharedName", "project");
  await upsertEntity(userB, "SharedName", "project");

  // Same (name, entity_type) for both users must coexist as two distinct
  // rows — this is exactly what the (username, name, entity_type) unique
  // constraint (migration 004) replaces the old global (name, entity_type)
  // constraint with. If scoping were broken, the second upsertEntity would
  // have just updated user A's row instead of inserting a second one.
  const aResults = await searchEntities(userA, "SharedName");
  const bResults = await searchEntities(userB, "SharedName");
  if (aResults.length !== 1 || bResults.length !== 1) {
    throw new Error(`expected exactly one match per user, got ${aResults.length} for A and ${bResults.length} for B`);
  }
  if (aResults[0].id === bResults[0].id) {
    throw new Error("user A and user B's searchEntities returned the same row — entities are not actually scoped per user");
  }

  const aList = await listAllEntities(userA);
  if (aList.some(e => e.username !== userA)) {
    throw new Error(`listAllEntities(userA) returned a row belonging to a different username: ${JSON.stringify(aList)}`);
  }
});

registerTest("identity-repo: self-reflections are scoped per username — one user's history never leaks into another's", async () => {
  const userA = `db_it_refl_a_${RUN_ID}`;
  const userB = `db_it_refl_b_${RUN_ID}`;

  await addSelfReflection(userA, "opinion", "User A's private opinion, never meant for user B");
  await addSelfReflection(userB, "commitment", "User B's own commitment");

  const aReflections = await getRecentSelfReflections(userA);
  const bReflections = await getRecentSelfReflections(userB);

  if (aReflections.length !== 1 || aReflections[0].content !== "User A's private opinion, never meant for user B") {
    throw new Error(`getRecentSelfReflections(userA) returned unexpected content: ${JSON.stringify(aReflections)}`);
  }
  // Asserting user B's own reflection came back correctly (not just that
  // user A's didn't leak in) matters here: a scoping bug that returned an
  // empty array for every username would otherwise pass the leak check
  // below trivially, while actually being just as broken.
  if (bReflections.length !== 1 || bReflections[0].content !== "User B's own commitment") {
    throw new Error(`getRecentSelfReflections(userB) returned unexpected content: ${JSON.stringify(bReflections)}`);
  }
  if (bReflections.some(r => r.content.includes("User A's private opinion"))) {
    throw new Error("user B's self-reflection history leaked user A's content — the privacy bug this migration exists to fix");
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

  // Deliberately a hard failure, not a skip: reachable-but-unsafe must be
  // impossible to mistake for "ran fine" or "not applicable here."
  await assertSafeToRunDestructiveTests();

  let passedCount = 0;
  const results: { name: string; passed: boolean; error?: string }[] = [];
  try {
    for (const t of tests) {
      try {
        await t.fn();
        results.push({ name: t.name, passed: true });
        passedCount++;
      } catch (err: any) {
        results.push({ name: t.name, passed: false, error: err.message || String(err) });
      }
    }
  } finally {
    // Runs regardless of pass/fail — a CI job's disposable Postgres service
    // container doesn't need this (it's thrown away either way), but
    // assertSafeToRunDestructiveTests()'s own emptiness check means anyone
    // running this repeatedly against a real, reused local database would
    // otherwise be permanently locked out by the previous run's own leftover
    // rows. Independent best-effort deletes, not one failing statement
    // blocking the rest: a partial cleanup is still strictly better than none.
    await cleanupTestData();
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
