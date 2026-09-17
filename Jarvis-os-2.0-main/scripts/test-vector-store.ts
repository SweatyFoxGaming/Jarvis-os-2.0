import { ToolVectorStore } from '../src/capabilities/ToolVectorStore';
import dotenv from 'dotenv';

dotenv.config();

async function runVectorTest() {
  console.log('====================================================');
  console.log('=== TESTING PGVECTOR TOOL STORAGE & SEMANTIC SEARCH ===');
  console.log('====================================================');

  const store = new ToolVectorStore();

  try {
    console.log('\n[1] Initializing database extension and schema...');
    await store.init();
    console.log('✓ Database table "system_tools" and extension "vector" verified.');

    console.log('\n[2] Generating mock 768-dim embeddings and registering tools...');
    // Generate mock normalized vectors for testing
    const mockVectorA = Array(768).fill(0).map((_, i) => Math.sin(i));
    const mockVectorB = Array(768).fill(0).map((_, i) => Math.cos(i));

    await store.upsertTool(
      'mavlink_telemetry_monitor',
      'Monitors vehicle heartbeat, battery percentage, and triggers emergency RTL/HOLD failsafes on drop.',
      mockVectorA,
      { category: 'hardware', version: '2.0' }
    );

    await store.upsertTool(
      'cad_stl_exporter',
      'Converts internal structured node graphs into valid 3D printable STL and 2D vector graphic blueprints.',
      mockVectorB,
      { category: 'manufacturing', version: '1.1' }
    );
    console.log('✓ Tools successfully upserted into vector database.');

    console.log('\n[3] Executing semantic search query...');
    // Query matching Vector A closely
    const results = await store.searchTools(mockVectorA, 2);
    
    console.log('Search Results:');
    for (const r of results) {
      console.log(`  └─ [Match: ${(r.similarity * 100).toFixed(2)}%] ${r.name}: ${r.description}`);
    }

    if (results.length > 0 && results[0].name === 'mavlink_telemetry_monitor') {
      console.log('\n✓ Semantic vector retrieval verified successfully!');
    } else {
      throw new Error('Semantic search ranking anomaly detected.');
    }

  } catch (err) {
    console.error('❌ Vector store test failed:', err);
    process.exit(1);
  } finally {
    await store.close();
  }
}

runVectorTest();
