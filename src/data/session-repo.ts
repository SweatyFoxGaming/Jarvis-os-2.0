import { getPool } from "./db.js";

export interface HistoryMessage {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: Date;
}

// Matches the in-memory bound in WorkspaceUserContext.addMessage() — no
// point rehydrating more than the working buffer ever keeps anyway.
const HISTORY_LIMIT = 50;

export async function appendMessage(username: string, role: string, content: string): Promise<void> {
  const db = getPool();
  await db.query(
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
