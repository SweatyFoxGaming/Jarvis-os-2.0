// src/kernel/state/reranker.ts
import { HybridSearchResult } from './hybridRetrieval.js';

export interface RerankedResult extends HybridSearchResult {
  rerankScore: number;
}

/**
 * Normalizes RRF scores and applies a term-overlap and semantic coverage boost
 * to filter out candidates that pass vector search but lack critical prompt intent.
 */
export function rerankCandidates(
  query: string,
  candidates: HybridSearchResult[],
  topN: number = 3
): RerankedResult[] {
  const queryTerms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2);

  const scored = candidates.map((item) => {
    const contentLower = item.content.toLowerCase();
    
    // Count matches of essential terms in candidate text
    const matchedTerms = queryTerms.filter(term => contentLower.includes(term));
    const termOverlapRatio = queryTerms.length > 0 ? matchedTerms.length / queryTerms.length : 0;

    // Combine normalized RRF base score with contextual overlap boost
    const rerankScore = (item.rrfScore * 0.6) + (termOverlapRatio * 0.4);

    return {
      ...item,
      rerankScore
    };
  });

  // Sort descending by calculated rerankScore
  return scored
    .sort((a, b) => b.rerankScore - a.rerankScore)
    .slice(0, topN);
}
