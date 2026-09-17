// src/services/embeddings.ts
import { GoogleGenAI } from '@google/genai';

const apiKey = process.env.GEMINI_API_KEY || '';
const ai = new GoogleGenAI({ apiKey });

export async function generateEmbedding(text: string): Promise<number[]> {
  if (!apiKey) {
    throw new Error('[Embedding Service] GEMINI_API_KEY missing in environment.');
  }

  try {
    const response = await ai.models.embedContent({
      model: 'text-embedding-004',
      contents: [text],
    });

    const values = response.embeddings?.[0]?.values;
    if (!values) {
      throw new Error('Received empty embedding vector from Gemini API.');
    }

    return values;
  } catch (error: any) {
    console.error('[Embedding Error]', error?.message || error);
    throw error;
  }
}
