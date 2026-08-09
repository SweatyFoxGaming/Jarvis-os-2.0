import type { GoogleGenAI } from "@google/genai";
import type { CognitionRouter } from "./cognition-router.js";

/**
 * ai/cognitionRouter are constructed once, in server.ts, from whichever API
 * keys are actually configured in .env — never reassigned afterward.
 * Extracted routers (in src/interaction/routes/) need to reach the same
 * already-constructed clients server.ts's own remaining routes (chat, voice)
 * still use directly, without re-constructing their own or awkwardly
 * threading them through a router factory function for every route that
 * happens to need one.
 *
 * ai stays a real GoogleGenAI instance — it's still used for embeddings
 * (memory-store.ts) and other Gemini call sites (e.g. vision tools),
 * neither of which this migration touches. (The voice-native mode this
 * comment used to cite, live-voice.ts, was removed by the local-voice-
 * daemon migration — voice now runs through the local Groq/CognitionRouter
 * pipeline in voice-session.ts instead, with no GoogleGenAI dependency of
 * its own.) cognitionRouter is a CognitionRouter
 * instance (see cognition-router.ts) — it owns the provider fallback chain
 * that replaced the single OmniRoute config object.
 *
 * Getters, not values captured at import time: server.ts's own top-level
 * code (which calls setSharedRouter()) runs after every module it imports
 * has already finished loading (that's how ES module evaluation order
 * works), so a router that read getCognitionRouter() at its own module's
 * top level would always see null. Reading it inside each request handler
 * instead — the same pattern ObservationPlatform.getInstance() already
 * uses — means it's always read long after server.ts's startup has
 * actually run.
 */
let aiClient: GoogleGenAI | null = null;
let cognitionRouter: CognitionRouter | null = null;

export function setSharedRouter(ai: GoogleGenAI | null, router: CognitionRouter | null): void {
  aiClient = ai;
  cognitionRouter = router;
}

export function getAi(): GoogleGenAI | null {
  return aiClient;
}

export function getCognitionRouter(): CognitionRouter | null {
  return cognitionRouter;
}
