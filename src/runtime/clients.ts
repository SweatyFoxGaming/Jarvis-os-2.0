import type { GoogleGenAI } from "@google/genai";
import type Groq from "groq-sdk";

/**
 * ai/groq/nvidiaApiKey are constructed once, in server.ts, from whichever
 * API keys are actually configured in .env — never reassigned afterward.
 * Extracted routers (in src/interaction/routes/) need to reach the same
 * already-constructed clients server.ts's own remaining routes (chat, voice)
 * still use directly, without re-constructing their own or awkwardly
 * threading them through a router factory function for every route that
 * happens to need one.
 *
 * Getters, not values captured at import time: server.ts's own top-level
 * code (which calls setSharedClients()) runs after every module it imports
 * has already finished loading (that's how ES module evaluation order
 * works), so a router that read getGroq() at its own module's top level
 * would always see null. Reading it inside each request handler instead —
 * the same pattern ObservationPlatform.getInstance() already uses — means
 * it's always read long after server.ts's startup has actually run.
 */
let aiClient: GoogleGenAI | null = null;
let groqClient: Groq | null = null;
let nvidiaKey: string | null = null;

export function setSharedClients(ai: GoogleGenAI | null, groq: Groq | null, nvidiaApiKey: string | null): void {
  aiClient = ai;
  groqClient = groq;
  nvidiaKey = nvidiaApiKey;
}

export function getAi(): GoogleGenAI | null {
  return aiClient;
}

export function getGroq(): Groq | null {
  return groqClient;
}

export function getNvidiaApiKey(): string | null {
  return nvidiaKey;
}
