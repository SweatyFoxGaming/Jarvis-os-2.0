import { getPool } from "./db.js";
import type { PrioritizedItem } from "../../world/briefing.js";

export interface StoredBriefing {
  id: number;
  content: string;
  item_count: number;
  items: PrioritizedItem[];
  created_at: Date;
}

export async function saveBriefing(content: string, itemCount: number, items: PrioritizedItem[]): Promise<StoredBriefing> {
  const db = getPool();
  const { rows } = await db.query(
    `INSERT INTO briefings (content, item_count, items) VALUES ($1, $2, $3) RETURNING *`,
    [content, itemCount, JSON.stringify(items)]
  );
  return rows[0];
}

export async function getRecentBriefings(limit = 20): Promise<StoredBriefing[]> {
  const db = getPool();
  const { rows } = await db.query(
    `SELECT * FROM briefings ORDER BY created_at DESC LIMIT $1`,
    [limit]
  );
  return rows;
}
