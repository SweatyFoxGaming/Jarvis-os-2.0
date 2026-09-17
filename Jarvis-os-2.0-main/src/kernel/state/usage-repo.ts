import { getPool } from "./db.js";
import { ObservationPlatform } from "../observation.js";

const observation = ObservationPlatform.getInstance();

// One write path, fire-and-forget from every caller's perspective — a
// failure to record a usage event must never block or fail the request
// that generated it.
export async function recordUsage(username: string, tokens: number): Promise<void> {
  try {
    const db = getPool();
    await db.query(`INSERT INTO usage_events (username, tokens) VALUES ($1, $2)`, [username, tokens]);
  } catch (err: any) {
    observation.logTelemetry("warn", "UsageEvents", `recordUsage(${username}) failed: ${err.message}`);
  }
}

// This user's token usage over the last `windowMinutes`, relative to what
// an equal per-user share of current traffic would be — i.e. userTokens /
// (totalTokens / distinctUserCount). A lone active user is always exactly
// their own equal share (1.0), never triggering "over share". Returns `0`
// when there's no usage in the window yet (never throttle on absence of
// data), and `null` when Postgres is unreachable — the caller treats `null`
// as "no throttling signal," distinct from the real "0" answer.
export async function getRecentShare(username: string, windowMinutes: number): Promise<number | null> {
  try {
    const db = getPool();
    const { rows } = await db.query(
      `SELECT
         COALESCE(SUM(tokens) FILTER (WHERE username = $1), 0)::float AS user_tokens,
         COALESCE(SUM(tokens), 0)::float AS total_tokens,
         COUNT(DISTINCT username)::int AS distinct_users
       FROM usage_events
       WHERE created_at > now() - ($2 * interval '1 minute')`,
      [username, windowMinutes]
    );
    const row = rows[0];
    if (!row || row.total_tokens === 0) return 0;
    const equalShare = row.total_tokens / row.distinct_users;
    return row.user_tokens / equalShare;
  } catch (err: any) {
    observation.logTelemetry("warn", "UsageEvents", `getRecentShare(${username}) failed: ${err.message}`);
    return null;
  }
}
