// src/routes/streamRoute.ts
import { Request, Response } from 'express';
import { GoogleGenAI } from '@google/genai';
import Groq from 'groq-sdk';
import { generateEmbedding } from '../services/embeddings.js';
import { executeRAGPipeline } from '../kernel/state/ragEngine.js';
import { formatRAGContext } from '../kernel/state/contextFormatter.js';

const geminiApiKey = process.env.GEMINI_API_KEY || '';
const groqApiKey = process.env.GROQ_API_KEY || '';

const ai = new GoogleGenAI({ apiKey: geminiApiKey });
const groq = new Groq({ apiKey: groqApiKey });

export async function handleChatStream(req: Request, res: Response) {
  const sessionId = (req.query.sessionId as string) || 'default';
  const prompt = req.body?.prompt || '';

  if (!prompt) {
    return res.status(400).json({ error: 'Prompt is required' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  let isAborted = false;
  req.on('close', () => {
    isAborted = true;
    console.log(`[Stream Aborted] Client disconnected. Session: ${sessionId}`);
  });

  try {
    const queryEmbedding = await generateEmbedding(prompt);

    const contextChunks = await executeRAGPipeline({
      queryText: prompt,
      queryEmbedding,
      candidateLimit: 15,
      finalLimit: 3,
      sessionId,
    });

    const formattedContext = formatRAGContext(contextChunks, 1500);
    const enrichedPrompt = formattedContext
      ? `${formattedContext}\n\nUser Question: ${prompt}`
      : prompt;

    if (isAborted) return;

    let eventId = 1;

    // Primary: Gemini API
    try {
      const responseStream = await ai.models.generateContentStream({
        model: 'gemini-2.5-flash',
        contents: [enrichedPrompt],
      });

      for await (const chunk of responseStream) {
        if (isAborted) break;
        const chunkText = chunk.text;
        if (chunkText) {
          res.write(`id: ${eventId++}\ndata: ${JSON.stringify({ text: chunkText, provider: 'gemini' })}\n\n`);
        }
      }
    } catch (geminiError: any) {
      console.warn(`[Cognition Failover] Gemini error (${geminiError?.message || geminiError}). Falling back to Groq...`);

      if (isAborted) return;

      // Secondary Fallback: Groq Llama 3.3 70B
      const groqStream = await groq.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: enrichedPrompt }],
        stream: true,
      });

      for await (const chunk of groqStream) {
        if (isAborted) break;
        const content = chunk.choices[0]?.delta?.content || '';
        if (content) {
          res.write(`id: ${eventId++}\ndata: ${JSON.stringify({ text: content, provider: 'groq' })}\n\n`);
        }
      }
    }

    if (!isAborted) {
      res.write(`id: ${eventId}\ndata: [DONE]\n\n`);
      res.end();
    }
  } catch (error: any) {
    console.error(`[Stream Error] Session: ${sessionId}:`, error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal Streaming Error' });
    } else if (!isAborted) {
      res.write(`data: ${JSON.stringify({ error: error.message || 'Stream generation failed' })}\n\n`);
      res.end();
    }
  }
}
