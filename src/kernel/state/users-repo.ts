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
