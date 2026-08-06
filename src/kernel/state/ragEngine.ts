// src/kernel/state/ragEngine.ts
import { searchHybridMemory, HybridSearchResult } from './hybridRetrieval.js';
import { rerankCandidates, RerankedResult } from './reranker.js';

export interface RAGPipelineOptions {
  queryText: string;
  queryEmbedding: number[];
  candidateLimit?: number;
  finalLimit?: number;
  sessionId?: string;
}

export async function executeRAGPipeline(options: RAGPipelineOptions): Promise<RerankedResult[]> {
  const candidateLimit = options.candidateLimit || 20;
  const finalLimit = options.finalLimit || 3;

  const candidates: HybridSearchResult[] = await searchHybridMemory(
    options.queryText,
    options.queryEmbedding,
    candidateLimit,
    options.sessionId
  );

  if (candidates.length === 0) {
    return [];
  }

  return rerankCandidates(options.queryText, candidates, finalLimit);
}
