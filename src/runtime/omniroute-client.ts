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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

      // Implement retry logic for 5xx errors on LLM gateway endpoints
      // (Unlike fetchWithRetry which avoids retrying POST for safety, LLM requests
      // are inherently safe to retry and the gateway handles idempotency)
      let lastRequestError: any = null;
      for (let attempt = 0; attempt <= 3; attempt++) {
        try {
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

          if (res.status >= 500 && attempt < 3) {
            lastRequestError = new Error(`OmniRoute returned ${res.status}`);
            await sleep(500 * Math.pow(2, attempt));
            continue;
          }

          if (!res.ok) {
            const body = await res.text().catch(() => "");
            throw new Error(`OmniRoute returned ${res.status}: ${body}`);
          }

          const data = await res.json();
          observation.logTelemetry("info", "Cognition", `Successfully generated content with OmniRoute model: ${model}`);
          return data;
        } catch (error: any) {
          lastRequestError = error;
          if (attempt < 3 && error.message && error.message.includes("OmniRoute returned 5")) {
            // 5xx error, will retry
            continue;
          }
          throw error;
        }
      }
      throw lastRequestError || new Error(`OmniRoute request failed after retries`);
    } catch (error: any) {
      lastError = error;
      observation.logTelemetry("warn", "Cognition", `OmniRoute model ${model} failed: ${error.message || error}`);
    }
  }
  throw lastError || new Error("All fallback models failed content generation");
}
