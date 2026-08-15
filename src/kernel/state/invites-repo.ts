import crypto from "crypto";
import { getPool } from "./db.js";
import { ObservationPlatform } from "../observation.js";

const observation = ObservationPlatform.getInstance();

export interface InviteToken {
  token: string;
  created_by: string;
  created_at: Date;
  expires_at: Date;
  used_by: string | null;
  used_at: Date | null;
}

export async function countNonAdminUsers(): Promise<number> {
  const db = getPool();
  const { rows } = await db.query(`SELECT COUNT(*)::int AS count FROM users WHERE username != 'admin'`);
  return rows[0]?.count ?? 0;
}

export async function createInvite(createdBy: string, expiresInDays = 7): Promise<InviteToken> {
  const db = getPool();
  const token = crypto.randomBytes(24).toString("hex");
  const { rows } = await db.query(
    `INSERT INTO invite_tokens (token, created_by, expires_at) VALUES ($1, $2, now() + ($3 || ' days')::interval) RETURNING *`,
    [token, createdBy, expiresInDays]
  );
  return rows[0];
}

// Atomic claim: the WHERE clause requires the invite to still be unused and
// unexpired, so two near-simultaneous redemption attempts for the same
// token can't both succeed — whichever UPDATE actually matches a row wins,
// the other gets rowCount 0 and this returns false. Mirrors the same
// concurrency discipline createUser's ON CONFLICT DO NOTHING already uses.
export async function redeemInvite(token: string, username: string): Promise<boolean> {
  const db = getPool();
  const { rowCount } = await db.query(
    `UPDATE invite_tokens SET used_by = $1, used_at = now()
     WHERE token = $2 AND used_by IS NULL AND expires_at > now()`,
    [username, token]
  );
  return !!rowCount;
}

export async function revokeInvite(token: string): Promise<boolean> {
  const db = getPool();
  const { rowCount } = await db.query(`DELETE FROM invite_tokens WHERE token = $1 AND used_by IS NULL`, [token]);
  return !!rowCount;
}

export async function getInvite(token: string): Promise<InviteToken | null> {
  try {
    const db = getPool();
    const { rows } = await db.query(`SELECT * FROM invite_tokens WHERE token = $1`, [token]);
    return rows[0] || null;
  } catch (err: any) {
    observation.logTelemetry("warn", "Database", `getInvite failed: ${err.message}`);
    return null;
  }
}
