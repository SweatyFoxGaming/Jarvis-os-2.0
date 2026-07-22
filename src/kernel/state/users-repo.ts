import bcrypt from "bcryptjs";
import crypto from "crypto";
import { getPool } from "./db.js";

const BCRYPT_ROUNDS = 12;

export class UsernameTakenError extends Error {
  constructor() {
    super("Username already exists");
  }
}

function generateApiKey(): string {
  return `jarvis_key_${crypto.randomBytes(24).toString("hex")}`;
}

export async function createUser(username: string, password: string): Promise<string> {
  const db = getPool();
  const existing = await db.query("SELECT 1 FROM users WHERE username = $1", [username]);
  if ((existing.rowCount ?? 0) > 0) {
    throw new UsernameTakenError();
  }
  const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  await db.query("INSERT INTO users (username, password_hash) VALUES ($1, $2)", [username, hash]);
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
