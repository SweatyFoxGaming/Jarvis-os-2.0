import { getPool } from "./db.js";
import { ObservationPlatform } from "../observation.js";

const observation = ObservationPlatform.getInstance();

export type ObjectiveRunStatus = "running" | "awaiting_consult" | "done" | "failed";

export interface ObjectiveRunRow {
  id: number;
  username: string;
  objective: string;
  status: ObjectiveRunStatus;
  build_request_id: number | null;
  started_at: Date;
  finished_at: Date | null;
  error_detail: string | null;
}

export type StartRunResult =
  | { ok: true; runId: number }
  // Expected, not exceptional — someone's already running an objective for
  // this user, exactly the case objective_runs_one_running_per_user_idx
  // (migrations/001_objective_runs.ts) exists to catch.
  | { ok: false; reason: "already_running" }
  // Distinct from "already_running" on purpose: if Postgres itself can't be
  // reached, the honest answer is "I don't know," not a false claim that
  // something's already in progress. Whether that should still block
  // executeObjective (fail closed on an uncertain lock state) or proceed
  // anyway is the caller's call, not this repo's.
  | { ok: false; reason: "unavailable" };

// A 'running' row left behind forever would be a bug or crash (finishRun
// failing, or the process dying between startRun and finishRun) — normal
// execution finishes in well under this window (a handful of LLM calls for
// the research/decomposition phase this lock actually guards; a full
// coding session is a separate, later call via confirmDirection, not
// covered by this same lock). Without a backstop, one such event would
// permanently lock a user out of ever running another objective again —
// the same "defense-in-depth against a stuck resource" reasoning as
// jarvis-builder's own container reaper.
const STALE_RUN_MINUTES = 30;

// This is the actual concurrency fix, not just bookkeeping: two concurrent
// /api/executive/run calls for the same user used to race on a bare
// in-memory SessionState singleton with nothing stopping them. Here, a
// second INSERT while one is already 'running' hits the partial unique
// index and fails with a real Postgres unique-violation (23505) — a
// structural guarantee, not caller discipline.
export async function startRun(username: string, objective: string): Promise<StartRunResult> {
  try {
    const db = getPool();
    await db.query(
      `UPDATE objective_runs SET status = 'failed', error_detail = 'Superseded — stale running row past the staleness threshold', finished_at = now()
       WHERE username = $1 AND status = 'running' AND started_at < now() - ($2 * interval '1 minute')`,
      [username, STALE_RUN_MINUTES]
    );
    const { rows } = await db.query(
      `INSERT INTO objective_runs (username, objective, status) VALUES ($1, $2, 'running') RETURNING id`,
      [username, objective]
    );
    return { ok: true, runId: rows[0].id };
  } catch (err: any) {
    if (err.code === "23505") {
      return { ok: false, reason: "already_running" };
    }
    observation.logTelemetry("warn", "ObjectiveRuns", `startRun("${username}") failed: ${err.message}`);
    return { ok: false, reason: "unavailable" };
  }
}

export async function finishRun(
  runId: number | null,
  status: Exclude<ObjectiveRunStatus, "running">,
  buildRequestId: number | null,
  errorDetail?: string
): Promise<void> {
  // null means startRun degraded to "proceed without a lock" (Postgres was
  // unreachable when this run started) — there's no row to close out.
  if (runId === null) return;
  try {
    const db = getPool();
    await db.query(
      `UPDATE objective_runs SET status = $1, build_request_id = $2, error_detail = $3, finished_at = now() WHERE id = $4`,
      [status, buildRequestId, errorDetail ?? null, runId]
    );
  } catch (err: any) {
    // Best-effort: a failed status update leaves the row looking
    // permanently 'running', which would incorrectly block this user's next
    // objective — logged so that's diagnosable, but not itself worth
    // crashing the caller over (the actual work already completed or failed
    // by this point; this is just closing out the record of it).
    observation.logTelemetry("warn", "ObjectiveRuns", `finishRun(${runId}) failed: ${err.message}`);
  }
}
