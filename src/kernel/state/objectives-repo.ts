import { getPool } from "./db.js";

export interface ObjectiveRow {
  id: number;
  username: string;
  description: string;
  target_date: string | null;
  status: "active" | "completed" | "abandoned";
  created_at: Date;
  updated_at: Date;
  last_checked_at: Date | null;
}

export async function createObjective(
  username: string,
  description: string,
  targetDateISO: string | null
): Promise<ObjectiveRow> {
  const db = getPool();
  const { rows } = await db.query(
    `INSERT INTO objectives (username, description, target_date)
     VALUES ($1, $2, $3)
     RETURNING id, username, description, target_date::text AS target_date, status, created_at, updated_at, last_checked_at`,
    [username, description, targetDateISO]
  );
  return rows[0];
}

export async function listActiveObjectives(username: string): Promise<ObjectiveRow[]> {
  try {
    const db = getPool();
    const { rows } = await db.query(
      `SELECT id, username, description, target_date::text AS target_date, status, created_at, updated_at, last_checked_at
       FROM objectives WHERE username = $1 AND status = 'active'
       ORDER BY target_date ASC NULLS LAST, created_at ASC`,
      [username]
    );
    return rows;
  } catch {
    return [];
  }
}

export async function updateObjectiveStatus(
  username: string,
  id: number,
  status: "completed" | "abandoned"
): Promise<boolean> {
  try {
    const db = getPool();
    const { rowCount } = await db.query(
      `UPDATE objectives SET status = $1, updated_at = now()
       WHERE id = $2 AND username = $3 AND status = 'active'`,
      [status, id, username]
    );
    return (rowCount ?? 0) > 0;
  } catch {
    return false;
  }
}

export async function collectDueObjectives(username: string): Promise<ObjectiveRow[]> {
  try {
    const db = getPool();
    const { rows } = await db.query(
      `SELECT id, username, description, target_date::text AS target_date, status, created_at, updated_at, last_checked_at
       FROM objectives
       WHERE username = $1 AND status = 'active'
         AND (
           last_checked_at IS NULL
           OR last_checked_at < now() - interval '3 days'
           OR target_date <= now() + interval '3 days'
         )
       ORDER BY target_date ASC NULLS LAST, created_at ASC`,
      [username]
    );
    return rows;
  } catch {
    return [];
  }
}

export async function markCheckedIn(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  try {
    const db = getPool();
    await db.query(`UPDATE objectives SET last_checked_at = now() WHERE id = ANY($1::int[])`, [ids]);
  } catch {
    // Best-effort — a failed check-in stamp just means this objective may
    // surface again slightly sooner than intended, never a crash.
  }
}
