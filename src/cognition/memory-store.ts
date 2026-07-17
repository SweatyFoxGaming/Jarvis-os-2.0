import { GoogleGenAI } from "@google/genai";
import { getPool, isVectorReady } from "../data/db.js";
import { ObservationPlatform } from "../observation/index.js";

const observation = ObservationPlatform.getInstance();

// Matches the `vector(768)` column in db.ts — text-embedding-004 defaults to
// 768 dimensions, so this stays consistent whichever provider actually answers.
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
      const response = await ai.models.embedContent({
        model: "text-embedding-004",
        contents: text,
      });
      const values = response.embeddings?.[0]?.values;
      if (values && values.length > 0) return values;
    } catch (err: any) {
      observation.logTelemetry("warn", "Memory", `Gemini embedding failed: ${err.message}`);
    }
  }

  if (localEndpoint) {
    try {
      const origin = new URL(localEndpoint).origin;
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
          `Local embedding request failed (${res.status}): ${body}. Try "ollama pull nomic-embed-text" on the host.`
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
  if (!isVectorReady()) return false;
  const embedding = await embedText(content, ai, localEndpoint);
  if (!embedding) return false;
  try {
    const db = getPool();
    await db.query(
      "INSERT INTO memory_embeddings (username, content, embedding) VALUES ($1, $2, $3::vector)",
      [username, content, toVectorLiteral(embedding)]
    );
    return true;
  } catch (err: any) {
    observation.logTelemetry("warn", "Memory", `Failed to store memory embedding: ${err.message}`);
    return false;
  }
}

export async function recall(
  username: string,
  query: string,
  ai: GoogleGenAI | null,
  localEndpoint: string | null,
  limit = 4
): Promise<string[]> {
  if (!isVectorReady()) return [];
  const embedding = await embedText(query, ai, localEndpoint);
  if (!embedding) return [];
  try {
    const db = getPool();
    const { rows } = await db.query(
      `SELECT content FROM memory_embeddings WHERE username = $1 ORDER BY embedding <=> $2::vector LIMIT $3`,
      [username, toVectorLiteral(embedding), limit]
    );
    return rows.map((r: any) => r.content);
  } catch (err: any) {
    observation.logTelemetry("warn", "Memory", `Failed to recall memory: ${err.message}`);
    return [];
  }
}
