// src/kernel/state/hybridSearchMigration.ts
import { getPool } from './db.js';

export async function applyHybridSearchSchema() {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    await client.query(`CREATE EXTENSION IF NOT EXISTS vector;`);

    // Create base table if it doesn't exist
    await client.query(`
      CREATE TABLE IF NOT EXISTS memory_chunks (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        session_id VARCHAR(128),
        user_id VARCHAR(128) DEFAULT 'admin',
        content TEXT NOT NULL,
        embedding vector(768),
        metadata JSONB DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // Ensure session_id and user_id exist on existing tables
    await client.query(`
      ALTER TABLE memory_chunks 
      ADD COLUMN IF NOT EXISTS session_id VARCHAR(128),
      ADD COLUMN IF NOT EXISTS user_id VARCHAR(128) DEFAULT 'admin';
    `);

    // Ensure full-text search column exists
    await client.query(`
      ALTER TABLE memory_chunks 
      ADD COLUMN IF NOT EXISTS fts_vector tsvector 
      GENERATED ALWAYS AS (to_tsvector('english', coalesce(content, ''))) STORED;
    `);

    // Create indexes safely
    await client.query(`
      CREATE INDEX IF NOT EXISTS memory_chunks_fts_idx 
      ON memory_chunks USING gin(fts_vector);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS memory_chunks_session_idx 
      ON memory_chunks(session_id);
    `);

    await client.query('COMMIT');
    console.log('[Database] Production hybrid search schema & tenant indexes verified.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Database Error] Migration failed:', err);
    throw err;
  } finally {
    client.release();
  }
}
