import { getPool } from "./db.js";

export interface KgEntity {
  id: number;
  username: string;
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

export async function upsertEntity(username: string, name: string, entityType: string): Promise<number> {
  const db = getPool();
  const { rows } = await db.query(
    `INSERT INTO kg_entities (username, name, entity_type) VALUES ($1, $2, $3)
     ON CONFLICT (username, name, entity_type) DO UPDATE SET last_seen = now()
     RETURNING id`,
    [username, name, entityType]
  );
  return rows[0].id;
}

export async function addFact(entityId: number, fact: string): Promise<void> {
  const db = getPool();
  // Skip if an identical fact is already recorded for this entity — the
  // extraction call runs on every real turn, so repeated mentions of the
  // same stable fact ("uses PostgreSQL") shouldn't pile up duplicate rows.
  // ON CONFLICT (not a separate SELECT-then-INSERT) so two concurrent
  // extraction calls for the same entity/fact can't both pass a check and
  // both insert — see migration 007 for the unique constraint this relies on.
  await db.query(
    `INSERT INTO kg_facts (entity_id, fact) VALUES ($1, $2)
     ON CONFLICT (entity_id, fact) DO NOTHING`,
    [entityId, fact]
  );
}

export async function addRelationship(fromEntityId: number, toEntityId: number, relationship: string): Promise<void> {
  const db = getPool();
  await db.query(
    `INSERT INTO kg_relationships (from_entity_id, to_entity_id, relationship) VALUES ($1, $2, $3)
     ON CONFLICT (from_entity_id, to_entity_id, relationship) DO NOTHING`,
    [fromEntityId, toEntityId, relationship]
  );
}

export async function searchEntities(username: string, query: string, limit = 10): Promise<KgEntity[]> {
  const db = getPool();
  const { rows } = await db.query(
    `SELECT * FROM kg_entities WHERE username = $1 AND name ILIKE $2 ORDER BY last_seen DESC LIMIT $3`,
    [username, `%${query}%`, limit]
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

export async function listAllEntities(username: string, limit = 100): Promise<KgEntity[]> {
  const db = getPool();
  const { rows } = await db.query(
    `SELECT * FROM kg_entities WHERE username = $1 ORDER BY last_seen DESC LIMIT $2`,
    [username, limit]
  );
  return rows;
}
