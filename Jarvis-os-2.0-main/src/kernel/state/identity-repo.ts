import { getPool } from "./db.js";
import { ObservationPlatform } from "../observation.js";

const observation = ObservationPlatform.getInstance();

export type ReflectionCategory = "observation" | "commitment" | "opinion" | "realization";

export interface SelfReflection {
  id: number;
  username: string;
  category: ReflectionCategory;
  content: string;
  source_excerpt: string | null;
  created_at: Date;
}

export async function addSelfReflection(
  username: string,
  category: ReflectionCategory,
  content: string,
  sourceExcerpt?: string
): Promise<SelfReflection> {
  const db = getPool();
  const { rows } = await db.query(
    `INSERT INTO self_reflections (username, category, content, source_excerpt) VALUES ($1, $2, $3, $4) RETURNING *`,
    [username, category, content, sourceExcerpt || null]
  );
  return rows[0];
}

export async function getRecentSelfReflections(username: string, limit = 20): Promise<SelfReflection[]> {
  const db = getPool();
  const { rows } = await db.query(
    `SELECT * FROM self_reflections WHERE username = $1 ORDER BY created_at DESC LIMIT $2`,
    [username, limit]
  );
  return rows;
}

export async function searchSelfReflections(username: string, query: string, limit = 10): Promise<SelfReflection[]> {
  const db = getPool();
  const { rows } = await db.query(
    `SELECT * FROM self_reflections WHERE username = $1 AND content ILIKE $2 ORDER BY created_at DESC LIMIT $3`,
    [username, `%${query}%`, limit]
  );
  return rows;
}

export async function countSelfReflections(): Promise<number> {
  const db = getPool();
  const { rows } = await db.query(`SELECT COUNT(*)::int AS n FROM self_reflections`);
  return rows[0].n;
}

// Grows on a per-chat-turn basis (see extractSelfReflection) with no cap —
// unlike conversation_history/transcript_events, which already have a
// retention job (src/kernel/scheduler.ts's data-retention job), this table
// had none until a follow-up security review flagged it. Same pattern as
// pruneOldMessages in session-repo.ts.
export async function pruneOldSelfReflections(retentionDays: number): Promise<number> {
  try {
    const db = getPool();
    const { rowCount } = await db.query(
      `DELETE FROM self_reflections WHERE created_at < now() - ($1 * interval '1 day')`,
      [retentionDays]
    );
    return rowCount ?? 0;
  } catch (err: any) {
    observation.logTelemetry("warn", "Identity", `pruneOldSelfReflections(${retentionDays}) failed: ${err.message}`);
    return 0;
  }
}

export interface ProactiveThought {
  id: number;
  username: string;
  content: string;
  based_on_count: number;
  created_at: Date;
}

export async function saveProactiveThought(username: string, content: string, basedOnCount: number): Promise<ProactiveThought> {
  const db = getPool();
  const { rows } = await db.query(
    `INSERT INTO proactive_thoughts (username, content, based_on_count) VALUES ($1, $2, $3) RETURNING *`,
    [username, content, basedOnCount]
  );
  return rows[0];
}

export async function getRecentProactiveThoughts(username: string, limit = 20): Promise<ProactiveThought[]> {
  const db = getPool();
  const { rows } = await db.query(
    `SELECT * FROM proactive_thoughts WHERE username = $1 ORDER BY created_at DESC LIMIT $2`,
    [username, limit]
  );
  return rows;
}

// The proactive-self-reflection scheduler job (src/kernel/scheduler.ts,
// every 6h by default) writes here indefinitely with no cap — same gap as
// self_reflections above.
export async function pruneOldProactiveThoughts(retentionDays: number): Promise<number> {
  try {
    const db = getPool();
    const { rowCount } = await db.query(
      `DELETE FROM proactive_thoughts WHERE created_at < now() - ($1 * interval '1 day')`,
      [retentionDays]
    );
    return rowCount ?? 0;
  } catch (err: any) {
    observation.logTelemetry("warn", "Identity", `pruneOldProactiveThoughts(${retentionDays}) failed: ${err.message}`);
    return 0;
  }
}
