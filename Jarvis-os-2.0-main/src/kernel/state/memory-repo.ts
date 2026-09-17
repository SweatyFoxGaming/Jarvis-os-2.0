import { getPool } from "./db.js";

export interface MemoryRecord {
  uuid: string;
  content: string;
  source: string;
  importance: number;
}

// Original demo seed content, preserved so existing deployments see the same
// starting records — now persisted in Postgres instead of reset every restart.
const SEED_RECORDS: MemoryRecord[] = [
  { uuid: "rec-1", content: "Executive goal: Integrate PostgreSQL for digital twins", source: "System", importance: 8 },
  { uuid: "rec-2", content: "User preference: Prefers dark slate aesthetic for graph nodes", source: "User", importance: 6 },
  { uuid: "rec-3", content: "Cognitive pattern: Auto-consolidation loop ran successfully", source: "Engine", importance: 5 },
];

export async function seedMemoryRecords(): Promise<void> {
  const db = getPool();
  const { rows } = await db.query("SELECT COUNT(*)::int AS n FROM memory_records");
  if (rows[0].n > 0) return;
  for (const rec of SEED_RECORDS) {
    await db.query(
      "INSERT INTO memory_records (uuid, content, source, importance) VALUES ($1,$2,$3,$4) ON CONFLICT (uuid) DO NOTHING",
      [rec.uuid, rec.content, rec.source, rec.importance]
    );
  }
}

export async function getPendingRecords(): Promise<MemoryRecord[]> {
  const db = getPool();
  const { rows } = await db.query(
    "SELECT uuid, content, source, importance FROM memory_records ORDER BY created_at ASC"
  );
  return rows;
}

export async function removeMemoryRecord(uuid: string): Promise<MemoryRecord | null> {
  const db = getPool();
  const { rows } = await db.query(
    "DELETE FROM memory_records WHERE uuid = $1 RETURNING uuid, content, source, importance",
    [uuid]
  );
  return rows[0] || null;
}

export async function clearMemoryRecords(): Promise<MemoryRecord[]> {
  const db = getPool();
  const { rows } = await db.query(
    "DELETE FROM memory_records RETURNING uuid, content, source, importance"
  );
  return rows;
}

export async function countMemoryRecords(): Promise<number> {
  const db = getPool();
  const { rows } = await db.query("SELECT COUNT(*)::int AS n FROM memory_records");
  return rows[0].n;
}
