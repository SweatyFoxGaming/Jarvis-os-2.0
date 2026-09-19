import { KeyPool, type Provider } from "./key-pool.js";
import { recordUsage, getRecentShare } from "../kernel/state/usage-repo.js";
import { generateWithFallback as realGenerateWithFallback, type OpenAiCompatibleConfig } from "./openai-compatible-client.js";
import { ObservationPlatform } from "../kernel/observation.js";
import { CognitiveWorkspace } from "../cognition/workspace.js";
import { assertSafeEgressUrl, normalizeLocalLlmUrl } from "../kernel/egress.js";

const observation = ObservationPlatform.getInstance();

const PROVIDER_BASE_URLS: Record<Provider, string> = {
  groq: "https://api.groq.com/openai/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai",
};

export const DEFAULT_THROTTLE_DELAY_MS = 3000;

function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const KNOWN_LOCAL_URL_SUFFIXES = ["/chat/completions", "/generate", "/api/chat"];
function stripKnownLocalSuffix(url: string): string {
  for (const suffix of KNOWN_LOCAL_URL_SUFFIXES) {
    if (url.endsWith(suffix)) {
      const stripped = url.slice(0, -suffix.length);
      return stripped.length > 0 ? stripped : url;
    }
  }
  return url;
}

const MAX_RETRY_AFTER_SECONDS = 3600;

function parseRetryAfterSeconds(err: any): number | undefined {
  let candidate: number | undefined;
  if (err && typeof err.retryAfterSeconds === "number") {
    candidate = err.retryAfterSeconds;
  } else {
    const message = typeof err?.message === "string" ? err.message : String(err ?? "");
    const match = message.match(/retry-after[:\s]+(\d+(?:\.\d+)?)/i);
    candidate = match ? Number(match[1]) : undefined;
  }
  if (candidate === undefined || !Number.isFinite(candidate)) return undefined;
  return Math.min(Math.max(candidate, 1), MAX_RETRY_AFTER_SECONDS);
}

function isModelNotFoundError(message: string): boolean {
  return /model_not_found/i.test(message);
}

function estimateTokens(response: any, params: any): number {
  const usage = response?.usage;
  if (usage && typeof usage.total_tokens === "number" && Number.isFinite(usage.total_tokens)) {
    return Math.max(1, Math.round(usage.total_tokens));
  }
  const requestChars = JSON.stringify(params?.messages ?? "").length;
  const responseChars = JSON.stringify(response?.choices ?? "").length;
  return Math.max(1, Math.round((requestChars + responseChars) / 4));
}

function extractLastUserMessage(params: any): string {
  const messages = Array.isArray(params?.messages) ? params.messages : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user" && typeof messages[i]?.content === "string") {
      return messages[i].content;
    }
  }
  const last = messages[messages.length - 1];
  return typeof last?.content === "string" ? last.content : "";
}

export interface RouterDeps {
  keyPool: KeyPool;
  recordUsage: typeof recordUsage;
  getRecentShare: typeof getRecentShare;
  localLlmEndpoint: string;
  localModelName: string;
  localApiKey?: string;
  localEngine: { generateResponse: (message: string, workspace: CognitiveWorkspace, systemMetrics: any) => string };
  getLocalConfig?: () => { endpoint: string; modelName: string; apiKey?: string };
  localToolCalling?: boolean;
  allowKeywordFallback?: boolean;
  transport?: (config: OpenAiCompatibleConfig, params: any, models: string[]) => Promise<any>;
  delayFn?: (ms: number) => Promise<void>;
  throttleDelayMs?: number;
}

export class CognitionRouter {
  private deps: RouterDeps;
  private transport: (config: OpenAiCompatibleConfig, params: any, models: string[]) => Promise<any>;
  private delayFn: (ms: number) => Promise<void>;
  private throttleDelayMs: number;

  constructor(deps: RouterDeps) {
    this.deps = deps;
    this.transport = deps.transport ?? realGenerateWithFallback;
    this.delayFn = deps.delayFn ?? defaultDelay;
    this.throttleDelayMs = deps.throttleDelayMs ?? DEFAULT_THROTTLE_DELAY_MS;
  }

  async generateWithFallback(username: string, params: any, models: string[]): Promise<any> {
    try {
      return await this.attemptFallbackChain(username, params, models);
    } catch (err: any) {
      observation.logTelemetry(
        "error",
        "Cognition",
        `CognitionRouter.generateWithFallback failed unexpectedly for "${username}" — returning a static degraded response instead of throwing: ${err?.message || err}`
      );
      return {
        choices: [
          {
            message: {
              role: "assistant",
              content: "I'm sorry, sir — I've run into an unexpected internal error and can't process that request right now. Please try again in a moment.",
            },
          },
        ],
        __provenance: { tier: "error", model: null },
      };
    }
  }

  private async attemptFallbackChain(username: string, params: any, models: string[]): Promise<any> {
    let share: number | null = null;
    try {
      share = await this.deps.getRecentShare(username, 10);
    } catch (err: any) {
      observation.logTelemetry("warn", "Cognition", `getRecentShare(${username}) threw unexpectedly, treating as "no throttling signal": ${err?.message || err}`);
      share = null;
    }

    const strain = this.deps.keyPool.strainRatio();
    if (share !== null && share > 2.0 && strain > 0.5) {
      observation.logTelemetry(
        "info",
        "Cognition",
        `Fair-share throttle: "${username}" is at ${share.toFixed(2)}x average recent share under a strained key pool (strain=${strain.toFixed(2)}); delaying ${this.throttleDelayMs}ms before proceeding (not rejecting).`
      );
      await this.delayFn(this.throttleDelayMs);
    }

    for (const model of models) {
      const sepIdx = model.indexOf(":");
      if (sepIdx === -1) {
        observation.logTelemetry("warn", "Cognition", `Skipping malformed model spec (expected "provider:model"): "${model}"`);
        continue;
      }
      const provider = model.slice(0, sepIdx);
      const realModel = model.slice(sepIdx + 1);

      if (provider === "local") {
        const local = this.deps.getLocalConfig?.() ?? {
          endpoint: this.deps.localLlmEndpoint,
          modelName: this.deps.localModelName,
          apiKey: this.deps.localApiKey,
        };
        try {
          const localParams = { ...(params ?? {}) };
          delete localParams.tools;
          delete localParams.tool_choice;

          const normalizedUrl = normalizeLocalLlmUrl(local.endpoint);
          assertSafeEgressUrl(normalizedUrl);
          const localConfig: OpenAiCompatibleConfig = {
            apiKey: local.apiKey ?? "",
            baseUrl: stripKnownLocalSuffix(normalizedUrl),
          };
          const response = await this.transport(localConfig, localParams, [realModel || local.modelName]);
          response.__provenance = { tier: "local", model: realModel || local.modelName };
          return response;
        } catch (err: any) {
          observation.logTelemetry("warn", "Cognition", `Explicit local model "${model}" failed: ${err?.message || err}`);
          continue;
        }
      }

      if (provider !== "groq" && provider !== "gemini") {
        observation.logTelemetry("warn", "Cognition", `Skipping model with unknown provider "${provider}": "${model}"`);
        continue;
      }

      const maxKeyAttempts = this.deps.keyPool.keyCount(provider);
      for (let attempt = 0; attempt < maxKeyAttempts; attempt++) {
        const key = await this.deps.keyPool.getAvailableKey(provider);
        if (key === null) {
          observation.logTelemetry("info", "Cognition", `No available ${provider} key (pool cooling down/exhausted); skipping model "${model}".`);
          break;
        }

        let response: any;
        try {
          const config: OpenAiCompatibleConfig = { apiKey: key, baseUrl: PROVIDER_BASE_URLS[provider] };
          response = await this.transport(config, params, [realModel]);
          this.deps.keyPool.reportSuccess(provider, key);
        } catch (err: any) {
          const message = err?.message || String(err);
          if (isModelNotFoundError(message)) {
            observation.logTelemetry(
              "warn",
              "Cognition",
              `Cloud model "${model}" does not exist on ${provider}'s live catalog (model_not_found) — moving to the next model without penalizing this key: ${message}`
            );
            break;
          }
          const retryAfterSeconds = parseRetryAfterSeconds(err);
          await this.deps.keyPool.reportFailure(provider, key, retryAfterSeconds);
          observation.logTelemetry(
            "warn",
            "Cognition",
            `Cloud model "${model}" failed on one ${provider} key (retrying the next available key for this provider, if any): ${message}`
          );
          continue;
        }

        try {
          await this.deps.recordUsage(username, estimateTokens(response, params));
        } catch (usageErr: any) {
          observation.logTelemetry(
            "warn",
            "Cognition",
            `recordUsage failed after an already-successful cloud call for "${username}" (response is still returned, only tagged below): ${usageErr?.message || usageErr}`
          );
        }
        response.__provenance = { tier: "cloud", provider, model: realModel };
        return response;
      }
    }

    // Tier 3: local LLM endpoint fallback on cloud exhaustion
    const local = this.deps.getLocalConfig?.() ?? {
      endpoint: this.deps.localLlmEndpoint,
      modelName: this.deps.localModelName,
      apiKey: this.deps.localApiKey,
    };
    observation.logTelemetry(
      "info",
      "Cognition",
      `Cloud tier exhausted for "${username}"; falling through to local LLM (${local.modelName} @ ${local.endpoint}).`
    );
    const localParams = { ...(params ?? {}) };
    delete localParams.tools;
    delete localParams.tool_choice;

    try {
      const normalizedUrl = normalizeLocalLlmUrl(local.endpoint);
      assertSafeEgressUrl(normalizedUrl);
      const localConfig: OpenAiCompatibleConfig = {
        apiKey: local.apiKey ?? "",
        baseUrl: stripKnownLocalSuffix(normalizedUrl),
      };
      const response = await this.transport(localConfig, localParams, [local.modelName]);
      response.__provenance = { tier: "local", model: local.modelName };
      return response;
    } catch (err: any) {
      observation.logTelemetry(
        "warn",
        "Cognition",
        `Local LLM tier failed for "${username}": ${err?.message || err}.`
      );
    }

    if (this.deps.allowKeywordFallback === false) {
      return {
        choices: [{ message: { content: "", role: "assistant" } }],
        __provenance: { tier: "error", model: "none" },
        __error: "All configured cognition providers are unavailable.",
      };
    }

    const lastUserMessage = extractLastUserMessage(params);
    const workspace = new CognitiveWorkspace();
    const systemMetrics = observation.getMetrics().system;
    const content = this.deps.localEngine.generateResponse(lastUserMessage, workspace, systemMetrics);
    return { choices: [{ message: { content, role: "assistant" } }], __provenance: { tier: "offline", model: "keyword-engine" } };
  }
}