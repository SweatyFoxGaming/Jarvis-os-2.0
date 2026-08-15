// src/services/llm.ts
import { GoogleGenAI } from '@google/genai'; // Adjust import based on your current SDK setup

// Pass the signal down into model generation calls
export async function streamLLMResponse(
  { prompt, signal }: { prompt: string; signal: AbortSignal },
  onChunk: (chunk: string) => void
) {
  // Pass signal to fetch/SDK request options
  const responseStream = await fetch('YOUR_LLM_ENDPOINT', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt }),
    signal // Attaches native fetch AbortSignal
  });

  if (!responseStream.body) return;

  const reader = responseStream.body.getReader();
  const decoder = new TextDecoder();

  try {
    while (true) {
      if (signal.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      onChunk(chunk);
    }
  } finally {
    reader.releaseLock();
  }
}
