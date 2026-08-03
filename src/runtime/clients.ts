import type { GoogleGenAI } from "@google/genai";
import type { OmniRouteConfig } from "./omniroute-client.js";

/**
 * ai/omniRoute are constructed once, in server.ts, from whichever API keys
 * are actually configured in .env — never reassigned afterward. Extracted
 * routers (in src/interaction/routes/) need to reach the same
 * already-constructed clients server.ts's own remaining routes (chat, voice)
 * still use directly, without re-constructing their own or awkwardly
 * threading them through a router factory function for every route that
 * happens to need one.
 *
 * ai stays a real GoogleGenAI instance — it's still used for embeddings
 * (memory-store.ts) and voice-native mode (live-voice.ts), neither of
 * which this migration touches. omniRoute is a plain config object, not an
 * SDK instance — OmniRoute is a single OpenAI-compatible REST endpoint,
 * nothing to construct beyond the credential/base URL. Groq's own client
 * slot is removed entirely: all of Groq's usage was chat-completions-shaped
 * and now goes through omniRoute instead.
 *
 * Getters, not values captured at import time: server.ts's own top-level
 * code (which calls setSharedClient()) runs after every module it imports
 * has already finished loading (that's how ES module evaluation order
 * works), so a router that read getOmniRoute() at its own module's top
 * level would always see null. Reading it inside each request handler
 * instead — the same pattern ObservationPlatform.getInstance() already
 * uses — means it's always read long after server.ts's startup has
 * actually run.
 */
let aiClient: GoogleGenAI | null = null;
let omniRouteConfig: OmniRouteConfig | null = null;

export function setSharedClient(ai: GoogleGenAI | null, omniRoute: OmniRouteConfig | null): void {
  aiClient = ai;
  omniRouteConfig = omniRoute;
}

export function getAi(): GoogleGenAI | null {
  return aiClient;
}

export function getOmniRoute(): OmniRouteConfig | null {
  return omniRouteConfig;
}
