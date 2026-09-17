// src/routes/streamRoute.ts
//
// Deliberately bypasses CognitionRouter: this route needs real
// token-by-token SSE streaming (ai.models.generateContentStream /
// groq.chat.completions.create({stream: true})), which
// CognitionRouter.generateWithFallback doesn't support today (it returns
// one complete response, matching the tool-calling/JSON-response shape
// every other call site in this codebase needs). A documented exception,
// same pattern as /api/voice-input staying on the direct Gemini SDK for
// its own reason — not an oversight. No multi-key rotation or fair-share
// throttling applies to this route as a result; it uses the first
// configured Groq key only.
import type { Request, Response } from 'express';
import { GoogleGenAI } from '@google/genai';
import Groq from 'groq-sdk';
import { MindKernel } from '../self/kernel.js';
import { normalizeLocalLlmUrl, assertSafeEgressUrl } from '../kernel/egress.js';
import { executeRAGPipeline } from '../kernel/state/ragEngine.js';
import { formatRAGContext } from '../kernel/state/contextFormatter.js';

const geminiApiKey = process.env.GEMINI_API_KEY || '';
// GROQ_API_KEY (singular) no longer exists in .env.example as of the
// CognitionRouter migration -- GROQ_API_KEYS (plural, comma-separated) is
// the real source of truth now. Take the first configured key; see the
// file-level comment above for why this route can't use the router's own
// multi-key rotation.
const groqApiKey = (process.env.GROQ_API_KEYS || '').split(',')[0]?.trim() || '';

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
    const kernel = MindKernel.getInstance();
    let enrichedPrompt = prompt;

    // RAG embeddings in this legacy streaming route are Gemini-only. Offline
    // mode deliberately skips that path instead of turning a streaming chat
    // endpoint into an implicit cloud dependency. The main /api/chat route is
    // the canonical cognition/tool path.
    if (!kernel.offlineMode && geminiApiKey) {
      try {
        const { generateEmbedding } = await import('../services/embeddings.js');
        const queryEmbedding = await generateEmbedding(prompt);
        const contextChunks = await executeRAGPipeline({
          queryText: prompt,
          queryEmbedding,
          candidateLimit: 15,
          finalLimit: 3,
          sessionId,
        });
        const formattedContext = formatRAGContext(contextChunks, 1500);
        enrichedPrompt = formattedContext ? `${formattedContext}\n\nUser Question: ${prompt}` : prompt;
      } catch (err: any) {
        console.warn(`[Stream RAG] unavailable; continuing without semantic context: ${err?.message || err}`);
      }
    }

    if (isAborted) return;

    let eventId = 1;

    if (kernel.offlineMode) {
      const targetUrl = normalizeLocalLlmUrl(kernel.localLlmEndpoint);
      assertSafeEgressUrl(targetUrl);
      const response = await fetch(targetUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(kernel.localApiKey ? { Authorization: `Bearer ${kernel.localApiKey}` } : {})
        },
        body: JSON.stringify({
          model: kernel.localModelName,
          messages: [{ role: 'user', content: enrichedPrompt }],
          stream: true,
        }),
        signal: AbortSignal.timeout(180000),
      });
      if (!response.ok) throw new Error(`Local LLM returned status ${response.status}`);
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      for await (const chunk of response.body as any) {
        if (isAborted) break;
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          let trimmed = line.trim();
          if (!trimmed) continue;
          if (trimmed.startsWith('data: ')) trimmed = trimmed.slice(6).trim();
          if (trimmed === '[DONE]') continue;
          try {
            const parsed = JSON.parse(trimmed);
            const text = parsed.choices?.[0]?.delta?.content || parsed.message?.content || parsed.response || '';
            if (text) res.write(`id: ${eventId++}\ndata: ${JSON.stringify({ text, provider: 'local', model: kernel.localModelName })}\n\n`);
          } catch { /* incomplete SSE frame */ }
        }
      }
      if (!isAborted) { res.write(`id: ${eventId}\ndata: [DONE]\n\n`); res.end(); }
      return;
    }

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

      // Secondary Fallback: Groq (llama-3.3-70b-versatile removed from
      // Groq's live catalog entirely — live-verified 2026-08-18, see
      // groq-agent-client.ts's DEFAULT_MODELS comment for the full history)
      const groqStream = await groq.chat.completions.create({
        model: 'openai/gpt-oss-120b',
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
