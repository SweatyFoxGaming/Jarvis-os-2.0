import { fetchWithRetry } from "../kernel/http-retry.js";
import { ObservationPlatform } from "../kernel/observation.js";

const observation = ObservationPlatform.getInstance();

// A plain config object, not an SDK client instance — OmniRoute exposes a
// single OpenAI-compatible REST endpoint, so there's nothing to construct
// beyond the credential and base URL. Threaded through call sites the same
// way getGroq()'s Groq instance was, so every existing caller that already
// null-checks/passes a Groq client through keeps the identical shape,
// just retyped — see docs/superpowers/specs/2026-08-03-omniroute-cognition-gateway-design.md.
export interface OmniRouteConfig {
  apiKey: string;
  baseUrl: string;
}

/**
 * Direct transport analog of groq-client.ts's generateWithFallback and
 * server.ts's (removed) generateContentWithFallback — tries each model in
 * `models`, in order, via OmniRoute's OpenAI-compatible
 * POST /chat/completions, returns the first success, throws the last error
 * if every model fails. `params` is the same free-form OpenAI-compatible
 * request body shape (messages, tools, response_format, ...) both of those
 * functions already accepted.
 */
export async function generateWithFallback(config: OmniRouteConfig, params: any, models: string[]): Promise<any> {
  let lastError: any = null;
  for (const model of models) {
    try {
      observation.logTelemetry("info", "Cognition", `Attempting OmniRoute content generation with model: ${model}`);
      const res = await fetchWithRetry(
        `${config.baseUrl}/chat/completions`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify({ ...params, model }),
        },
        { label: `OmniRoute chat/completions (${model})` }
      );
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`OmniRoute returned ${res.status}: ${body}`);
      }
      const data = await res.json();
      observation.logTelemetry("info", "Cognition", `Successfully generated content with OmniRoute model: ${model}`);
      return data;
    } catch (error: any) {
      lastError = error;
      observation.logTelemetry("warn", "Cognition", `OmniRoute model ${model} failed: ${error.message || error}`);
    }
  }
  throw lastError || new Error("All fallback models failed content generation");
}
