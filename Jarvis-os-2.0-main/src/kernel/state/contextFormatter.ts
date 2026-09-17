import type { RerankedResult } from './reranker.js';

/**
 * Formats reranked memory chunks into a context block while respecting a max token budget.
 */
export function formatRAGContext(chunks: RerankedResult[], maxTokens = 1500): string {
  if (!chunks || chunks.length === 0) {
    return '';
  }

  const maxChars = maxTokens * 4; // Approx ~4 chars per token
  let currentChars = 0;
  const selectedBlocks: string[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (!chunk) continue;

    const contentText = (chunk.content ?? '').trim();
    const blockText = `[Memory Record #${i + 1} | ID: ${chunk.id} | Relevance: ${((chunk.rerankScore ?? 0) * 100).toFixed(1)}%]\n${contentText}`;
    
    if (currentChars + blockText.length > maxChars) {
      break;
    }

    selectedBlocks.push(blockText);
    currentChars += blockText.length;
  }

  if (selectedBlocks.length === 0) return '';

  return `<retrieved_memory_context>
The following historical context and stored memory records were retrieved for this query:

${selectedBlocks.join('\n\n')}
</retrieved_memory_context>`.trim();
}