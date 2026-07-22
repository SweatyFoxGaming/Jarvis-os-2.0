import { getPool } from "./db.js";

export type ReflectionCategory = "observation" | "commitment" | "opinion" | "realization";

export interface SelfReflection {
  id: number;
  category: ReflectionCategory;
  content: string;
  source_excerpt: string | null;
  created_at: Date;
}

export async function addSelfReflection(
  category: ReflectionCategory,
  content: string,
  sourceExcerpt?: string
): Promise<SelfReflection> {
  const db = getPool();
  const { rows } = await db.query(
    `INSERT INTO self_reflections (category, content, source_excerpt) VALUES ($1, $2, $3) RETURNING *`,
    [category, content, sourceExcerpt || null]
  );
  return rows[0];
}

export async function getRecentSelfReflections(limit = 20): Promise<SelfReflection[]> {
  const db = getPool();
  const { rows } = await db.query(
    `SELECT * FROM self_reflections ORDER BY created_at DESC LIMIT $1`,
    [limit]
  );
  return rows;
}

export async function searchSelfReflections(query: string, limit = 10): Promise<SelfReflection[]> {
  const db = getPool();
  const { rows } = await db.query(
    `SELECT * FROM self_reflections WHERE content ILIKE $1 ORDER BY created_at DESC LIMIT $2`,
    [`%${query}%`, limit]
  );
  return rows;
}

export async function countSelfReflections(): Promise<number> {
  const db = getPool();
  const { rows } = await db.query(`SELECT COUNT(*)::int AS n FROM self_reflections`);
  return rows[0].n;
}

export interface ProactiveThought {
  id: number;
  content: string;
  based_on_count: number;
  created_at: Date;
}

export async function saveProactiveThought(content: string, basedOnCount: number): Promise<ProactiveThought> {
  const db = getPool();
  const { rows } = await db.query(
    `INSERT INTO proactive_thoughts (content, based_on_count) VALUES ($1, $2) RETURNING *`,
    [content, basedOnCount]
  );
  return rows[0];
}

export async function getRecentProactiveThoughts(limit = 20): Promise<ProactiveThought[]> {
  const db = getPool();
  const { rows } = await db.query(
    `SELECT * FROM proactive_thoughts ORDER BY created_at DESC LIMIT $1`,
    [limit]
  );
  return rows;
}
