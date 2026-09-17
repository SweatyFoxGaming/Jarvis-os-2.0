import { getPool, queryWithRetry } from "./db.js";
import { ObservationPlatform } from "../observation.js";

const observation = ObservationPlatform.getInstance();

export interface HistoryMessage {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: Date;
}

// Matches the in-memory bound in WorkspaceUserContext.addMessage() — no
// point rehydrating more than the working buffer ever keeps anyway.
const HISTORY_LIMIT = 50;

// The highest-frequency write in this codebase (every chat turn, for every
// user) -- the first real integration point for queryWithRetry's
// pool-exhaustion backoff, so a burst of concurrent chat turns retries
// instead of dropping a message on the first 5s pool timeout.
export async function appendMessage(username: string, role: string, content: string): Promise<void> {
  await queryWithRetry(
    "INSERT INTO conversation_history (username, role, content) VALUES ($1, $2, $3)",
    [username, role, content]
  );
}

export async function loadRecentHistory(username: string): Promise<HistoryMessage[]> {
  const db = getPool();
  const { rows } = await db.query(
    `SELECT role, content, created_at FROM conversation_history
     WHERE username = $1 ORDER BY created_at DESC LIMIT $2`,
    [username, HISTORY_LIMIT]
  );
  return rows.reverse().map((row: any) => ({
    role: row.role,
    content: row.content,
    timestamp: new Date(row.created_at),
  }));
}

// loadRecentHistory only ever reads the most recent HISTORY_LIMIT rows per
// user, so this table grows forever with nothing that would ever read the
// older rows back — pure storage growth with no read-side benefit. Called
// by the scheduler's data-retention job (src/kernel/scheduler.ts), never
// inline on a request path. Returns the deleted row count for the job's own
// logging, not surfaced to any user-facing endpoint.
export async function pruneOldMessages(retentionDays: number): Promise<number> {
  try {
    const db = getPool();
    const { rowCount } = await db.query(
      `DELETE FROM conversation_history WHERE created_at < now() - ($1 * interval '1 day')`,
      [retentionDays]
    );
    return rowCount ?? 0;
  } catch (err: any) {
    observation.logTelemetry("warn", "Session", `pruneOldMessages(${retentionDays}) failed: ${err.message}`);
    return 0;
  }
}
