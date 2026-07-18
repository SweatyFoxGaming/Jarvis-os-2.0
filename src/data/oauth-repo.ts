import { getPool } from "./db.js";

export interface StoredOAuthTokens {
  provider: string;
  access_token: string;
  refresh_token: string;
  expiry: Date;
}

export async function saveTokens(provider: string, accessToken: string, refreshToken: string, expiry: Date): Promise<void> {
  const db = getPool();
  await db.query(
    `INSERT INTO oauth_tokens (provider, access_token, refresh_token, expiry)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (provider) DO UPDATE SET access_token = $2, refresh_token = $3, expiry = $4, updated_at = now()`,
    [provider, accessToken, refreshToken, expiry]
  );
}

export async function getTokens(provider: string): Promise<StoredOAuthTokens | null> {
  const db = getPool();
  const { rows } = await db.query(`SELECT * FROM oauth_tokens WHERE provider = $1`, [provider]);
  return rows[0] || null;
}
