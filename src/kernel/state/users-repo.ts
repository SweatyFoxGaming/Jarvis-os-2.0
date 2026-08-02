import bcrypt from "bcryptjs";
import crypto from "crypto";
import { getPool } from "./db.js";

const BCRYPT_ROUNDS = 12;

export class UsernameTakenError extends Error {
  constructor() {
    super("Username already exists");
  }
}

export class ReservedUsernameError extends Error {
  constructor() {
    super("This username is reserved and cannot be registered");
  }
}

// "admin" is the literal string auth-middleware.ts assigns to req.username
// for the INTERNAL_API_KEY holder, and the one security.ts/permissions-routes.ts
// check against to grant every capability. It must never also be obtainable
// by registering a normal account — enforced here (the actual write path),
// not just in the /api/register route, so any future caller of createUser
// gets the same guarantee. Case-insensitive since permission checks could
// reasonably become case-insensitive later; today's exact-match check makes
// only the literal lowercase "admin" dangerous, but reserving the whole set
// of case variants costs nothing and removes the need to keep it in sync.
const RESERVED_USERNAMES = new Set(["admin"]);

function generateApiKey(): string {
  return `jarvis_key_${crypto.randomBytes(24).toString("hex")}`;
}

export async function createUser(username: string, password: string): Promise<string> {
  if (RESERVED_USERNAMES.has(username.toLowerCase())) {
    throw new ReservedUsernameError();
  }
  const db = getPool();
  const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  // ON CONFLICT DO NOTHING instead of check-then-insert: two concurrent
  // registrations for the same username used to both pass the earlier
  // SELECT before either committed, so the losing INSERT threw a raw
  // unique-violation instead of this function's own UsernameTakenError.
  // A single statement closes that window — whichever request's INSERT
  // actually lands gets a row back; the other gets none.
  const { rowCount } = await db.query(
    "INSERT INTO users (username, password_hash) VALUES ($1, $2) ON CONFLICT (username) DO NOTHING",
    [username, hash]
  );
  if (!rowCount) {
    throw new UsernameTakenError();
  }
  return createApiKey(username);
}

export async function verifyCredentials(username: string, password: string): Promise<boolean> {
  const db = getPool();
  const result = await db.query("SELECT password_hash FROM users WHERE username = $1", [username]);
  if (result.rowCount === 0) return false;
  return bcrypt.compare(password, result.rows[0].password_hash);
}

export async function createApiKey(username: string): Promise<string> {
  const db = getPool();
  const key = generateApiKey();
  await db.query("INSERT INTO api_keys (key, username) VALUES ($1, $2)", [key, username]);
  return key;
}

export async function getOrCreateApiKey(username: string): Promise<string> {
  const db = getPool();
  const existing = await db.query(
    "SELECT key FROM api_keys WHERE username = $1 ORDER BY created_at ASC LIMIT 1",
    [username]
  );
  if ((existing.rowCount ?? 0) > 0) return existing.rows[0].key;
  return createApiKey(username);
}

export async function getUsernameByApiKey(key: string): Promise<string | null> {
  const db = getPool();
  const result = await db.query("SELECT username FROM api_keys WHERE key = $1", [key]);
  return result.rowCount ? result.rows[0].username : null;
}

// "admin" (auth-middleware.ts's INTERNAL_API_KEY identity) is never a row in
// this table, so it's added explicitly — callers that need every real
// username to iterate per-user work (e.g. scheduler.ts's proactive-self-
// reflection job, now that self_reflections/proactive_thoughts are scoped
// per user) would otherwise silently skip the operator account.
export async function listUsernames(): Promise<string[]> {
  const db = getPool();
  const { rows } = await db.query("SELECT username FROM users");
  return ["admin", ...rows.map((r: any) => r.username)];
}

// Backs the admin-only DELETE /api/admin/users/:username route
// (admin-routes.ts) — full cascade delete of an account and every piece of
// personal data scoped to their username, per this plan's design doc
// (docs/superpowers/specs/2026-08-01-multi-user-personal-brains-design.md,
// Component 9): "full cascade delete of the account, personal facts/
// history, and connected-account tokens ... plus clearing their capability
// grants. Full removal, not a soft deactivate."
//
// Deliberately does NOT handle Google-side token revocation (that's an
// external HTTP call with its own best-effort-don't-block semantics, kept
// in admin-routes.ts alongside the rest of the request/response handling)
// or the in-memory capability-grants cache (security.ts's clearGrantsCache,
// also called from admin-routes.ts after this resolves) — this function's
// job is exactly the Postgres-side cascade, and only that, so it stays
// directly callable/testable the same way every other *-repo.ts function
// in this codebase is.
//
// Which tables below need an EXPLICIT DELETE (vs. relying on a real FK's
// ON DELETE CASCADE) was verified against db.ts's actual CREATE TABLE
// statements and migrations 004/007, then re-verified live against a
// throwaway Postgres (see task-15-report.md under
// .superpowers/sdd/2026-08-01-multi-user-personal-brains/) — not assumed
// from the table names alone:
//
//   - api_keys: `username TEXT NOT NULL REFERENCES users(username) ON
//     DELETE CASCADE` (db.ts) — a real FK. Deleting the `users` row alone
//     cascades to it; no separate DELETE needed.
//   - kg_facts / kg_relationships: `entity_id`/`from_entity_id`/
//     `to_entity_id ... REFERENCES kg_entities(id) ON DELETE CASCADE`
//     (db.ts) — real FKs onto kg_entities(id), not onto users. Deleting
//     this username's kg_entities rows cascades to both; no separate
//     DELETE needed for them.
//   - oauth_tokens, capability_grants, conversation_history,
//     self_reflections, proactive_thoughts, kg_entities: all plain
//     `username TEXT` columns with NO foreign key back to `users` at all
//     (kg_entities/self_reflections/proactive_thoughts got their username
//     column from migration 004; oauth_tokens from migration 007).
//     Migration 007's own comment documents *why* oauth_tokens never got a
//     real FK: 'admin' (auth-middleware.ts's INTERNAL_API_KEY identity) is
//     a synthetic username that's never an actual row in `users`, and a
//     real `REFERENCES users(username)` constraint was verified (against a
//     throwaway Postgres) to fail immediately after the 'admin' backfill
//     for exactly that reason. Every one of these needs its own explicit
//     DELETE in this transaction, or that user's data survives account
//     removal — contrary to this plan's design intent.
//
// Returns whether a `users` row actually existed to delete (false ->
// caller should report 404, not 500 — this function does not throw for
// "user not found," only for a genuine DB failure).
export async function removeUser(username: string): Promise<boolean> {
  const db = getPool();
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM oauth_tokens WHERE username = $1`, [username]);
    await client.query(`DELETE FROM capability_grants WHERE username = $1`, [username]);
    await client.query(`DELETE FROM conversation_history WHERE username = $1`, [username]);
    await client.query(`DELETE FROM self_reflections WHERE username = $1`, [username]);
    await client.query(`DELETE FROM proactive_thoughts WHERE username = $1`, [username]);
    // kg_facts/kg_relationships cascade automatically from this delete
    // (see the doc comment above) — no separate statement for them.
    await client.query(`DELETE FROM kg_entities WHERE username = $1`, [username]);
    // api_keys cascades automatically from this delete (see the doc
    // comment above) — no separate statement for it either.
    const result = await client.query(`DELETE FROM users WHERE username = $1`, [username]);
    await client.query("COMMIT");
    return (result.rowCount ?? 0) > 0;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
