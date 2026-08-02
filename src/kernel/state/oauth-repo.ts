import { getPool } from "./db.js";
import { encryptToken, decryptToken } from "../token-crypto.js";

export interface StoredOAuthTokens {
  provider: string;
  username: string;
  access_token: string;
  refresh_token: string;
  expiry: Date;
}

export async function saveTokens(
  provider: string,
  username: string,
  accessToken: string,
  refreshToken: string,
  expiry: Date
): Promise<void> {
  const db = getPool();
  await db.query(
    `INSERT INTO oauth_tokens (provider, username, access_token, refresh_token, expiry)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (provider, username) DO UPDATE SET access_token = $3, refresh_token = $4, expiry = $5, updated_at = now()`,
    [provider, username, encryptToken(accessToken), encryptToken(refreshToken), expiry]
  );
}

export async function getTokens(provider: string, username: string): Promise<StoredOAuthTokens | null> {
  const db = getPool();
  const { rows } = await db.query(`SELECT * FROM oauth_tokens WHERE provider = $1 AND username = $2`, [provider, username]);
  const row = rows[0];
  if (!row) return null;
  const accessToken = decryptToken(row.access_token);
  const refreshToken = decryptToken(row.refresh_token);
  // Fail closed per this plan's Global Constraints: a decryption failure
  // (corrupt data, wrong key) is treated as "not connected", not a crash
  // and not a silent return of ciphertext-as-if-it-were-a-real-token.
  if (accessToken === null || refreshToken === null) return null;
  return { provider: row.provider, username: row.username, access_token: accessToken, refresh_token: refreshToken, expiry: row.expiry };
}

export async function deleteTokens(provider: string, username: string): Promise<boolean> {
  // Degrades cleanly (false, not a throw) on a DB outage, same read-vs-write
  // split vault-repo.ts's read-side functions use: this backs the
  // self-service disconnect route, where "nothing to disconnect" is a
  // sensible fallback and a hard 500 would only block a best-effort cleanup
  // action the user can safely retry.
  try {
    const db = getPool();
    const { rowCount } = await db.query(`DELETE FROM oauth_tokens WHERE provider = $1 AND username = $2`, [provider, username]);
    return !!rowCount;
  } catch {
    return false;
  }
}
