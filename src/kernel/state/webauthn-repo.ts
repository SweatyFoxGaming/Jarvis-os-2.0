import { getPool } from "./db.js";

export interface WebauthnCredentialRow {
  id: number;
  username: string;
  credential_id: string;
  public_key: Buffer;
  counter: number;
  device_label: string;
  created_at: Date;
  last_used_at: Date | null;
}

export async function insertCredential(
  username: string,
  credentialId: string,
  publicKey: Buffer,
  counter: number,
  deviceLabel: string
): Promise<void> {
  const db = getPool();
  await db.query(
    `INSERT INTO webauthn_credentials (username, credential_id, public_key, counter, device_label)
     VALUES ($1, $2, $3, $4, $5)`,
    [username, credentialId, publicKey, counter, deviceLabel]
  );
}

export async function getCredentialById(credentialId: string): Promise<WebauthnCredentialRow | null> {
  const db = getPool();
  const { rows } = await db.query(`SELECT * FROM webauthn_credentials WHERE credential_id = $1`, [credentialId]);
  if (!rows[0]) return null;
  const row = rows[0];
  return {
    ...row,
    counter: typeof row.counter === 'string' ? parseInt(row.counter, 10) : row.counter,
  };
}

export async function listCredentialsForUsername(username: string): Promise<WebauthnCredentialRow[]> {
  const db = getPool();
  const { rows } = await db.query(
    `SELECT * FROM webauthn_credentials WHERE username = $1 ORDER BY created_at ASC`,
    [username]
  );
  return rows.map(row => ({
    ...row,
    counter: typeof row.counter === 'string' ? parseInt(row.counter, 10) : row.counter,
  }));
}

export async function updateCounterAndLastUsed(credentialId: string, newCounter: number): Promise<void> {
  const db = getPool();
  await db.query(
    `UPDATE webauthn_credentials SET counter = $2, last_used_at = now() WHERE credential_id = $1`,
    [credentialId, newCounter]
  );
}

// Ownership-checked in the SQL itself (WHERE id = $1 AND username = $2),
// not via a separate SELECT-then-DELETE — closes the same TOCTOU class
// createUser's own comment documents elsewhere in this codebase. Returns
// false both when the row doesn't exist and when it belongs to a
// different username, which is exactly the "you may not touch this" signal
// the route layer needs; it never distinguishes the two, so a caller can't
// probe for another user's credential IDs by observing the response.
export async function deleteCredential(id: number, username: string): Promise<boolean> {
  const db = getPool();
  const { rowCount } = await db.query(
    `DELETE FROM webauthn_credentials WHERE id = $1 AND username = $2`,
    [id, username]
  );
  return (rowCount ?? 0) > 0;
}
