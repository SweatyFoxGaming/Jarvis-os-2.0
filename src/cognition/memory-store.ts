import { GoogleGenAI } from "@google/genai";
import { getPool, isVectorReady } from "../kernel/state/db.js";
import { ObservationPlatform } from "../kernel/observation.js";

const observation = ObservationPlatform.getInstance();

// Matches the `vector(768)` column in db.ts — gemini-embedding-001 defaults
// to 3072 dimensions, so outputDimensionality is pinned to 768 explicitly
// below to stay consistent whichever provider actually answers.
const EMBEDDING_DIMENSIONS = 768;

/**
 * Tries Gemini's embedding endpoint first (if configured), then a local
 * Ollama instance's /api/embeddings. Returns null — not a fake vector — if
 * neither is available or working, so callers degrade gracefully instead of
 * storing/retrieving against garbage data.
 */
export async function embedText(text: string, ai: GoogleGenAI | null, localEndpoint: string | null): Promise<number[] | null> {
  if (ai) {
    try {
      // Confirmed live against the Gemini API's own model list — the older
      // "text-embedding-004" name used here previously 404s on the current
      // API version.
      const response = await ai.models.embedContent({
        model: "gemini-embedding-001",
        contents: text,
        config: { outputDimensionality: EMBEDDING_DIMENSIONS },
      });
      const values = response.embeddings?.[0]?.values;
      if (values && values.length > 0) return values;
    } catch (err: any) {
      observation.logTelemetry("warn", "Memory", `Gemini embedding failed: ${err.message}`);
    }
  }

  // The bundled local cognition server is llama.cpp, not Ollama. Do not
  // probe its HTTP endpoint as if it were an Ollama embedding server on every
  // memory operation; that creates avoidable 8s delays in strict offline mode.
  // A dedicated embedding endpoint can be configured when desired.
  const embeddingEndpoint = process.env.LOCAL_EMBEDDING_ENDPOINT || null;
  if (localEndpoint && embeddingEndpoint) {
    try {
      const origin = new URL(embeddingEndpoint).origin;
      const res = await fetch(`${origin}/api/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // nomic-embed-text is the most common Ollama-pullable embedding model;
        // if it isn't installed, Ollama returns a clear error we log and move on from.
        body: JSON.stringify({ model: "nomic-embed-text", prompt: text }),
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) {
        const data: any = await res.json();
        if (Array.isArray(data.embedding) && data.embedding.length > 0) {
          return data.embedding;
        }
      } else {
        const body = await res.text().catch(() => "");
        observation.logTelemetry(
          "warn",
          "Memory",
          `Local embedding request failed (${res.status}): ${body}. Verify LOCAL_EMBEDDING_ENDPOINT and its embedding model.`
        );
      }
    } catch (err: any) {
      observation.logTelemetry("warn", "Memory", `Local embedding request errored: ${err.message}`);
    }
  }

  return null;
}

function toVectorLiteral(embedding: number[]): string {
  if (embedding.length !== EMBEDDING_DIMENSIONS) {
    // Store whatever came back; pgvector will reject on insert if the
    // dimension truly mismatches the column, which is the honest outcome —
    // better than silently truncating/padding a real embedding.
  }
  return `[${embedding.join(",")}]`;
}

export async function remember(
  username: string,
  content: string,
  ai: GoogleGenAI | null,
  localEndpoint: string | null
): Promise<boolean> {
  // The content store remains useful when the embedding backend is absent
  // (for example, a strict offline install using only llama.cpp). Store the
  // memory with a NULL vector and let recall() use lexical matching below.
  try {
    const db = getPool();
    const embedding = isVectorReady() ? await embedText(content, ai, localEndpoint) : null;
    if (embedding) {
      await db.query(
        "INSERT INTO memory_embeddings (username, content, embedding) VALUES ($1, $2, $3::vector)",
        [username, content, toVectorLiteral(embedding)]
      );
    } else {
      await db.query(
        "INSERT INTO memory_embeddings (username, content, embedding) VALUES ($1, $2, NULL)",
        [username, content]
      );
    }
    return true;
  } catch (err: any) {
    observation.logTelemetry("warn", "Memory", `Failed to store memory embedding: ${err.message}`);
    return false;
  }
}

export async function searchMemory(embedding: number[], limit = 5) {
  try {
    const db = getPool();
    const formattedVector = `[${embedding.join(",")}]`;
    
    const result = await db.query(
      `SELECT id, content, 1 - (embedding <=> $1) AS similarity 
       FROM memory_embeddings 
       ORDER BY embedding <=> $1 
       LIMIT $2;`,
      [formattedVector, limit]
    );

    return result.rows;
  } catch (error: any) {
    console.error("[Memory Store Error] Search failed:", error.message || error);
    return []; // Return fallback array so the calling agent keeps running
  }
}

export async function recall(
  username: string,
  query: string,
  ai: GoogleGenAI | null,
  localEndpoint: string | null,
  limit = 4
): Promise<string[]> {
  const embedding = isVectorReady() ? await embedText(query, ai, localEndpoint) : null;
  try {
    const db = getPool();
    if (embedding) {
      const { rows } = await db.query(
        `SELECT content FROM memory_embeddings WHERE username = $1 AND embedding IS NOT NULL ORDER BY embedding <=> $2::vector LIMIT $3`,
        [username, toVectorLiteral(embedding), limit]
      );
      return rows.map((r: any) => r.content);
    }

    // Strict-offline fallback: rank by how many query tokens appear in the
    // stored memory. It is not pretending to be semantic similarity; it is a
    // deterministic local recall path that keeps memory alive without a
    // second model service.
    const tokens = [...new Set((query.toLowerCase().match(/[a-z0-9]{3,}/g) || []).slice(0, 12))];
    if (tokens.length === 0) return [];
    const clauses = tokens.map((_, i) => `LOWER(content) LIKE $${i + 2}`).join(" OR ");
    const params: any[] = [username, ...tokens.map((t) => `%${t}%`), limit];
    const { rows } = await db.query(
      `SELECT content, (${tokens.map((_, i) => `(CASE WHEN LOWER(content) LIKE $${i + 2} THEN 1 ELSE 0 END)`).join(" + ")}) AS match_score
       FROM memory_embeddings WHERE username = $1 AND (${clauses})
       ORDER BY match_score DESC, created_at DESC LIMIT $${tokens.length + 2}`,
      params
    );
    return rows.map((r: any) => r.content);
  } catch (err: any) {
    observation.logTelemetry("warn", "Memory", `Failed to recall memory: ${err.message}`);
    return [];
  }
}
