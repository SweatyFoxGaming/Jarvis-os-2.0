// src/scripts/test-hybrid-rag.ts
import { getPool } from '../kernel/state/db.js';
import { searchHybridMemory } from '../kernel/state/hybridRetrieval.js';

async function runTest() {
  const pool = getPool();

  console.log('[Test] Seeding dummy memory chunks...');
  
  // Seed sample records
  await pool.query(`
    INSERT INTO memory_chunks (content, embedding)
    VALUES 
      ('Jarvis OS kernel uses TypeScript and Express for streaming response handling.', array_fill(0.1, ARRAY[1536])::vector),
      ('PostgreSQL pgvector enables fast cosine similarity search across text embeddings.', array_fill(0.2, ARRAY[1536])::vector),
      ('Reciprocal Rank Fusion merges vector rankings with standard full-text search scores.', array_fill(0.1, ARRAY[1536])::vector)
    ON CONFLICT DO NOTHING;
  `);

  // Mock embedding vector for query
  const mockQueryEmbedding = new Array(1536).fill(0.1);
  const queryText = "TypeScript streaming Express";

  console.log(`[Test] Running hybrid search for query: "${queryText}"...`);
  
  const results = await searchHybridMemory(queryText, mockQueryEmbedding, 3);
  
  console.log('\n--- Hybrid RRF Search Results ---');
  console.table(results);

  process.exit(0);
}

runTest().catch((err) => {
  console.error('[Test Failed]', err);
  process.exit(1);
});
