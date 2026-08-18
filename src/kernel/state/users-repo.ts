import bcrypt from "bcryptjs";
import crypto from "crypto";
import { getPool, isVectorReady } from "./db.js";

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

export class InvalidUsernameError extends Error {
  constructor() {
    super("Username must be 3-32 characters and contain only letters, numbers, underscores, dots, and hyphens");
  }
}

// Enforced in createUser (the actual write path), not just in the
// /api/register route's own checks, so any future caller gets the same
// guarantee. observation.ts's audit log lines are built with a literal `|`
// delimiter (`` `[${timestamp}] Actor: ${actor} | Action: ${action} | ...` ``)
// — an unconstrained username could otherwise embed ` | Actor: admin | ...`
// or similar and forge what looks like a separate, differently-attributed
// audit-log line. Restricting the charset to what every legitimate username
// in this codebase already looks like (see the reserved-username check right
// below) closes that off structurally instead of relying on every future
// log line to escape/quote it correctly.
//
// Exported (used by validateNewUsername below, and available to any other
// caller that needs the exact same rule) so nothing ever redefines its own
// copy of this regex — a malformed username used to only get rejected
// here, inside createUser, which redeemInvite's caller runs AFTER the
// token is already burned. Since this regex rejects common real input (an
// email address typed as a username, a space, under 3 characters), that
// ordering turned every such mistake into a permanently wasted invite.
export const USERNAME_FORMAT = /^[a-zA-Z0-9_.-]{3,32}$/;

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

// Runs both the format check and the reserved-username check — the two
// pure, synchronous, no-DB-lookup checks createUser performs before ever
// touching the database — as a single shared function, so createUser and
// any pre-check callers (auth-routes.ts's /api/register handler, which
// must run these checks BEFORE redeemInvite claims a single-use invite
// token) can never validate a username differently from one another.
// Deliberately excludes UsernameTakenError: that check requires a DB
// lookup and is inherently race-dependent (TOCTOU) no matter where it
// runs, so it stays exactly where it was — inside createUser's atomic
// INSERT ... ON CONFLICT DO NOTHING — rather than being folded in here.
export function validateNewUsername(username: string): void {
  if (!USERNAME_FORMAT.test(username)) {
    throw new InvalidUsernameError();
  }
  if (RESERVED_USERNAMES.has(username.toLowerCase())) {
    throw new ReservedUsernameError();
  }
}

function generateApiKey(): string {
  return `jarvis_key_${crypto.randomBytes(24).toString("hex")}`;
}

// Same threat model token-crypto.ts's doc comment describes for
// oauth_tokens — someone getting query access to Postgres (a backup leak, a
// compromised process) without also holding this exact process's memory.
// Unlike OAuth tokens (which this app must be able to decrypt again to make
// real API calls with), an API key only ever needs to be COMPARED against
// what a caller presents, never read back out — so a one-way hash, not
// reversible encryption, is the right tool: sha256 is deterministic, so
// hashing an incoming key the same way and comparing hashes is exactly as
// fast as the old raw-string lookup, but a leaked row can no longer be used
// directly as a credential the way a leaked oauth_tokens row (pre
// token-crypto.ts) or a leaked plaintext api_keys row could.
function hashApiKey(rawKey: string): string {
  return crypto.createHash("sha256").update(rawKey).digest("hex");
}

export async function createUser(username: string, password: string): Promise<string> {
  validateNewUsername(username);
  const db = getPool();
  const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const rawKey = generateApiKey();
  const hashedKey = hashApiKey(rawKey);
  // ON CONFLICT DO NOTHING instead of check-then-insert: two concurrent
  // registrations for the same username used to both pass the earlier
  // SELECT before either committed, so the losing INSERT threw a raw
  // unique-violation instead of this function's own UsernameTakenError.
  // A single statement closes that window — whichever request's INSERT
  // actually lands gets a row back; the other gets none.
  const { rowCount } = await db.query(
    "INSERT INTO users (username, password_hash, api_key) VALUES ($1, $2, $3) ON CONFLICT (username) DO NOTHING",
    [username, hash, hashedKey]
  );
  if (!rowCount) {
    throw new UsernameTakenError();
  }
  // Also insert into api_keys table for compatibility with the separate api_keys lookups
  await db.query("INSERT INTO api_keys (key, username) VALUES ($1, $2)", [hashedKey, username]);
  return rawKey;
}

export async function verifyCredentials(username: string, password: string): Promise<boolean> {
  const db = getPool();
  const result = await db.query("SELECT password_hash FROM users WHERE username = $1", [username]);
  if (result.rowCount === 0) return false;
  return bcrypt.compare(password, result.rows[0].password_hash);
}

// Returns the RAW key — this is the one and only time it's ever available.
// Only its sha256 hash is persisted (api_keys.key), so the raw value can
// never be recovered from the database again after this call returns; the
// caller (a registration or login HTTP response) must hand it to the user
// right now or it's gone for good.
export async function createApiKey(username: string): Promise<string> {
  const db = getPool();
  const rawKey = generateApiKey();
  await db.query("INSERT INTO api_keys (key, username) VALUES ($1, $2)", [hashApiKey(rawKey), username]);
  return rawKey;
}

// Historically this returned a previously-issued, still-valid raw key when
// one already existed for `username` — possible only because api_keys.key
// used to store the raw value itself. Now that the column holds only a
// one-way hash, an existing row's raw value is permanently unrecoverable
// (that's the whole point), so "get" is no longer something this function
// can do: every call mints and returns a brand-new key instead. In practice
// this means each successful /api/login now issues its own fresh key rather
// than every login returning the same one — a strict security improvement
// (no single long-lived key shared across every session) at the cost of
// api_keys accumulating one row per login with no pruning yet; no route in
// this codebase currently lists or individually revokes a user's keys, so
// that's a real but separate gap from the one this function exists to close.
export async function getOrCreateApiKey(username: string): Promise<string> {
  return createApiKey(username);
}

export async function getUsernameByApiKey(key: string): Promise<string | null> {
  const db = getPool();
  const result = await db.query("SELECT username FROM api_keys WHERE key = $1", [hashApiKey(key)]);
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

// Backs the admin UI's user-management list. Deliberately excludes the
// synthetic "admin" identity — it's not a `users` row, has no created_at,
// and DELETE /api/admin/users/:username already refuses to remove it, so
// there's nothing actionable to show for it here.
export interface UserSummary {
  username: string;
  createdAt: Date;
}

export async function listUsersWithMeta(): Promise<UserSummary[]> {
  const db = getPool();
  const { rows } = await db.query("SELECT username, created_at FROM users ORDER BY created_at ASC");
  return rows.map((r: any) => ({ username: r.username, createdAt: r.created_at }));
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
// statements and every migration file (001/004/007), then re-verified live
// against a throwaway Postgres (see task-15-report.md under
// .superpowers/sdd/2026-08-01-multi-user-personal-brains/) — not assumed
// from the table names alone. This list was revised twice already: an
// initial pass (task-15) missed four of the eleven username-scoped tables
// on a first read, caught by a second exhaustive `grep -rn "username"` pass;
// a later security-audit pass then caught four MORE tables that are
// per-user-owned but don't use a literal `username` column at all
// (`requested_by`/`registered_by` instead), which that same `username`
// grep necessarily missed — a new user later registering a previously
// removed username would otherwise inherit the old owner's build requests,
// proposed commands, feature requests, and MCP server registrations.
//
//   - api_keys: `username TEXT NOT NULL REFERENCES users(username) ON
//     DELETE CASCADE` (db.ts) — a real FK. Deleting the `users` row alone
//     cascades to it; no separate DELETE needed.
//   - kg_facts / kg_relationships: `entity_id`/`from_entity_id`/
//     `to_entity_id ... REFERENCES kg_entities(id) ON DELETE CASCADE`
//     (db.ts) — real FKs onto kg_entities(id), not onto users. Deleting
//     this username's kg_entities rows cascades to both; no separate
//     DELETE needed for them.
//   - transcript_events / coding_plan_tasks / reward_events:
//     `build_request_id INTEGER NOT NULL REFERENCES build_requests(id) ON
//     DELETE CASCADE` (db.ts / migrations/006_reward_events.ts) — real FKs
//     onto build_requests(id), not onto users. Deleting this username's
//     build_requests rows (see below) cascades to all three; no separate
//     DELETE needed for them.
//   - oauth_tokens, capability_grants, conversation_history,
//     self_reflections, proactive_thoughts, kg_entities, objectives,
//     objective_runs, push_subscriptions, memory_embeddings, build_requests
//     (owner column `requested_by`), command_proposals (owner column
//     `requested_by`), feature_requests (owner column `requested_by`),
//     mcp_servers (owner column `registered_by`): all plain TEXT owner
//     columns with NO foreign key back to `users` at all (kg_entities/
//     self_reflections/proactive_thoughts got their username column from
//     migration 004; oauth_tokens from migration 007; objectives/
//     push_subscriptions/memory_embeddings/build_requests/
//     command_proposals/mcp_servers from the baseline schema;
//     objective_runs from migration 001; feature_requests from the baseline
//     schema). objective_runs also has an *outbound*
//     `build_request_id INTEGER REFERENCES build_requests(id) ON DELETE SET
//     NULL` — irrelevant to ordering here: it fires automatically as a
//     side effect of deleting this user's own build_requests rows below (an
//     objective_runs row that referenced one of them just has that
//     column nulled out, not deleted), and nothing about it requires
//     objective_runs to be deleted before or after build_requests. Migration
//     007's own comment documents *why* oauth_tokens never got a real FK:
//     'admin' (auth-middleware.ts's INTERNAL_API_KEY identity) is a
//     synthetic username that's never an actual row in `users`, and a real
//     `REFERENCES users(username)` constraint was verified (against a
//     throwaway Postgres) to fail immediately after the 'admin' backfill
//     for exactly that reason — the same fact applies to every other table
//     in this group, none of which ever got a real FK added. Every one of
//     these needs its own explicit DELETE in this transaction, or that
//     user's data survives account removal — contrary to this plan's
//     design intent.
//   - memory_embeddings specifically only exists when the pgvector
//     extension initialized successfully (db.ts's createVectorSchema,
//     gated by isVectorReady()) — a deployment where that failed has no
//     such table at all, and an unconditional DELETE against it would
//     throw "relation does not exist" and roll back this entire
//     transaction, breaking user removal outright on that deployment. This
//     matches the guard cognition/memory-store.ts already uses around
//     every other read/write of this table.
//
// No FK dependency exists between any two tables in the explicit-delete
// list itself (build_requests is only ever the PARENT side of a FK from
// transcript_events/coding_plan_tasks/reward_events/objective_runs, never
// the child of one of the other explicitly-deleted tables), so the order
// among them doesn't matter for correctness; `users` is deleted last since
// api_keys cascades from it.
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
    await client.query(`DELETE FROM objectives WHERE username = $1`, [username]);
    await client.query(`DELETE FROM objective_runs WHERE username = $1`, [username]);
    await client.query(`DELETE FROM push_subscriptions WHERE username = $1`, [username]);
    // build_requests cascades to transcript_events/coding_plan_tasks/
    // reward_events (see the doc comment above) — no separate statements
    // for those three.
    await client.query(`DELETE FROM build_requests WHERE requested_by = $1`, [username]);
    await client.query(`DELETE FROM command_proposals WHERE requested_by = $1`, [username]);
    await client.query(`DELETE FROM feature_requests WHERE requested_by = $1`, [username]);
    await client.query(`DELETE FROM mcp_servers WHERE registered_by = $1`, [username]);
    if (isVectorReady()) {
      await client.query(`DELETE FROM memory_embeddings WHERE username = $1`, [username]);
    }
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
