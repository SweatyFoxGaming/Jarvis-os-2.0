import { getPool } from "./db.js";

export interface KgEntity {
  id: number;
  name: string;
  entity_type: string;
  first_seen: Date;
  last_seen: Date;
}

export interface KgFact {
  id: number;
  entity_id: number;
  fact: string;
  created_at: Date;
}

export interface KgRelationship {
  id: number;
  from_entity_id: number;
  to_entity_id: number;
  relationship: string;
}

export async function upsertEntity(name: string, entityType: string): Promise<number> {
  const db = getPool();
  const { rows } = await db.query(
    `INSERT INTO kg_entities (name, entity_type) VALUES ($1, $2)
     ON CONFLICT (name, entity_type) DO UPDATE SET last_seen = now()
     RETURNING id`,
    [name, entityType]
  );
  return rows[0].id;
}

export async function addFact(entityId: number, fact: string): Promise<void> {
  const db = getPool();
  // Skip if an identical fact is already recorded for this entity — the
  // extraction call runs on every real turn, so repeated mentions of the
  // same stable fact ("uses PostgreSQL") shouldn't pile up duplicate rows.
  const existing = await db.query(
    `SELECT 1 FROM kg_facts WHERE entity_id = $1 AND fact = $2 LIMIT 1`,
    [entityId, fact]
  );
  if (existing.rows.length > 0) return;
  await db.query(`INSERT INTO kg_facts (entity_id, fact) VALUES ($1, $2)`, [entityId, fact]);
}

export async function addRelationship(fromEntityId: number, toEntityId: number, relationship: string): Promise<void> {
  const db = getPool();
  const existing = await db.query(
    `SELECT 1 FROM kg_relationships WHERE from_entity_id = $1 AND to_entity_id = $2 AND relationship = $3 LIMIT 1`,
    [fromEntityId, toEntityId, relationship]
  );
  if (existing.rows.length > 0) return;
  await db.query(
    `INSERT INTO kg_relationships (from_entity_id, to_entity_id, relationship) VALUES ($1, $2, $3)`,
    [fromEntityId, toEntityId, relationship]
  );
}

export async function searchEntities(query: string, limit = 10): Promise<KgEntity[]> {
  const db = getPool();
  const { rows } = await db.query(
    `SELECT * FROM kg_entities WHERE name ILIKE $1 ORDER BY last_seen DESC LIMIT $2`,
    [`%${query}%`, limit]
  );
  return rows;
}

export async function getFactsForEntity(entityId: number): Promise<KgFact[]> {
  const db = getPool();
  const { rows } = await db.query(
    `SELECT * FROM kg_facts WHERE entity_id = $1 ORDER BY created_at ASC`,
    [entityId]
  );
  return rows;
}

export async function getRelationshipsForEntity(entityId: number): Promise<{ relationship: string; otherEntityName: string; direction: "from" | "to" }[]> {
  const db = getPool();
  const { rows } = await db.query(
    `SELECT r.relationship, e.name AS other_name, 'from' AS direction
       FROM kg_relationships r JOIN kg_entities e ON e.id = r.to_entity_id
       WHERE r.from_entity_id = $1
     UNION ALL
     SELECT r.relationship, e.name AS other_name, 'to' AS direction
       FROM kg_relationships r JOIN kg_entities e ON e.id = r.from_entity_id
       WHERE r.to_entity_id = $1`,
    [entityId]
  );
  return rows.map((r: any) => ({ relationship: r.relationship, otherEntityName: r.other_name, direction: r.direction }));
}

export async function listAllEntities(limit = 100): Promise<KgEntity[]> {
  const db = getPool();
  const { rows } = await db.query(`SELECT * FROM kg_entities ORDER BY last_seen DESC LIMIT $1`, [limit]);
  return rows;
}
