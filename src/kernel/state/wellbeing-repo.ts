import { getPool } from "./db.js";
import { ObservationPlatform } from "../observation.js";

const observation = ObservationPlatform.getInstance();

// UTC-bucket heuristic, not timezone-aware — this codebase doesn't track
// per-user timezone anywhere, so "late hour" here means 23:00-06:00 UTC,
// not the user's actual local night. A real, honestly-labeled limitation,
// not a claim of precision this data doesn't support.
const LATE_HOUR_START_UTC = 23;
const LATE_HOUR_END_UTC = 6;

// Fraction (0-1) of this user's messages in the last `days` days that fall
// in the late-hour band. Returns `null` (not 0) when Postgres is
// unreachable OR there are zero messages in the window — the caller must
// distinguish "no data" from "genuinely zero late-hour activity."
export async function getLateHourActivityRatio(username: string, days = 7): Promise<number | null> {
  try {
    const db = getPool();
    const { rows } = await db.query(
      `SELECT
         COUNT(*) FILTER (WHERE EXTRACT(HOUR FROM created_at) >= $2 OR EXTRACT(HOUR FROM created_at) < $3)::float AS late_count,
         COUNT(*)::float AS total_count
       FROM conversation_history
       WHERE username = $1 AND role = 'user' AND created_at > now() - ($4 * interval '1 day')`,
      [username, LATE_HOUR_START_UTC, LATE_HOUR_END_UTC, days]
    );
    const row = rows[0];
    if (!row || row.total_count === 0) return null;
    return row.late_count / row.total_count;
  } catch (err: any) {
    observation.logTelemetry("warn", "WellbeingRepo", `getLateHourActivityRatio(${username}) failed: ${err.message}`);
    return null;
  }
}

export async function getLastCheckinAt(username: string): Promise<Date | null> {
  try {
    const db = getPool();
    const { rows } = await db.query(`SELECT last_checkin_at FROM wellbeing_checkins WHERE username = $1`, [username]);
    return rows[0] ? new Date(rows[0].last_checkin_at) : null;
  } catch (err: any) {
    observation.logTelemetry("warn", "WellbeingRepo", `getLastCheckinAt(${username}) failed: ${err.message}`);
    return null;
  }
}

// Fire-and-forget upsert of the current timestamp for this user; never
// throws, matching every other write path in this codebase that must not
// block or fail the request that triggered it.
export async function recordCheckin(username: string): Promise<void> {
  try {
    const db = getPool();
    await db.query(
      `INSERT INTO wellbeing_checkins (username, last_checkin_at) VALUES ($1, now())
       ON CONFLICT (username) DO UPDATE SET last_checkin_at = now()`,
      [username]
    );
  } catch (err: any) {
    observation.logTelemetry("warn", "WellbeingRepo", `recordCheckin(${username}) failed: ${err.message}`);
  }
}
