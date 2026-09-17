import { getPool } from "./db.js";
import { ObservationPlatform } from "../observation.js";

const observation = ObservationPlatform.getInstance();

export interface RapportSignal {
  id: number;
  username: string;
  toneDescriptor: string;
  formalityObserved: number | null;
  createdAt: Date;
}

// One write path, fire-and-forget from every caller's perspective — a
// failure to record a rapport signal must never block or fail the chat
// reply that generated it.
export async function recordRapportSignal(username: string, toneDescriptor: string, formalityObserved: number | null): Promise<void> {
  try {
    const db = getPool();
    await db.query(
      `INSERT INTO rapport_signals (username, tone_descriptor, formality_observed) VALUES ($1, $2, $3)`,
      [username, toneDescriptor, formalityObserved]
    );
  } catch (err: any) {
    observation.logTelemetry("warn", "RapportSignals", `recordRapportSignal(${username}) failed: ${err.message}`);
  }
}

// Most recent signals for this user, newest first. Returns [] (not an
// error) when Postgres is unreachable — the caller (buildRapportContext)
// treats an empty result identically to "no signal history yet," not a
// failure state.
export async function getRecentRapportSignals(username: string, limit = 8): Promise<RapportSignal[]> {
  try {
    const db = getPool();
    const { rows } = await db.query(
      `SELECT id, username, tone_descriptor AS "toneDescriptor", formality_observed AS "formalityObserved", created_at AS "createdAt"
       FROM rapport_signals WHERE username = $1 ORDER BY created_at DESC LIMIT $2`,
      [username, limit]
    );
    return rows;
  } catch (err: any) {
    observation.logTelemetry("warn", "RapportSignals", `getRecentRapportSignals(${username}) failed: ${err.message}`);
    return [];
  }
}
