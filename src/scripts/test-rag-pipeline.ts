// src/scripts/test-rag-pipeline.ts
import { executeRAGPipeline } from '../kernel/state/ragEngine.js';

async function testPipeline() {
  const queryText = "TypeScript streaming Express handling";
  const mockQueryEmbedding = new Array(1536).fill(0.1);

  console.log(`[RAG Pipeline Test] Running query: "${queryText}"...`);

  const results = await executeRAGPipeline({
    queryText,
    queryEmbedding: mockQueryEmbedding,
    candidateLimit: 10,
    finalLimit: 2
  });

  console.log('\n--- Final Reranked Context Output ---');
  console.table(results);

  process.exit(0);
}

testPipeline().catch(err => {
  console.error('[RAG Test Error]', err);
  process.exit(1);
});
