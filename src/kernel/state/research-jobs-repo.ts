import { getPool } from "./db.js";

export type ResearchJobStatus = "running" | "completed" | "stopped" | "error";

export interface ResearchJobRow {
  id: number;
  topic: string;
  target_duration_hours: number;
  status: ResearchJobStatus;
  vault_note_path: string;
  rounds_completed: number;
  requested_by: string;
  started_at: Date;
  last_round_at: Date | null;
  completed_at: Date | null;
}

export async function createResearchJob(
  topic: string,
  targetDurationHours: number,
  vaultNotePath: string,
  requestedBy: string
): Promise<ResearchJobRow> {
  const db = getPool();
  const { rows } = await db.query(
    `INSERT INTO research_jobs (topic, target_duration_hours, vault_note_path, requested_by)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [topic, targetDurationHours, vaultNotePath, requestedBy]
  );
  return rows[0];
}

export async function getResearchJob(id: number): Promise<ResearchJobRow | null> {
  try {
    const db = getPool();
    const { rows } = await db.query(`SELECT * FROM research_jobs WHERE id = $1`, [id]);
    return rows[0] || null;
  } catch {
    return null;
  }
}

export async function listRunningResearchJobs(): Promise<ResearchJobRow[]> {
  try {
    const db = getPool();
    const { rows } = await db.query(
      `SELECT * FROM research_jobs WHERE status = 'running' ORDER BY started_at ASC`
    );
    return rows;
  } catch {
    return [];
  }
}

export async function recordRoundCompleted(id: number): Promise<void> {
  try {
    const db = getPool();
    await db.query(
      `UPDATE research_jobs
       SET rounds_completed = rounds_completed + 1, last_round_at = now()
       WHERE id = $1 AND status = 'running'`,
      [id]
    );
  } catch {
    // Best-effort bookkeeping; the vault is the durable research artifact.
  }
}

export async function markCompleted(id: number): Promise<void> {
  try {
    const db = getPool();
    await db.query(
      `UPDATE research_jobs SET status = 'completed', completed_at = now()
       WHERE id = $1 AND status = 'running'`,
      [id]
    );
  } catch {
    // Best-effort terminal bookkeeping.
  }
}

export async function markStopped(id: number): Promise<ResearchJobRow | null> {
  try {
    const db = getPool();
    const { rows } = await db.query(
      `UPDATE research_jobs
       SET status = 'stopped', completed_at = now()
       WHERE id = $1 AND status = 'running'
       RETURNING *`,
      [id]
    );
    return rows[0] || null;
  } catch {
    return null;
  }
}

export async function markError(id: number): Promise<void> {
  try {
    const db = getPool();
    await db.query(
      `UPDATE research_jobs SET status = 'error', completed_at = now()
       WHERE id = $1 AND status = 'running'`,
      [id]
    );
  } catch {
    // Best-effort terminal bookkeeping.
  }
}
