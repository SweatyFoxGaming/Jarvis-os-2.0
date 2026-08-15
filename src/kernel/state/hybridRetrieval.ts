// src/kernel/state/hybridRetrieval.ts
import { getPool } from './db.js';
import { ObservationPlatform } from '../observation.js';

const observation = ObservationPlatform.getInstance();

export interface HybridSearchResult {
  id: string;
  content: string;
  rrfScore: number;
  vectorRank: number | null;
  textRank: number | null;
}

export async function searchHybridMemory(
  queryText: string,
  queryEmbedding: number[],
  limit = 5,
  sessionId?: string,
  k = 60
): Promise<HybridSearchResult[]> {
  const pool = getPool();
  const embeddingString = `[${queryEmbedding.join(',')}]`;

  const query = `
    WITH vector_search AS (
      SELECT 
        id, 
        content,
        ROW_NUMBER() OVER (ORDER BY embedding <=> $1::vector) AS rank
      FROM memory_chunks
      WHERE ($5::varchar IS NULL OR session_id = $5::varchar)
      ORDER BY embedding <=> $1::vector
      LIMIT 20
    ),
    text_search AS (
      SELECT 
        id, 
        content,
        ROW_NUMBER() OVER (ORDER BY ts_rank_cd(fts_vector, plainto_tsquery('english', $2)) DESC) AS rank
      FROM memory_chunks
      WHERE fts_vector @@ plainto_tsquery('english', $2)
        AND ($5::varchar IS NULL OR session_id = $5::varchar)
      ORDER BY rank
      LIMIT 20
    )
    SELECT 
      COALESCE(v.id, t.id) AS id,
      COALESCE(v.content, t.content) AS content,
      v.rank AS vector_rank,
      t.rank AS text_rank,
      (
        COALESCE(1.0 / ($3 + v.rank), 0.0) + 
        COALESCE(1.0 / ($3 + t.rank), 0.0)
      ) AS rrf_score
    FROM vector_search v
    FULL OUTER JOIN text_search t ON v.id = t.id
    ORDER BY rrf_score DESC
    LIMIT $4;
  `;

  // Degrades to "no RAG context" rather than failing the whole chat request
  // -- matches every other Postgres-backed repo function in this codebase.
  // Reachable in practice: applyHybridSearchSchema() (server.ts's boot
  // sequence) itself degrades cleanly on a Postgres outage, which means
  // memory_chunks may genuinely not exist yet on a given boot.
  try {
    const { rows } = await pool.query(query, [embeddingString, queryText, k, limit, sessionId || null]);

    return rows.map((row) => ({
      id: row.id,
      content: row.content,
      rrfScore: parseFloat(row.rrf_score),
      vectorRank: row.vector_rank ? parseInt(row.vector_rank, 10) : null,
      textRank: row.text_rank ? parseInt(row.text_rank, 10) : null
    }));
  } catch (err: any) {
    observation.logTelemetry("warn", "HybridRetrieval", `searchHybridMemory failed: ${err.message}`);
    return [];
  }
}
