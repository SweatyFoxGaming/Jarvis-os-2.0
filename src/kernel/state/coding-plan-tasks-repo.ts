import { getPool } from "./db.js";

export interface PlanTaskRow {
  id: number;
  build_request_id: number;
  seq: number;
  title: string;
  description: string;
  status: string;
  summary: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface PlannedTaskInput {
  seq: number;
  title: string;
  description: string;
}

// Best-effort like every write in build-requests-repo.ts / transcript-events-repo.ts
// — a missed plan-status write must never abort the coding session itself.
export async function createPlan(buildRequestId: number, tasks: PlannedTaskInput[]): Promise<void> {
  try {
    const db = getPool();
    for (const task of tasks) {
      await db.query(
        `INSERT INTO coding_plan_tasks (build_request_id, seq, title, description) VALUES ($1, $2, $3, $4)`,
        [buildRequestId, task.seq, task.title, task.description]
      );
    }
  } catch {
    // Best-effort — see comment above.
  }
}

export async function updateTaskStatus(
  buildRequestId: number,
  seq: number,
  status: string,
  summary?: string
): Promise<void> {
  try {
    const db = getPool();
    await db.query(
      `UPDATE coding_plan_tasks SET status = $1, summary = COALESCE($2, summary), updated_at = now() WHERE build_request_id = $3 AND seq = $4`,
      [status, summary ?? null, buildRequestId, seq]
    );
  } catch {
    // Best-effort.
  }
}

export async function listPlanTasks(buildRequestId: number): Promise<PlanTaskRow[]> {
  try {
    const db = getPool();
    const { rows } = await db.query(
      `SELECT * FROM coding_plan_tasks WHERE build_request_id = $1 ORDER BY seq ASC`,
      [buildRequestId]
    );
    return rows;
  } catch {
    return [];
  }
}
