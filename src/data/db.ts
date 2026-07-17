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
