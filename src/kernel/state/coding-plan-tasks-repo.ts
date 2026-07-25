import type { PoolClient } from "pg";
import { getPool } from "./db.js";
import { ObservationPlatform } from "../observation.js";

const observation = ObservationPlatform.getInstance();

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
// One batched, transactional INSERT rather than a query per task: the old
// per-task loop was N+1 (one round trip per task) *and* non-atomic — a
// failure partway through left the first few tasks committed with no
// signal to the caller that the plan was incomplete. A single multi-row
// VALUES list inside BEGIN/COMMIT makes "all tasks recorded" or "none are"
// the only two outcomes.
export async function createPlan(buildRequestId: number, tasks: PlannedTaskInput[]): Promise<void> {
  if (tasks.length === 0) return;
  const db = getPool();
  // db.connect() itself can reject (e.g. Postgres unreachable) — it has to
  // be inside the try along with the queries, not before it, or that
  // rejection would escape uncaught instead of degrading cleanly like every
  // other write in this file.
  let client: PoolClient | undefined;
  try {
    client = await db.connect();
    await client.query("BEGIN");
    const values: any[] = [];
    const placeholders = tasks.map((task, i) => {
      const base = i * 4;
      values.push(buildRequestId, task.seq, task.title, task.description);
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`;
    });
    await client.query(
      `INSERT INTO coding_plan_tasks (build_request_id, seq, title, description) VALUES ${placeholders.join(", ")}`,
      values
    );
    await client.query("COMMIT");
  } catch (err: any) {
    await client?.query("ROLLBACK").catch(() => {});
    // Best-effort — see comment above.
    observation.logTelemetry("warn", "CodingPlanTasks", `createPlan(${buildRequestId}) failed: ${err.message}`);
  } finally {
    client?.release();
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
  } catch (err: any) {
    // Best-effort.
    observation.logTelemetry("warn", "CodingPlanTasks", `updateTaskStatus(${buildRequestId}, seq=${seq}) failed: ${err.message}`);
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
  } catch (err: any) {
    observation.logTelemetry("warn", "CodingPlanTasks", `listPlanTasks(${buildRequestId}) failed: ${err.message}`);
    return [];
  }
}
