import { getPool } from "./db.js";
import { ObservationPlatform } from "../observation.js";

const observation = ObservationPlatform.getInstance();

export interface TranscriptEventRow {
  id: number;
  build_request_id: number;
  seq: number;
  command: string;
  stdout: string;
  stderr: string;
  exit_code: number;
  created_at: Date;
}

// Best-effort like every write in build-requests-repo.ts — a missed
// transcript write must never abort the coding session itself, the loop's
// own error handling in coding-agent.ts is what matters for correctness.
export async function recordTranscriptEvent(
  buildRequestId: number,
  seq: number,
  command: string,
  stdout: string,
  stderr: string,
  exitCode: number
): Promise<void> {
  try {
    const db = getPool();
    await db.query(
      `INSERT INTO transcript_events (build_request_id, seq, command, stdout, stderr, exit_code) VALUES ($1, $2, $3, $4, $5, $6)`,
      [buildRequestId, seq, command, stdout, stderr, exitCode]
    );
  } catch (err: any) {
    // Best-effort — see comment above.
    observation.logTelemetry("warn", "TranscriptEvents", `recordTranscriptEvent(${buildRequestId}, seq=${seq}) failed: ${err.message}`);
  }
}

export async function listTranscriptEvents(buildRequestId: number): Promise<TranscriptEventRow[]> {
  try {
    const db = getPool();
    const { rows } = await db.query(
      `SELECT * FROM transcript_events WHERE build_request_id = $1 ORDER BY seq ASC`,
      [buildRequestId]
    );
    return rows;
  } catch (err: any) {
    observation.logTelemetry("warn", "TranscriptEvents", `listTranscriptEvents(${buildRequestId}) failed: ${err.message}`);
    return [];
  }
}

// Full stdout/stderr per shell command in an agentic coding session, with no
// cap per row and no row-count cap per build request — the single most
// concerning unbounded-growth table this codebase writes to. A build
// request's transcript is only ever read back while that specific build is
// still being reviewed (see server.ts's approve-code route); once it's long
// past that, keeping the raw output forever buys nothing. Called by the
// scheduler's data-retention job, never inline on a request path.
export async function pruneOldTranscriptEvents(retentionDays: number): Promise<number> {
  try {
    const db = getPool();
    const { rowCount } = await db.query(
      `DELETE FROM transcript_events WHERE created_at < now() - ($1 * interval '1 day')`,
      [retentionDays]
    );
    return rowCount ?? 0;
  } catch (err: any) {
    observation.logTelemetry("warn", "TranscriptEvents", `pruneOldTranscriptEvents(${retentionDays}) failed: ${err.message}`);
    return 0;
  }
}
