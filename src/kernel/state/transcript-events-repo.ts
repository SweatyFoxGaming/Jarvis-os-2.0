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
