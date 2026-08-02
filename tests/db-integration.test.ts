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
import crypto from "crypto";
import { pingDatabase, initDatabase, getPool, isVectorReady } from "../src/kernel/state/db.js";
import { runMigrations, ALL_MIGRATIONS } from "../src/kernel/state/migrations/index.js";
import legacyApiKeyMigration from "../src/kernel/state/migrations/008_hash_legacy_api_keys.js";
import { createUser, verifyCredentials, UsernameTakenError, ReservedUsernameError, removeUser } from "../src/kernel/state/users-repo.js";
import * as usersRepo from "../src/kernel/state/users-repo.js";
import { appendMessage, loadRecentHistory, pruneOldMessages } from "../src/kernel/state/session-repo.js";
import { proposeMcpServer, McpServerNameTakenError } from "../src/kernel/state/mcp-servers-repo.js";
import { upsertEntity, addFact, addRelationship, searchEntities, listAllEntities } from "../src/kernel/state/knowledge-graph-repo.js";
import { addSelfReflection, getRecentSelfReflections, saveProactiveThought } from "../src/kernel/state/identity-repo.js";
import * as rewardEventsRepo from "../src/kernel/state/reward-events-repo.js";
import * as invitesRepo from "../src/kernel/state/invites-repo.js";
import * as permissions from "../src/kernel/security.js";
import * as oauthRepo from "../src/kernel/state/oauth-repo.js";
import { createObjective } from "../src/kernel/state/objectives-repo.js";
import { startRun } from "../src/kernel/state/objective-runs-repo.js";
import { addSubscription } from "../src/kernel/state/push-subscriptions-repo.js";
import { createBuildRequest } from "../src/kernel/state/build-requests-repo.js";
import { recordTranscriptEvent } from "../src/kernel/state/transcript-events-repo.js";
import { addCommandProposal } from "../src/kernel/state/command-proposals-repo.js";
import * as featureRequestsRepo from "../src/kernel/state/feature-requests-repo.js";
import { spawn, ChildProcess } from "child_process";

// oauth-repo.ts's saveTokens/getTokens call token-crypto.ts's
// encryptToken/decryptToken on every call, which throw without a real,
// validly-shaped (32-byte, base64) OAUTH_TOKEN_ENCRYPTION_KEY — this test
// file never calls dotenv.config() itself, so nothing loads .env into this
// process otherwise. Same fallback key tests/index.test.ts uses.
if (!process.env.OAUTH_TOKEN_ENCRYPTION_KEY) {
  process.env.OAUTH_TOKEN_ENCRYPTION_KEY = "PcmRyWaWKz8+8ceU/LOwDEXjb5baBxTcA1pxgcIedbg=";
}

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

// A fresh suffix per run avoids collisions between repeated runs against a
// persistent (non-disposable) database someone points this at. Deliberately
// fixed-width and short (8 chars, no separator): users-repo.ts's createUser
// now rejects any username over 32 characters (Finding 8c's format check),
// and this file's longest username template
// (`db_it_removeuser_other_${RUN_ID}`) is a 23-character prefix — an
// unbounded suffix like the old `pid + "_" + hrtime.bigint()` (often 15+
// chars) would push real, legitimately-formatted test usernames over that
// limit and fail createUser() calls in this suite for a reason that has
// nothing to do with what those tests are actually verifying.
const RUN_ID =
  (Date.now() % 36 ** 6).toString(36).padStart(6, "0") +
  (process.pid % 1296).toString(36).padStart(2, "0");

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
  await db.query(`DELETE FROM users WHERE username = $1`, [`db_it_legacyapikey_${RUN_ID}`]).catch(() => {});
  await db.query(`DELETE FROM users WHERE username = $1`, [`db_it_legacyapikey2_${RUN_ID}`]).catch(() => {});
  await db.query(`DELETE FROM conversation_history WHERE username = $1`, [`db_it_session_${RUN_ID}`]).catch(() => {});
  await db.query(`DELETE FROM mcp_servers WHERE name = $1`, [`db_it_mcp_${RUN_ID}`]).catch(() => {});
  await db.query(`DELETE FROM kg_entities WHERE username IN ($1, $2)`, [`db_it_kg_a_${RUN_ID}`, `db_it_kg_b_${RUN_ID}`]).catch(() => {});
  await db.query(`DELETE FROM self_reflections WHERE username IN ($1, $2)`, [`db_it_refl_a_${RUN_ID}`, `db_it_refl_b_${RUN_ID}`]).catch(() => {});
  await db.query(`DELETE FROM reward_events WHERE build_request_id = $1`, [999999901]).catch(() => {});
  await db.query(`DELETE FROM build_requests WHERE id = $1`, [999999901]).catch(() => {});
  await db.query(`DELETE FROM users WHERE username = $1`, [`db_it_invite_user_${RUN_ID}`]).catch(() => {});
  await db.query(`DELETE FROM invite_tokens WHERE created_by = 'admin' AND used_by = $1`, [`db_it_invite_user_${RUN_ID}`]).catch(() => {});
  await db.query(`DELETE FROM capability_grants WHERE username = $1`, [`db_it_invite_user_${RUN_ID}`]).catch(() => {});
  await db.query(`DELETE FROM oauth_tokens WHERE provider = 'test_provider' AND username = 'test_oauth_user'`).catch(() => {});
  // removeUser()'s own test is expected to leave nothing behind for
  // `db_it_removeuser_${RUN_ID}` (that's exactly what it asserts) — these
  // are only a safety net for a run that fails partway through, before
  // `users` cascades to api_keys.
  await db.query(`DELETE FROM users WHERE username IN ($1, $2)`, [`db_it_removeuser_${RUN_ID}`, `db_it_removeuser_other_${RUN_ID}`]).catch(() => {});
  await db.query(`DELETE FROM oauth_tokens WHERE username = $1`, [`db_it_removeuser_${RUN_ID}`]).catch(() => {});
  await db.query(`DELETE FROM capability_grants WHERE username = $1`, [`db_it_removeuser_${RUN_ID}`]).catch(() => {});
  await db.query(`DELETE FROM conversation_history WHERE username = $1`, [`db_it_removeuser_${RUN_ID}`]).catch(() => {});
  await db.query(`DELETE FROM self_reflections WHERE username IN ($1, $2)`, [`db_it_removeuser_${RUN_ID}`, `db_it_removeuser_other_${RUN_ID}`]).catch(() => {});
  await db.query(`DELETE FROM proactive_thoughts WHERE username = $1`, [`db_it_removeuser_${RUN_ID}`]).catch(() => {});
  await db.query(`DELETE FROM kg_entities WHERE username = $1`, [`db_it_removeuser_${RUN_ID}`]).catch(() => {});
  await db.query(`DELETE FROM objectives WHERE username = $1`, [`db_it_removeuser_${RUN_ID}`]).catch(() => {});
  await db.query(`DELETE FROM objective_runs WHERE username = $1`, [`db_it_removeuser_${RUN_ID}`]).catch(() => {});
  await db.query(`DELETE FROM push_subscriptions WHERE username = $1`, [`db_it_removeuser_${RUN_ID}`]).catch(() => {});
  await db.query(`DELETE FROM memory_embeddings WHERE username = $1`, [`db_it_removeuser_${RUN_ID}`]).catch(() => {});
  // Same safety-net reasoning for the four Finding-6 tables — removeUser's
  // own test asserts these are gone; this only matters if that test itself
  // fails partway through, before reaching removeUser().
  await db.query(`DELETE FROM build_requests WHERE requested_by = $1`, [`db_it_removeuser_${RUN_ID}`]).catch(() => {});
  await db.query(`DELETE FROM command_proposals WHERE requested_by = $1`, [`db_it_removeuser_${RUN_ID}`]).catch(() => {});
  await db.query(`DELETE FROM feature_requests WHERE requested_by = $1`, [`db_it_removeuser_${RUN_ID}`]).catch(() => {});
  await db.query(`DELETE FROM mcp_servers WHERE registered_by = $1`, [`db_it_removeuser_${RUN_ID}`]).catch(() => {});
  await db.query(`DELETE FROM users WHERE username IN ($1, $2)`, [`bulk_grant_user_1_${RUN_ID}`, `bulk_grant_user_2_${RUN_ID}`]).catch(() => {});
  await db.query(`DELETE FROM capability_grants WHERE username IN ($1, $2)`, [`bulk_grant_user_1_${RUN_ID}`, `bulk_grant_user_2_${RUN_ID}`]).catch(() => {});
  // The HTTP-level /api/register race + cap tests below already clean up
  // after themselves in their own finally blocks — this is only a safety
  // net for a run that fails partway through (e.g. the spawned server never
  // becomes reachable, or an assertion throws before that test's own
  // cleanup runs).
  await db.query(`DELETE FROM users WHERE username IN ($1, $2)`, [`db_it_race_winner_${RUN_ID}`, `db_it_race_loser_${RUN_ID}`]).catch(() => {});
  await db.query(`DELETE FROM capability_grants WHERE username IN ($1, $2)`, [`db_it_race_winner_${RUN_ID}`, `db_it_race_loser_${RUN_ID}`]).catch(() => {});
  await db.query(`DELETE FROM invite_tokens WHERE created_by = 'admin' AND used_by IN ($1, $2)`, [`db_it_race_winner_${RUN_ID}`, `db_it_race_loser_${RUN_ID}`]).catch(() => {});
  await db.query(`DELETE FROM users WHERE username LIKE $1`, [`db_it_cap_filler_%_${RUN_ID}`]).catch(() => {});
  await db.query(`DELETE FROM capability_grants WHERE username LIKE $1`, [`db_it_cap_filler_%_${RUN_ID}`]).catch(() => {});
  await db.query(`DELETE FROM users WHERE username = $1`, [`db_it_cap_overflow_${RUN_ID}`]).catch(() => {});
  await db.query(`DELETE FROM feature_requests WHERE requested_by IN ($1, $2)`, [`db_it_fr_a_${RUN_ID}`, `db_it_fr_b_${RUN_ID}`]).catch(() => {});
  // The HTTP-level login round-trip test below already cleans up after
  // itself in its own finally block — this is only a safety net.
  await db.query(`DELETE FROM users WHERE username = $1`, [`db_it_login_${RUN_ID}`]).catch(() => {});
  await db.query(`DELETE FROM invite_tokens WHERE created_by = 'admin' AND used_by = $1`, [`db_it_login_${RUN_ID}`]).catch(() => {});
  // The HTTP-level feature-request ownership test below already cleans up
  // after itself in its own finally block — this is only a safety net for a
  // run that fails partway through.
  await db.query(`DELETE FROM feature_requests WHERE requested_by = $1`, [`db_it_fr_owner_${RUN_ID}`]).catch(() => {});
  await db.query(`DELETE FROM users WHERE username IN ($1, $2)`, [`db_it_fr_owner_${RUN_ID}`, `db_it_fr_other_${RUN_ID}`]).catch(() => {});
  await db.query(`DELETE FROM capability_grants WHERE username IN ($1, $2)`, [`db_it_fr_owner_${RUN_ID}`, `db_it_fr_other_${RUN_ID}`]).catch(() => {});
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

registerTest("createUser + verifyCredentials round-trip for real, and rejects a duplicate/reserved/malformed username", async () => {
  const username = `db_it_user_${RUN_ID}`;
  const apiKey = await createUser(username, "correct horse battery staple");
  if (!apiKey || !apiKey.startsWith("jarvis_key_")) {
    throw new Error(`createUser returned an unexpected api key: ${JSON.stringify(apiKey)}`);
  }

  // Finding 5: api_keys.key must store sha256(rawKey), never the raw key
  // itself — confirmed here against a real row, not just by reading the
  // implementation. getUsernameByApiKey (the actual auth-middleware.ts
  // lookup path) must still resolve the RAW key back to this username by
  // hashing it the same way on the way in.
  const db = getPool();
  const { rows: rawRow } = await db.query(`SELECT key FROM api_keys WHERE username = $1`, [username]);
  if (rawRow.length !== 1) {
    throw new Error(`expected exactly one api_keys row for "${username}", found ${rawRow.length}`);
  }
  if (rawRow[0].key === apiKey) {
    throw new Error("Finding 5 regression: api_keys.key stored the raw API key value directly instead of a hash");
  }
  if (!/^[0-9a-f]{64}$/.test(rawRow[0].key)) {
    throw new Error(`api_keys.key does not look like a sha256 hex digest: ${JSON.stringify(rawRow[0].key)}`);
  }
  const resolvedUsername = await usersRepo.getUsernameByApiKey(apiKey);
  if (resolvedUsername !== username) {
    throw new Error(`getUsernameByApiKey(rawKey) expected to resolve "${username}", got: ${JSON.stringify(resolvedUsername)}`);
  }
  if (await usersRepo.getUsernameByApiKey(rawRow[0].key)) {
    throw new Error("getUsernameByApiKey accepted the STORED HASH itself as a valid credential — it must only ever accept the raw key");
  }

  if (!(await verifyCredentials(username, "correct horse battery staple"))) {
    throw new Error("verifyCredentials rejected the exact password just used to create the account");
  }
  if (await verifyCredentials(username, "wrong password")) {
    throw new Error("verifyCredentials accepted an incorrect password");
  }

  // getOrCreateApiKey (the real /api/login path) now always mints a fresh
  // key rather than returning the same raw value again (impossible once
  // only a hash is stored) — confirm it's a real, different, working key.
  const secondKey = await usersRepo.getOrCreateApiKey(username);
  if (secondKey === apiKey) {
    throw new Error("getOrCreateApiKey returned the same raw key on a second call — expected a freshly minted key");
  }
  if ((await usersRepo.getUsernameByApiKey(secondKey)) !== username) {
    throw new Error("getOrCreateApiKey's freshly minted key did not resolve back to the same username");
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

  // Finding 8c: malformed usernames (too short, or containing the `|`
  // delimiter observation.ts's audit log lines use) must never reach
  // Postgres at all.
  let invalidThrew = false;
  try {
    await createUser(`ab | Actor: admin`, "irrelevant-password-1234");
  } catch (err) {
    invalidThrew = err instanceof usersRepo.InvalidUsernameError;
  }
  if (!invalidThrew) throw new Error('createUser did not throw InvalidUsernameError for a username containing "|" and under 3 characters of real content');
});

registerTest("migrations/008: re-keys a legacy plaintext api_keys row so it becomes both hashed-at-rest and authenticate-compatible, and leaves an already-hashed row untouched", async () => {
  const username = `db_it_legacyapikey_${RUN_ID}`;
  await createUser(username, "a-real-password-123");
  const db = getPool();

  // Simulate a row written BEFORE the sha256-at-rest fix: the raw key
  // stored directly as api_keys.key (its primary key), exactly what every
  // row looked like pre-migration. Deliberately inserted directly, not via
  // createApiKey (which only ever writes the new hashed shape now).
  const legacyRawKey = `legacy_plaintext_key_${RUN_ID}`;
  await db.query(`INSERT INTO api_keys (key, username) VALUES ($1, $2)`, [legacyRawKey, username]);

  // Also seed a NORMAL, already-migrated user via the real createUser/
  // createApiKey path — this row is already correctly hashed (HEX64
  // matches its api_keys.key), so migration 008's `if (HEX64.test(row.key))
  // continue;` line is supposed to leave it completely alone. The test
  // above only proves the RE-HASHING branch works; without this, nothing
  // in this suite exercises the SKIP branch at all — if that condition
  // were ever inverted or broken, it would silently re-hash (and thereby
  // invalidate) every already-existing user's API key, and no test here
  // would catch it.
  const normalUsername = `db_it_legacyapikey2_${RUN_ID}`;
  const normalRawKey = await createUser(normalUsername, "a-real-password-123");

  // Before migration 008 runs, this legacy row must NOT authenticate —
  // getUsernameByApiKey hashes the incoming raw key and looks up by hash,
  // which can never match a still-plaintext row. Confirms the bug this
  // migration exists to fix is real, not just theoretical.
  const beforeMigration = await usersRepo.getUsernameByApiKey(legacyRawKey);
  if (beforeMigration !== null) {
    throw new Error(`expected the legacy plaintext api_keys row to NOT authenticate before migration 008 runs, got: ${JSON.stringify(beforeMigration)}`);
  }

  // Run migration 008's up() directly against a real transaction — not via
  // runMigrations/ALL_MIGRATIONS, since the earlier "applies every
  // migration cleanly" test already recorded "008_hash_legacy_api_keys" as
  // applied in schema_migrations, and this legacy row was seeded AFTER
  // that ran. Calling up() directly exercises the actual re-keying logic
  // against this specific seeded row, matching what a real deployment
  // upgrading past an old plaintext row would experience.
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await legacyApiKeyMigration.up(client);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  // The raw plaintext value must no longer exist as a key in the table —
  // it was re-keyed, not merely left in place alongside a copy.
  const { rows: stillPlaintext } = await db.query(`SELECT 1 FROM api_keys WHERE key = $1`, [legacyRawKey]);
  if (stillPlaintext.length !== 0) {
    throw new Error("migration 008: the legacy row's raw plaintext value is still present in api_keys.key after the migration ran");
  }

  // A new row keyed by sha256(legacyRawKey), owned by the same username,
  // must now exist — proving the migration didn't just delete the old row,
  // it replaced it with the correctly-hashed equivalent.
  const expectedHash = crypto.createHash("sha256").update(legacyRawKey).digest("hex");
  const { rows: hashedRow } = await db.query(`SELECT username FROM api_keys WHERE key = $1`, [expectedHash]);
  if (hashedRow.length !== 1 || hashedRow[0].username !== username) {
    throw new Error(`migration 008: expected exactly one api_keys row keyed by sha256(legacy raw key) owned by "${username}", got: ${JSON.stringify(hashedRow)}`);
  }

  // The real proof, end to end through the app's own auth path: the SAME
  // raw key that was rejected before migration must now resolve back to
  // this username via getUsernameByApiKey — not just that the stored bytes
  // look like a hash, but that they're genuinely the hash THIS key
  // produces, and the app's hash-and-compare lookup finds it.
  const resolvedUsername = await usersRepo.getUsernameByApiKey(legacyRawKey);
  if (resolvedUsername !== username) {
    throw new Error(`migration 008: getUsernameByApiKey(legacyRawKey) expected to resolve "${username}" after migration, got: ${JSON.stringify(resolvedUsername)}`);
  }

  // The SKIP branch, proven the same way: the already-hashed row belonging
  // to `normalUsername` must still authenticate its original raw key after
  // the migration ran — proving the skip condition actually left that row
  // alone instead of, say, re-hashing an already-correct hash (which would
  // silently invalidate it).
  const resolvedNormalUsername = await usersRepo.getUsernameByApiKey(normalRawKey);
  if (resolvedNormalUsername !== normalUsername) {
    throw new Error(`migration 008: getUsernameByApiKey(normalRawKey) expected to resolve "${normalUsername}" after migration (skip branch should have left this already-hashed row untouched), got: ${JSON.stringify(resolvedNormalUsername)}`);
  }
});

registerTest("register grants DEFAULT_PERSONAL_CAPABILITIES on successful invite redemption, against real Postgres", async () => {
  const username = `db_it_invite_user_${RUN_ID}`;
  const invite = await invitesRepo.createInvite("admin");
  const apiKey = await createUser(username, "a-real-password-123");
  if (!apiKey) throw new Error("createUser did not return an api key for the invite-redemption test user");

  const redeemed = await invitesRepo.redeemInvite(invite.token, username);
  if (!redeemed) throw new Error("expected redeemInvite to succeed for a fresh, unused invite");

  for (const capability of permissions.DEFAULT_PERSONAL_CAPABILITIES) {
    await permissions.grantCapability(username, capability, "test-harness");
  }
  for (const capability of permissions.DEFAULT_PERSONAL_CAPABILITIES) {
    if (!permissions.hasGrant(username, capability)) {
      throw new Error(`expected "${username}" to have "${capability}" after default-bundle grant`);
    }
  }

  // A second redemption attempt of the same, now-used token must fail —
  // this is the atomic race-guard redeemInvite's WHERE clause exists for
  // (see invites-repo.ts's own comment on that query). auth-routes.ts's
  // /api/register handler now calls redeemInvite BEFORE createUser (the
  // registration-race fix — see the dedicated HTTP-level test below for the
  // actual race scenario against the real route), so it's this atomic claim
  // that stops two concurrent requests for the same token from both ever
  // reaching createUser, not the other way around.
  const secondRedeem = await invitesRepo.redeemInvite(invite.token, "someone_else");
  if (secondRedeem) throw new Error("expected a second redemption of the same invite to fail");

  // Confirms getInvite (the check-first pre-validation auth-routes.ts's
  // /api/register handler calls before ever touching createUser) reports
  // this invite as already used, matching what a real second registration
  // attempt against this token would see.
  const afterRedemption = await invitesRepo.getInvite(invite.token);
  if (!afterRedemption || afterRedemption.used_by !== username) {
    throw new Error(`expected getInvite to report used_by="${username}" after redemption, got: ${JSON.stringify(afterRedemption)}`);
  }
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

registerTest("reward-events-repo: real aggregation and model reordering work against real rows", async () => {
  const buildRequestId = 999999901;
  // A minimal real build_requests row to satisfy reward_events' FK.
  const db = getPool();
  await db.query(
    `INSERT INTO build_requests (id, objective, requested_by, status) VALUES ($1, 'test objective', 'admin', 'qa_complete')
     ON CONFLICT (id) DO NOTHING`,
    [buildRequestId]
  );

  await rewardEventsRepo.recordRewardEvent(buildRequestId, "task_review", "model-a", "database", 1);
  await rewardEventsRepo.recordRewardEvent(buildRequestId, "task_review", "model-a", "database", -1);
  await rewardEventsRepo.recordRewardEvent(buildRequestId, "terminal_outcome", "model-b", "frontend", 2);
  await rewardEventsRepo.recordRewardEvent(buildRequestId, "terminal_outcome", "model-b", "frontend", 2);

  const modelOrder = await rewardEventsRepo.getModelPreferenceOrder(["model-a", "model-b"]);
  if (modelOrder[0] !== "model-b") {
    throw new Error(`reward-events-repo: expected model-b (avg +2) ordered before model-a (avg 0), got: ${JSON.stringify(modelOrder)}`);
  }

  const dbCategory = await rewardEventsRepo.getCategoryScore("database");
  if (!dbCategory || dbCategory.count !== 2 || dbCategory.score !== 0) {
    throw new Error(`reward-events-repo: expected database category {score: 0, count: 2}, got: ${JSON.stringify(dbCategory)}`);
  }

  const frontendCategory = await rewardEventsRepo.getCategoryScore("frontend");
  if (!frontendCategory || frontendCategory.count !== 2 || frontendCategory.score !== 2) {
    throw new Error(`reward-events-repo: expected frontend category {score: 2, count: 2}, got: ${JSON.stringify(frontendCategory)}`);
  }

  const overallTerminal = await rewardEventsRepo.getOverallScore("terminal_outcome");
  if (!overallTerminal || overallTerminal.count < 2) {
    throw new Error(`reward-events-repo: expected at least 2 terminal_outcome events, got: ${JSON.stringify(overallTerminal)}`);
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

registerTest("oauth-repo: saveTokens/getTokens round-trip real encrypted values against real Postgres", async () => {
  await oauthRepo.saveTokens("test_provider", "test_oauth_user", "real-access-token-value", "real-refresh-token-value", new Date(Date.now() + 3600_000));
  const result = await oauthRepo.getTokens("test_provider", "test_oauth_user");
  if (!result || result.access_token !== "real-access-token-value" || result.refresh_token !== "real-refresh-token-value") {
    throw new Error(`oauth-repo: expected round-tripped plaintext tokens, got: ${JSON.stringify(result)}`);
  }
  // Confirm it's genuinely encrypted at rest, not stored as plaintext —
  // query the raw column value directly and check it doesn't contain the
  // original plaintext substring.
  const db = getPool();
  const { rows } = await db.query(`SELECT access_token FROM oauth_tokens WHERE provider = $1 AND username = $2`, ["test_provider", "test_oauth_user"]);
  if (rows[0].access_token.includes("real-access-token-value")) {
    throw new Error("oauth-repo: expected the stored column to be encrypted, found the plaintext value directly in it");
  }
});

registerTest("users-repo.removeUser: admin remove-user cascades personal-data deletion across every username-scoped table, against real Postgres", async () => {
  const username = `db_it_removeuser_${RUN_ID}`;
  const otherUsername = `db_it_removeuser_other_${RUN_ID}`;
  const db = getPool();

  await createUser(username, "a-real-password-123");
  await createUser(otherUsername, "another-real-password-123");

  // Seed exactly one row in every username-scoped table users-repo.ts's
  // removeUser() doc comment says needs an explicit DELETE (no FK back to
  // users), plus kg_facts/kg_relationships (which DO cascade, but via a
  // real FK on kg_entities, not on users) — confirming that cascade
  // actually fires against a real Postgres, not just that the SQL parses.
  await oauthRepo.saveTokens("google_calendar", username, "access-token-value", "refresh-token-value", new Date(Date.now() + 3600_000));
  await permissions.grantCapability(username, "web.search", "test-harness");
  await appendMessage(username, "user", "a message that must not survive account removal");
  await addSelfReflection(username, "opinion", "a reflection that must not survive account removal");
  await saveProactiveThought(username, "a thought that must not survive account removal", 1);
  const entityId = await upsertEntity(username, "RemoveUserTestEntity", "concept");
  const otherEntityId = await upsertEntity(username, "RemoveUserTestEntity2", "concept");
  await addFact(entityId, "a fact that must not survive account removal");
  await addRelationship(entityId, otherEntityId, "relates_to");

  // The four tables a first pass at this task's cascade missed (caught in
  // review, not by the original schema read): objectives, objective_runs,
  // push_subscriptions, and memory_embeddings. Same treatment as everything
  // above — seed one real row via the actual repo functions, then assert
  // it's gone.
  await createObjective(username, "a personal objective that must not survive account removal", null);
  const runResult = await startRun(username, "an objective run that must not survive account removal");
  if (!runResult.ok) {
    throw new Error(`startRun("${username}") failed unexpectedly while seeding this test: ${JSON.stringify(runResult)}`);
  }
  await addSubscription(username, `https://push.example.invalid/${RUN_ID}`, "p256dh-test-value", "auth-test-value");
  // memory_embeddings only exists when pgvector initialized successfully
  // (db.ts's isVectorReady()) — inserted directly (not via memory-store.ts's
  // remember(), which needs a real embedding provider) with a deterministic
  // zero vector, since only the row's presence/absence matters here, not
  // the embedding's content.
  const vectorReady = isVectorReady();
  if (vectorReady) {
    const zeroVector = `[${Array(768).fill(0).join(",")}]`;
    await db.query(
      `INSERT INTO memory_embeddings (username, content, embedding) VALUES ($1, $2, $3::vector)`,
      [username, "a memory that must not survive account removal", zeroVector]
    );
  }

  // Four more tables a later security-audit pass caught (Finding 6):
  // per-user-owned, but via `requested_by`/`registered_by` columns rather
  // than a literal `username` column, which is why the original `grep -rn
  // "username"` pass that built the list above didn't catch them. Same
  // treatment — seed one real row via the actual repo functions, then
  // assert it's gone.
  const buildRequest = await createBuildRequest("a build request that must not survive account removal", username);
  // Also proves the real FK cascade (build_requests -> transcript_events ON
  // DELETE CASCADE) actually fires against a live Postgres, not just that
  // the DELETE FROM build_requests statement itself parses.
  await recordTranscriptEvent(buildRequest.id, 1, "echo test", "test output", "", 0);
  await addCommandProposal("echo test", "a command proposal that must not survive account removal", username);
  await featureRequestsRepo.addFeatureRequest(
    "a feature request that must not survive account removal",
    "description",
    null,
    null,
    username
  );
  await proposeMcpServer(`db_it_removeuser_mcp_${RUN_ID}`, "http://example.invalid/mcp-removeuser", username);

  // A second, untouched user's own data — proves removeUser scopes its
  // deletes by username rather than wiping these tables wholesale.
  await addSelfReflection(otherUsername, "opinion", "a reflection belonging to a user who is NOT being removed");

  const { rows: apiKeyRowsBefore } = await db.query(`SELECT key FROM api_keys WHERE username = $1`, [username]);
  if (apiKeyRowsBefore.length !== 1) {
    throw new Error(`expected exactly one api_keys row for "${username}" before removal, found ${apiKeyRowsBefore.length}`);
  }

  const existed = await removeUser(username);
  if (!existed) throw new Error("removeUser reported the just-created user as not found");

  // security.ts's clearGrantsCache is the piece admin-routes.ts calls after
  // removeUser resolves (see its own doc comment) — calling it here too
  // exercises the actual repo-level calls the route makes end to end, per
  // this test's brief ("exercise the actual route handler's deletion logic,
  // or the equivalent repo-level calls it makes"), not just removeUser in
  // isolation.
  permissions.clearGrantsCache(username);
  if (permissions.hasGrant(username, "web.search")) {
    throw new Error("removeUser + clearGrantsCache: in-memory cache still reports the removed user as granted 'web.search'");
  }

  const tableChecks: { label: string; sql: string; params: unknown[] }[] = [
    { label: "users", sql: `SELECT 1 FROM users WHERE username = $1`, params: [username] },
    { label: "api_keys (cascade via users FK)", sql: `SELECT 1 FROM api_keys WHERE username = $1`, params: [username] },
    { label: "oauth_tokens", sql: `SELECT 1 FROM oauth_tokens WHERE username = $1`, params: [username] },
    { label: "capability_grants", sql: `SELECT 1 FROM capability_grants WHERE username = $1`, params: [username] },
    { label: "conversation_history", sql: `SELECT 1 FROM conversation_history WHERE username = $1`, params: [username] },
    { label: "self_reflections", sql: `SELECT 1 FROM self_reflections WHERE username = $1`, params: [username] },
    { label: "proactive_thoughts", sql: `SELECT 1 FROM proactive_thoughts WHERE username = $1`, params: [username] },
    { label: "kg_entities", sql: `SELECT 1 FROM kg_entities WHERE username = $1`, params: [username] },
    { label: "kg_facts (cascade via kg_entities FK)", sql: `SELECT 1 FROM kg_facts WHERE entity_id = $1`, params: [entityId] },
    {
      label: "kg_relationships (cascade via kg_entities FK)",
      sql: `SELECT 1 FROM kg_relationships WHERE from_entity_id = $1 OR to_entity_id = $1`,
      params: [entityId],
    },
    { label: "objectives", sql: `SELECT 1 FROM objectives WHERE username = $1`, params: [username] },
    { label: "objective_runs", sql: `SELECT 1 FROM objective_runs WHERE username = $1`, params: [username] },
    { label: "push_subscriptions", sql: `SELECT 1 FROM push_subscriptions WHERE username = $1`, params: [username] },
    { label: "build_requests", sql: `SELECT 1 FROM build_requests WHERE requested_by = $1`, params: [username] },
    {
      label: "transcript_events (cascade via build_requests FK)",
      sql: `SELECT 1 FROM transcript_events WHERE build_request_id = $1`,
      params: [buildRequest.id],
    },
    { label: "command_proposals", sql: `SELECT 1 FROM command_proposals WHERE requested_by = $1`, params: [username] },
    { label: "feature_requests", sql: `SELECT 1 FROM feature_requests WHERE requested_by = $1`, params: [username] },
    { label: "mcp_servers", sql: `SELECT 1 FROM mcp_servers WHERE registered_by = $1`, params: [username] },
  ];
  if (vectorReady) {
    tableChecks.push({ label: "memory_embeddings", sql: `SELECT 1 FROM memory_embeddings WHERE username = $1`, params: [username] });
  }
  for (const check of tableChecks) {
    const { rows } = await db.query(check.sql, check.params);
    if (rows.length !== 0) {
      throw new Error(`removeUser: expected zero rows left in ${check.label} for the removed user, found ${rows.length}`);
    }
  }

  // The untouched second user's own self_reflections row must have
  // survived — proves the deletes above were scoped by username, not a
  // blanket wipe that happened to also match the removed user.
  const otherReflections = await getRecentSelfReflections(otherUsername);
  if (otherReflections.length !== 1 || otherReflections[0].content !== "a reflection belonging to a user who is NOT being removed") {
    throw new Error(`removeUser disturbed a different user's self_reflections row: ${JSON.stringify(otherReflections)}`);
  }

  // A second removal of the same (now-gone) user must report "not found,"
  // not throw and not silently report success — this is what lets
  // admin-routes.ts return a real 404 instead of a 500 on a repeat call.
  const second = await removeUser(username);
  if (second) throw new Error("removeUser reported success on a second call for an already-removed user");

  const neverExisted = await removeUser(`db_it_removeuser_never_existed_${RUN_ID}`);
  if (neverExisted) throw new Error("removeUser reported success for a username that was never created");
});

registerTest("grant-all grants a capability to every existing non-admin user, against real Postgres", async () => {
  const user1 = `bulk_grant_user_1_${RUN_ID}`;
  const user2 = `bulk_grant_user_2_${RUN_ID}`;
  await createUser(user1, "a-real-password-123");
  await createUser(user2, "a-real-password-123");
  const usernames = await usersRepo.listUsernames();
  for (const username of usernames) {
    if (username === "admin") continue;
    if (!permissions.hasGrant(username, "news.read")) {
      await permissions.grantCapability(username, "news.read", "admin");
    }
  }
  if (!permissions.hasGrant(user1, "news.read") || !permissions.hasGrant(user2, "news.read")) {
    throw new Error("expected both users to have the bulk-granted capability");
  }
});

registerTest("feature-requests-repo: getFeatureRequests scopes to the requester's own rows when a username is passed, and returns everything when it isn't (admin view)", async () => {
  const userA = `db_it_fr_a_${RUN_ID}`;
  const userB = `db_it_fr_b_${RUN_ID}`;
  const titleA = `db_it_fr_title_a_${RUN_ID}`;
  const titleB = `db_it_fr_title_b_${RUN_ID}`;
  await featureRequestsRepo.addFeatureRequest(titleA, "description A", null, null, userA);
  await featureRequestsRepo.addFeatureRequest(titleB, "description B", null, null, userB);

  // The route passes req.username for every non-admin caller — a personal
  // user must only ever see their own requests, never another user's.
  const aOwn = await featureRequestsRepo.getFeatureRequests(undefined, userA);
  if (aOwn.length !== 1 || aOwn[0].title !== titleA) {
    throw new Error(`feature-requests-repo: getFeatureRequests(undefined, "${userA}") expected exactly userA's own request, got: ${JSON.stringify(aOwn)}`);
  }
  if (aOwn.some(r => r.requested_by === userB)) {
    throw new Error("feature-requests-repo: getFeatureRequests scoped to userA leaked a row belonging to userB");
  }

  // The route omits the username entirely for admin — must still see both.
  const unscoped = await featureRequestsRepo.getFeatureRequests();
  if (!unscoped.some(r => r.title === titleA) || !unscoped.some(r => r.title === titleB)) {
    throw new Error("feature-requests-repo: getFeatureRequests() with no username (admin view) should return every request, including both seeded here");
  }
});

// ---------- HTTP-level: POST /api/register against the real running server ----------
//
// Everything above exercises invites-repo/users-repo/security functions
// directly — this section instead spawns the real src/server.ts (pointed at
// this same real, disposable Postgres via the inherited POSTGRES_* env vars)
// and hits the actual /api/register route over HTTP, because the bug this
// locks in lives in auth-routes.ts's handler ordering itself, not in any one
// repo function in isolation.
const TEST_INTERNAL_API_KEY = "db-integration-test-key-not-a-real-secret";

async function spawnRegisterTestServer(port: number): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["node_modules/.bin/tsx", "src/server.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), INTERNAL_API_KEY: TEST_INTERNAL_API_KEY },
    stdio: "ignore",
  });
  let spawnError: Error | null = null;
  child.on("error", (err) => { spawnError = err; });

  const deadline = Date.now() + 25_000;
  let ready = false;
  let lastErr: any = null;
  while (Date.now() < deadline) {
    if (spawnError) throw new Error(`db-integration HTTP: server on port ${port} failed to spawn: ${(spawnError as Error).message}`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) { ready = true; break; }
      lastErr = new Error(`/health returned HTTP ${res.status}`);
    } catch (err: any) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!ready) {
    child.kill("SIGKILL");
    throw new Error(`db-integration HTTP: server never became reachable on :${port}/health: ${lastErr?.message || lastErr}`);
  }
  return child;
}

async function stopRegisterTestServer(child: ChildProcess): Promise<void> {
  child.kill();
  const exited = await new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(false), 5000);
    child.once("exit", () => { clearTimeout(timeout); resolve(true); });
  });
  if (!exited) child.kill("SIGKILL");
}

registerTest("HTTP: POST /api/register claims the invite before creating the user, closing the registration race, against real Postgres", async () => {
  const port = 3301;
  const child = await spawnRegisterTestServer(port);
  const winnerUsername = `db_it_race_winner_${RUN_ID}`;
  const loserUsername = `db_it_race_loser_${RUN_ID}`;
  try {
    const raceInvite = await invitesRepo.createInvite("admin");

    // Two concurrent registrations against the SAME invite token. Before
    // the fix (createUser ran before redeemInvite), the read-only pre-check
    // passed for both requests, so BOTH calls to createUser succeeded — a
    // real, working, zero-grant account got created for the request that
    // then lost the atomic redeemInvite race, even though it received a
    // 400. After the fix (redeemInvite is the first write), the losing
    // request is rejected by the atomic claim before createUser ever runs,
    // so no account exists for it at all.
    const [resA, resB] = await Promise.all([
      fetch(`http://127.0.0.1:${port}/api/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: winnerUsername, password: "a-real-password-123", inviteToken: raceInvite.token }),
      }),
      fetch(`http://127.0.0.1:${port}/api/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: loserUsername, password: "a-real-password-123", inviteToken: raceInvite.token }),
      }),
    ]);

    const statuses = [resA.status, resB.status].sort((a, b) => a - b);
    if (statuses[0] !== 200 || statuses[1] !== 400) {
      throw new Error(`db-integration HTTP: expected exactly one 200 and one 400 for a concurrent same-token registration race, got ${resA.status} and ${resB.status}`);
    }
    const winnerWasA = resA.status === 200;
    const actualWinner = winnerWasA ? winnerUsername : loserUsername;
    const actualLoser = winnerWasA ? loserUsername : winnerUsername;

    const db = getPool();
    const { rows: winnerRows } = await db.query(`SELECT 1 FROM users WHERE username = $1`, [actualWinner]);
    if (winnerRows.length !== 1) {
      throw new Error(`db-integration HTTP: expected the winning registration ("${actualWinner}") to have created exactly one user row, found ${winnerRows.length}`);
    }
    const { rows: loserRows } = await db.query(`SELECT 1 FROM users WHERE username = $1`, [actualLoser]);
    if (loserRows.length !== 0) {
      throw new Error(
        `db-integration HTTP: registration race regression — the losing request ("${actualLoser}") still created a real user account; ` +
          `the redeem-before-create reordering did not close the race`
      );
    }

    // The invite must show the actual winner as its claimant, not be left
    // ambiguous or double-claimed.
    const afterRace = await invitesRepo.getInvite(raceInvite.token);
    if (!afterRace || afterRace.used_by !== actualWinner) {
      throw new Error(`db-integration HTTP: expected invite used_by="${actualWinner}" after the race, got: ${JSON.stringify(afterRace)}`);
    }
  } finally {
    await stopRegisterTestServer(child);
    const db = getPool();
    await db.query(`DELETE FROM users WHERE username IN ($1, $2)`, [winnerUsername, loserUsername]).catch(() => {});
    await db.query(`DELETE FROM capability_grants WHERE username IN ($1, $2)`, [winnerUsername, loserUsername]).catch(() => {});
    await db.query(`DELETE FROM invite_tokens WHERE created_by = 'admin' AND used_by IN ($1, $2)`, [winnerUsername, loserUsername]).catch(() => {});
  }
});

registerTest("HTTP: POST /api/register blocks redemption once the 10-person cap is hit, against real Postgres", async () => {
  const port = 3302;
  const child = await spawnRegisterTestServer(port);
  const fillerUsernames: string[] = [];
  let capInviteToken: string | null = null;
  const overflowUsername = `db_it_cap_overflow_${RUN_ID}`;
  try {
    // Fill up to (not necessarily from zero — other tests in this run may
    // have left transient rows behind, cleaned up independently) exactly
    // MAX_NON_ADMIN_USERS non-admin users, redeeming each filler invite
    // directly against the repo (not through HTTP) since only the final,
    // over-the-cap attempt is what this test needs to go through the real
    // route.
    const startingCount = await invitesRepo.countNonAdminUsers();
    const need = Math.max(0, 10 - startingCount);
    for (let i = 0; i < need; i++) {
      const fillerUsername = `db_it_cap_filler_${i}_${RUN_ID}`;
      const fillerInvite = await invitesRepo.createInvite("admin");
      await usersRepo.createUser(fillerUsername, "a-real-password-123");
      await invitesRepo.redeemInvite(fillerInvite.token, fillerUsername);
      fillerUsernames.push(fillerUsername);
    }
    const cappedCount = await invitesRepo.countNonAdminUsers();
    if (cappedCount < 10) {
      throw new Error(`db-integration HTTP: expected countNonAdminUsers() >= 10 after filling to the cap, got ${cappedCount}`);
    }

    const capInvite = await invitesRepo.createInvite("admin");
    capInviteToken = capInvite.token;
    const overflowRes = await fetch(`http://127.0.0.1:${port}/api/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: overflowUsername, password: "a-real-password-123", inviteToken: capInvite.token }),
    });
    if (overflowRes.status !== 403) {
      throw new Error(`db-integration HTTP: expected 403 once the 10-person cap is reached, got ${overflowRes.status}`);
    }

    // A registration rejected by the cap must not have created a user or
    // burned the invite — an admin should be able to just reissue/retry it
    // once someone else is removed.
    const db = getPool();
    const { rows: overflowUserRows } = await db.query(`SELECT 1 FROM users WHERE username = $1`, [overflowUsername]);
    if (overflowUserRows.length !== 0) {
      throw new Error(`db-integration HTTP: a registration blocked by the 10-person cap still created a user account for "${overflowUsername}"`);
    }
    const afterCapAttempt = await invitesRepo.getInvite(capInvite.token);
    if (afterCapAttempt?.used_by) {
      throw new Error(`db-integration HTTP: expected the invite to remain unused after a registration blocked by the cap, got used_by="${afterCapAttempt.used_by}"`);
    }
  } finally {
    await stopRegisterTestServer(child);
    const db = getPool();
    const allFillers = [...fillerUsernames, overflowUsername];
    for (const u of allFillers) {
      await db.query(`DELETE FROM users WHERE username = $1`, [u]).catch(() => {});
      await db.query(`DELETE FROM capability_grants WHERE username = $1`, [u]).catch(() => {});
    }
    if (fillerUsernames.length > 0) {
      await db.query(`DELETE FROM invite_tokens WHERE created_by = 'admin' AND used_by = ANY($1)`, [fillerUsernames]).catch(() => {});
    }
    if (capInviteToken) {
      await db.query(`DELETE FROM invite_tokens WHERE token = $1`, [capInviteToken]).catch(() => {});
    }
  }
});

// Finding 5, end to end over real HTTP: register a real account, confirm the
// raw key it returns actually authenticates, then log in again and confirm
// login mints its own independently-working key (see the dedicated
// users-repo test above for why login can no longer just return the same
// raw key it did before — api_keys.key now stores only a hash, so an
// already-issued raw value can never be read back out). Placed right after
// the 10-person-cap test (which cleans up all its own users in its finally
// block) and before the ownership test below (which adds 2 more users of
// its own) so this test's own register call runs comfortably under the cap
// regardless of exactly how many earlier tests' users are still lingering.
registerTest("HTTP: POST /api/register then POST /api/login both issue real, hashed-at-rest, independently-working API keys, against real Postgres", async () => {
  const port = 3303;
  const child = await spawnRegisterTestServer(port);
  const username = `db_it_login_${RUN_ID}`;
  try {
    const invite = await invitesRepo.createInvite("admin");
    const registerRes = await fetch(`http://127.0.0.1:${port}/api/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password: "a-real-password-123", inviteToken: invite.token }),
    });
    if (registerRes.status !== 200) {
      throw new Error(`db-integration HTTP: expected 200 from /api/register, got ${registerRes.status}`);
    }
    const registerBody = await registerRes.json();
    const registerKey = registerBody.api_key;
    if (!registerKey || typeof registerKey !== "string") {
      throw new Error(`db-integration HTTP: /api/register did not return a usable api_key: ${JSON.stringify(registerBody)}`);
    }

    // The raw key from registration must actually authenticate — proves
    // auth-middleware.ts's hash-then-lookup path works end-to-end against a
    // real running server, not just in isolation against the repo function.
    const registerKeyAuthRes = await fetch(`http://127.0.0.1:${port}/api/feature-requests`, {
      headers: { "X-API-Key": registerKey },
    });
    if (registerKeyAuthRes.status !== 200) {
      throw new Error(`db-integration HTTP: the raw api_key returned by /api/register failed to authenticate, got ${registerKeyAuthRes.status}`);
    }

    const loginRes = await fetch(`http://127.0.0.1:${port}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password: "a-real-password-123" }),
    });
    if (loginRes.status !== 200) {
      throw new Error(`db-integration HTTP: expected 200 from /api/login, got ${loginRes.status}`);
    }
    const loginBody = await loginRes.json();
    const loginKey = loginBody.api_key;
    if (!loginKey || typeof loginKey !== "string") {
      throw new Error(`db-integration HTTP: /api/login did not return a usable api_key: ${JSON.stringify(loginBody)}`);
    }
    if (loginKey === registerKey) {
      throw new Error("db-integration HTTP: /api/login returned the SAME raw key as /api/register — expected a freshly minted key");
    }
    const loginKeyAuthRes = await fetch(`http://127.0.0.1:${port}/api/feature-requests`, {
      headers: { "X-API-Key": loginKey },
    });
    if (loginKeyAuthRes.status !== 200) {
      throw new Error(`db-integration HTTP: the raw api_key returned by /api/login failed to authenticate, got ${loginKeyAuthRes.status}`);
    }

    // Neither key's stored hash is itself usable as a credential.
    const db = getPool();
    const { rows: storedKeys } = await db.query(`SELECT key FROM api_keys WHERE username = $1`, [username]);
    if (storedKeys.length !== 2) {
      throw new Error(`db-integration HTTP: expected exactly 2 api_keys rows (register + login) for "${username}", found ${storedKeys.length}`);
    }
    for (const row of storedKeys) {
      const hashAuthRes = await fetch(`http://127.0.0.1:${port}/api/feature-requests`, {
        headers: { "X-API-Key": row.key },
      });
      if (hashAuthRes.status !== 401) {
        throw new Error(`db-integration HTTP: the STORED HASH value authenticated successfully (status ${hashAuthRes.status}) — it must never be usable as a credential on its own`);
      }
    }
  } finally {
    await stopRegisterTestServer(child);
    const db = getPool();
    await db.query(`DELETE FROM users WHERE username = $1`, [username]).catch(() => {});
    await db.query(`DELETE FROM capability_grants WHERE username = $1`, [username]).catch(() => {});
    await db.query(`DELETE FROM invite_tokens WHERE created_by = 'admin' AND used_by = $1`, [username]).catch(() => {});
  }
});

// Finding 7's second bug: feature.propose is in DEFAULT_PERSONAL_CAPABILITIES,
// so every personal user holds it — POST /:id/status used to accept that
// grant alone as authorization to change ANY user's feature request status,
// with no ownership check at all. This hits the real route over HTTP (not
// just the repo function directly) because the fix lives in
// feature-requests-routes.ts's handler, not in updateFeatureRequestStatus
// itself.
registerTest("HTTP: POST /api/feature-requests/:id/status enforces per-user ownership, against real Postgres", async () => {
  const port = 3304;
  const child = await spawnRegisterTestServer(port);
  const ownerUsername = `db_it_fr_owner_${RUN_ID}`;
  const otherUsername = `db_it_fr_other_${RUN_ID}`;
  try {
    // Registered through the real /api/register route (not usersRepo.createUser
    // + a direct permissions.grantCapability call) deliberately: this test's
    // server runs in a SEPARATE spawned process with its own in-memory
    // capability-grants cache (security.ts's `grants` Map), loaded once at
    // that process's own startup and only ever updated by grants that
    // happen INSIDE it. A grant written directly to Postgres from THIS
    // (test) process never reaches that cache, so the owner would wrongly
    // get 403 on their own request — going through /api/register instead
    // means DEFAULT_PERSONAL_CAPABILITIES (which includes feature.propose)
    // is granted by the child process itself, actually landing in its cache.
    const ownerInvite = await invitesRepo.createInvite("admin");
    const ownerRegisterRes = await fetch(`http://127.0.0.1:${port}/api/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: ownerUsername, password: "a-real-password-123", inviteToken: ownerInvite.token }),
    });
    if (ownerRegisterRes.status !== 200) {
      throw new Error(`db-integration HTTP: expected 200 registering the owner test user, got ${ownerRegisterRes.status}`);
    }
    const ownerKey = (await ownerRegisterRes.json()).api_key;

    const otherInvite = await invitesRepo.createInvite("admin");
    const otherRegisterRes = await fetch(`http://127.0.0.1:${port}/api/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: otherUsername, password: "a-real-password-123", inviteToken: otherInvite.token }),
    });
    if (otherRegisterRes.status !== 200) {
      throw new Error(`db-integration HTTP: expected 200 registering the other test user, got ${otherRegisterRes.status}`);
    }
    const otherKey = (await otherRegisterRes.json()).api_key;

    const created = await featureRequestsRepo.addFeatureRequest(
      `db_it_fr_ownership_${RUN_ID}`,
      "description",
      null,
      null,
      ownerUsername
    );

    // The non-owning user (who still holds feature.propose) must be
    // rejected with 403, and the row's status must not actually change.
    const crossUserRes = await fetch(`http://127.0.0.1:${port}/api/feature-requests/${created.id}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": otherKey },
      body: JSON.stringify({ status: "declined" }),
    });
    if (crossUserRes.status !== 403) {
      throw new Error(`db-integration HTTP: expected 403 for a non-owning personal user updating another user's feature request, got ${crossUserRes.status}`);
    }
    const afterCrossUserAttempt = await featureRequestsRepo.getFeatureRequestById(created.id);
    if (afterCrossUserAttempt?.status !== "queued") {
      throw new Error(`db-integration HTTP: a rejected cross-user status update still changed the row's status: ${JSON.stringify(afterCrossUserAttempt)}`);
    }

    // The actual owner can update their own request's status.
    const ownerRes = await fetch(`http://127.0.0.1:${port}/api/feature-requests/${created.id}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": ownerKey },
      body: JSON.stringify({ status: "declined" }),
    });
    if (ownerRes.status !== 200) {
      throw new Error(`db-integration HTTP: expected 200 for the actual owner updating their own feature request, got ${ownerRes.status}`);
    }
    const afterOwnerUpdate = await featureRequestsRepo.getFeatureRequestById(created.id);
    if (afterOwnerUpdate?.status !== "declined") {
      throw new Error(`db-integration HTTP: owner's own status update did not take effect: ${JSON.stringify(afterOwnerUpdate)}`);
    }
  } finally {
    await stopRegisterTestServer(child);
    const db = getPool();
    await db.query(`DELETE FROM feature_requests WHERE requested_by = $1`, [ownerUsername]).catch(() => {});
    await db.query(`DELETE FROM users WHERE username IN ($1, $2)`, [ownerUsername, otherUsername]).catch(() => {});
    await db.query(`DELETE FROM capability_grants WHERE username IN ($1, $2)`, [ownerUsername, otherUsername]).catch(() => {});
    await db.query(`DELETE FROM invite_tokens WHERE created_by = 'admin' AND used_by IN ($1, $2)`, [ownerUsername, otherUsername]).catch(() => {});
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
