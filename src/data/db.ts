import pg from "pg";
import { ObservationPlatform } from "../observation/index.js";

const observation = ObservationPlatform.getInstance();

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({
      host: process.env.POSTGRES_HOST || "postgres",
      port: Number(process.env.POSTGRES_PORT) || 5432,
      user: process.env.POSTGRES_USER,
      password: process.env.POSTGRES_PASSWORD,
      database: process.env.POSTGRES_DB,
      max: 10,
    });
    pool.on("error", (err) => {
      observation.logTelemetry("warn", "Database", `Unexpected Postgres pool error: ${err.message}`);
    });
  }
  return pool;
}

async function createSchema(): Promise<void> {
  const db = getPool();
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      username TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS api_keys (
      key TEXT PRIMARY KEY,
      username TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS memory_records (
      uuid TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      source TEXT NOT NULL,
      importance INTEGER NOT NULL DEFAULT 5,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS capability_grants (
      username TEXT NOT NULL,
      capability TEXT NOT NULL,
      granted_by TEXT NOT NULL,
      granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (username, capability)
    );
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS conversation_history (
      id SERIAL PRIMARY KEY,
      username TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS conversation_history_username_idx ON conversation_history(username, created_at);`);
  await db.query(`
    CREATE TABLE IF NOT EXISTS oauth_tokens (
      provider TEXT PRIMARY KEY,
      access_token TEXT NOT NULL,
      refresh_token TEXT NOT NULL,
      expiry TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS briefings (
      id SERIAL PRIMARY KEY,
      content TEXT NOT NULL,
      item_count INTEGER NOT NULL DEFAULT 0,
      items JSONB NOT NULL DEFAULT '[]',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS evolution_analyses (
      id SERIAL PRIMARY KEY,
      analysis_type TEXT NOT NULL,
      score INTEGER NOT NULL,
      issues JSONB NOT NULL DEFAULT '[]',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS evolution_analyses_type_idx ON evolution_analyses(analysis_type, created_at);`);
  await db.query(`
    CREATE TABLE IF NOT EXISTS evolution_goals (
      id SERIAL PRIMARY KEY,
      metric TEXT NOT NULL,
      target_value DOUBLE PRECISION NOT NULL,
      comparator TEXT NOT NULL DEFAULT 'lte',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS kg_entities (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (name, entity_type)
    );
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS kg_facts (
      id SERIAL PRIMARY KEY,
      entity_id INTEGER NOT NULL REFERENCES kg_entities(id) ON DELETE CASCADE,
      fact TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS kg_relationships (
      id SERIAL PRIMARY KEY,
      from_entity_id INTEGER NOT NULL REFERENCES kg_entities(id) ON DELETE CASCADE,
      to_entity_id INTEGER NOT NULL REFERENCES kg_entities(id) ON DELETE CASCADE,
      relationship TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS kg_entities_name_idx ON kg_entities(name);`);
  await db.query(`CREATE INDEX IF NOT EXISTS kg_facts_entity_idx ON kg_facts(entity_id);`);
  await db.query(`
    CREATE TABLE IF NOT EXISTS self_reflections (
      id SERIAL PRIMARY KEY,
      category TEXT NOT NULL,
      content TEXT NOT NULL,
      source_excerpt TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS self_reflections_created_idx ON self_reflections(created_at);`);
  await db.query(`
    CREATE TABLE IF NOT EXISTS proactive_thoughts (
      id SERIAL PRIMARY KEY,
      content TEXT NOT NULL,
      based_on_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

// Kept separate from createSchema(): the pgvector extension requires a
// privilege the connecting role might not have (depends on how Postgres was
// provisioned), and semantic memory failing to initialize shouldn't block
// users/api_keys/memory_records, which don't need it.
let vectorReady = false;

async function createVectorSchema(): Promise<void> {
  const db = getPool();
  await db.query(`CREATE EXTENSION IF NOT EXISTS vector;`);
  await db.query(`
    CREATE TABLE IF NOT EXISTS memory_embeddings (
      id SERIAL PRIMARY KEY,
      username TEXT NOT NULL,
      content TEXT NOT NULL,
      embedding vector(768),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS memory_embeddings_username_idx ON memory_embeddings(username);`);
  vectorReady = true;
}

export function isVectorReady(): boolean {
  return vectorReady;
}

/**
 * Retries because the "postgres" container may still be accepting connections
 * when this process starts, even with depends_on in docker-compose.yml
 * (depends_on only waits for container start, not readiness).
 */
export async function initDatabase(retries = 5, delayMs = 2000): Promise<boolean> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await createSchema();
      observation.logTelemetry("info", "Database", "Postgres schema verified/initialized.");
      try {
        await createVectorSchema();
        observation.logTelemetry("info", "Database", "pgvector schema ready — semantic memory enabled.");
      } catch (vecErr: any) {
        observation.logTelemetry(
          "warn",
          "Database",
          `pgvector setup failed (${vecErr.message}) — semantic memory disabled, everything else unaffected.`
        );
      }
      return true;
    } catch (err: any) {
      observation.logTelemetry(
        "warn",
        "Database",
        `Postgres init attempt ${attempt}/${retries} failed: ${err.message}`
      );
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  observation.logTelemetry(
    "warn",
    "Database",
    "Postgres unavailable after retries — registration/login/persisted memory will fail until it recovers."
  );
  return false;
}
