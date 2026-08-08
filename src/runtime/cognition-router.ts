import { KeyPool, Provider } from "./key-pool.js";
import { recordUsage, getRecentShare } from "../kernel/state/usage-repo.js";
import { generateWithFallback as realGenerateWithFallback, OpenAiCompatibleConfig } from "./openai-compatible-client.js";
import { ObservationPlatform } from "../kernel/observation.js";
import { CognitiveWorkspace } from "../cognition/workspace.js";
import { assertSafeEgressUrl, normalizeLocalLlmUrl } from "../kernel/egress.js";

const observation = ObservationPlatform.getInstance();

// Real base URLs for the two cloud providers KeyPool knows about — see
// docs/superpowers/specs/2026-08-03-omniroute-cognition-gateway-design.md
// and groq-client.ts/omniroute history for why these are the OpenAI-
// compatible endpoints rather than each vendor's native SDK surface.
const PROVIDER_BASE_URLS: Record<Provider, string> = {
  groq: "https://api.groq.com/openai/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai",
};

// Production value for the fair-share throttle delay. Overridable per
// RouterDeps.throttleDelayMs so tests don't have to actually wait 3s —
// mirrors Task 1's short-cooldown test pattern.
export const DEFAULT_THROTTLE_DELAY_MS = 3000;

function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The default transport (generateWithFallback) always appends
// "/chat/completions" onto whatever baseUrl it's given. normalizeLocalLlmUrl
// already returns a *fully qualified* request URL (it may end in
// "/chat/completions", "/generate", or "/api/chat" depending on the shape it
// detected). Passing that straight through as "baseUrl" would produce
// ".../chat/completions/chat/completions" for the common case — including
// this codebase's own default local endpoint, "http://llama-cpp:8080",
// which normalizes to ".../v1/chat/completions". Stripping a known suffix
// here lets the transport's own "+/chat/completions" reproduce the
// normalized URL exactly for that (dominant) case. See task-4-report.md for
// the full reasoning, including the known limitation for "/generate" and
// "/api/chat" shaped local servers.
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

// A provider's error body/message is untrusted input — it can be
// malicious or simply buggy (an absurdly long digit string, a value in
// the billions). Number("9".repeat(400)) is Infinity; a naive parse of
// that (or of a merely huge-but-finite value) straight into
// KeyPool.reportFailure's retryAfterSeconds would either permanently
// disable a key for the rest of the process lifetime (Infinity) or
// effectively permanently (a cooldown lasting decades). This ceiling is
// deliberately generous relative to any legitimate Retry-After value
// (real APIs send seconds to low minutes) while still being finite.
const MAX_RETRY_AFTER_SECONDS = 3600;

// Best-effort extraction of a retry delay from a failed transport call.
// The real generateWithFallback throws a plain Error with a message like
// "OpenAI-compatible endpoint returned 429: <body>" — it doesn't currently surface the
// Retry-After header value on the thrown error, so this falls back to
// KeyPool's own default cooldown in that case (which is the common,
// real-transport case today). This is deliberately written to also honor
// an explicit numeric `retryAfterSeconds` property on the error (test
// doubles and any future transport can set this) or a "retry-after: N"
// substring in the message, so the plumbing is ready the moment a richer
// error shape exists upstream. The extracted value — from EITHER branch —
// is always clamped/sanitized before being returned: a non-finite result
// (NaN/Infinity) returns `undefined` (KeyPool falls back to its own
// DEFAULT_COOLDOWN_SECONDS), and any finite result is clamped to
// [0, MAX_RETRY_AFTER_SECONDS]. Never trust a provider-controlled number
// straight through to a cooldown timer.
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
  // Floor at 1, not 0 — a hostile or buggy "retry-after: 0" (or a negative
  // value) must not zero out the cooldown this function exists to enforce;
  // it should behave like "cool down briefly," never "don't cool down."
  return Math.min(Math.max(candidate, 1), MAX_RETRY_AFTER_SECONDS);
}

// Prefers the response's own usage.total_tokens when the provider reported
// it; otherwise falls back to a rough ~4-chars-per-token estimate over the
// request messages and response content, so recordUsage always gets a
// meaningful, non-zero number even against a provider that omits `usage`.
// Clamped to a minimum of 1 on BOTH branches — a malformed provider
// response with a zero or negative usage.total_tokens must not be able to
// pollute the SUM(tokens) fair-share calculation in usage-repo.ts with a
// non-positive contribution.
function estimateTokens(response: any, params: any): number {
  const usage = response?.usage;
  if (usage && typeof usage.total_tokens === "number" && Number.isFinite(usage.total_tokens)) {
    return Math.max(1, Math.round(usage.total_tokens));
  }
  const requestChars = JSON.stringify(params?.messages ?? "").length;
  const responseChars = JSON.stringify(response?.choices ?? "").length;
  return Math.max(1, Math.round((requestChars + responseChars) / 4));
}

// The last user-authored message content, for handing to the offline
// keyword engine — which takes a single plain-string message, not the
// OpenAI-compatible `messages` array every other tier consumes.
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

// Deliberately NOT `workspace`/`systemMetrics` fields here: CognitiveWorkspace
// has a no-arg constructor (every compartment self-initializes) and
// ObservationPlatform.getInstance().getMetrics().system is cheap and always
// current, so the keyword-engine tier constructs a fresh, minimal
// CognitiveWorkspace and reads live metrics at the point of need inside
// generateWithFallback below, rather than from constructor-time-fixed
// values threaded in from a request that, for most callers of this router
// (departments.ts, identity.ts, reflection.ts, daily-adaptation.ts — all
// background jobs with no real per-request CognitiveWorkspace in scope),
// never existed in the first place.
export interface RouterDeps {
  keyPool: KeyPool;
  recordUsage: typeof recordUsage;
  getRecentShare: typeof getRecentShare;
  localLlmEndpoint: string;
  localModelName: string;
  localApiKey?: string;
  localEngine: { generateResponse: (message: string, workspace: CognitiveWorkspace, systemMetrics: any) => string };
  // Injectable transport seam — defaults to the real generateWithFallback
  // (openai-compatible-client.js) so tests never make a real network call.
  // Same DI pattern as this session's execFn-style seams elsewhere.
  transport?: (config: OpenAiCompatibleConfig, params: any, models: string[]) => Promise<any>;
  // Injectable delay seam for the fair-share throttle, so tests can use a
  // short wait instead of the real 3s default.
  delayFn?: (ms: number) => Promise<void>;
  throttleDelayMs?: number;
}

/**
 * The cognition router every LLM call in the app is meant to eventually go
 * through. Fallback chain, in order:
 *   1. Cloud providers, one key/model at a time, in the order given in
 *      `models` (provider-prefixed strings like "groq:llama-3.3-70b-versatile").
 *   2. The local LLM endpoint (tools/tool_choice stripped from params).
 *   3. The offline keyword-matching engine (LocalCognitiveEngine), wrapped
 *      into the same OpenAI-compatible response shape every other tier
 *      returns.
 *
 * Before any of that, a fair-share throttle *delays* (never rejects) a
 * request from a user who's recently consumed well over their equal share
 * of tokens, but only while the key pool is actually strained — a heavy
 * user under an idle pool is never penalized.
 */
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

  // The one guarantee every caller in the app is meant to rely on: this
  // method never throws. Any unexpected failure at any stage — including
  // in the keyword-engine tier, which is meant to be the unconditional
  // last resort — is caught here and turned into a static, honest,
  // OpenAI-compatible-shaped apology response instead of propagating,
  // since not every call site in this codebase defensively wraps its own
  // call to the router.
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
      };
    }
  }

  private async attemptFallbackChain(username: string, params: any, models: string[]): Promise<any> {
    let share: number | null = null;
    try {
      share = await this.deps.getRecentShare(username, 10);
    } catch (err: any) {
      // getRecentShare's real implementation already degrades to `null`
      // internally and never throws — but deps.getRecentShare is
      // injectable, so a caller/test-supplied implementation isn't bound
      // by that contract. Treat a throw exactly like `null`: "no
      // throttling signal," never a reason to fail the whole request.
      observation.logTelemetry("warn", "Cognition", `getRecentShare(${username}) threw unexpectedly, treating as "no throttling signal": ${err?.message || err}`);
      share = null;
    }
    // Computed once and reused for both the log line and the actual
    // throttle decision below — calling strainRatio() twice risked the
    // logged "strain=" value silently disagreeing with what was decided,
    // if the pool's cooldown state changed between the two calls.
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
      if (provider !== "groq" && provider !== "gemini") {
        observation.logTelemetry("warn", "Cognition", `Skipping model with unknown provider "${provider}": "${model}"`);
        continue;
      }

      // Retry within THIS provider across every one of its configured
      // keys before giving up on this model entry and moving to the next
      // one in `models`. This matters because every real call site in
      // this codebase passes a single-element `models` array — without
      // this inner loop, one transient 429 on a single key would fall
      // all the way through to the local LLM tier even with several
      // other healthy keys sitting in the pool for the same provider.
      // Bounded by keyCount(provider) (not just "until getAvailableKey
      // returns null") as a hard, finite circuit breaker independent of
      // KeyPool's own cooldown-driven termination.
      const maxKeyAttempts = this.deps.keyPool.keyCount(provider);
      for (let attempt = 0; attempt < maxKeyAttempts; attempt++) {
        const key = this.deps.keyPool.getAvailableKey(provider);
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
          const retryAfterSeconds = parseRetryAfterSeconds(err);
          this.deps.keyPool.reportFailure(provider, key, retryAfterSeconds);
          observation.logTelemetry(
            "warn",
            "Cognition",
            `Cloud model "${model}" failed on one ${provider} key (retrying the next available key for this provider, if any): ${err?.message || err}`
          );
          continue; // next key for the same provider/model
        }

        // Transport succeeded — `response` is already the value this call
        // is going to return. recordUsage from here on is a best-effort
        // side effect: nothing past this point may cause a real
        // successful result to be lost or replaced with a retry/failure.
        try {
          await this.deps.recordUsage(username, estimateTokens(response, params));
        } catch (usageErr: any) {
          observation.logTelemetry(
            "warn",
            "Cognition",
            `recordUsage failed after an already-successful cloud call for "${username}" (response is still returned unchanged): ${usageErr?.message || usageErr}`
          );
        }
        return response;
      }
    }

    // Tier 2: local LLM endpoint, tools stripped — a local model getting a
    // tool-calling request it can't fulfill is worse than one that never
    // saw the option (see local_engine.ts and server.ts's LocalLLM branch
    // for the measured cost of tool declarations against a real local
    // model).
    observation.logTelemetry(
      "info",
      "Cognition",
      `Cloud tier exhausted for "${username}"; falling through to the local LLM tier (${this.deps.localModelName} @ ${this.deps.localLlmEndpoint}).`
    );
    const localParams = { ...(params ?? {}) };
    delete localParams.tools;
    delete localParams.tool_choice;

    try {
      const normalizedUrl = normalizeLocalLlmUrl(this.deps.localLlmEndpoint);
      assertSafeEgressUrl(normalizedUrl);
      const localConfig: OpenAiCompatibleConfig = {
        apiKey: this.deps.localApiKey ?? "",
        baseUrl: stripKnownLocalSuffix(normalizedUrl),
      };
      const response = await this.transport(localConfig, localParams, [this.deps.localModelName]);
      return response;
    } catch (err: any) {
      observation.logTelemetry(
        "warn",
        "Cognition",
        `Local LLM tier failed for "${username}": ${err?.message || err}; falling through to the offline keyword engine.`
      );
    }

    // Tier 3: offline keyword engine — the unconditional final link in the
    // chain. No internal try/catch needed here: the outer
    // generateWithFallback() wrapper already guards this whole method, so
    // any failure here (e.g. a bug in an injected localEngine) still
    // degrades to the static apology response rather than throwing.
    const lastUserMessage = extractLastUserMessage(params);
    const workspace = new CognitiveWorkspace();
    const systemMetrics = observation.getMetrics().system;
    const content = this.deps.localEngine.generateResponse(lastUserMessage, workspace, systemMetrics);
    return { choices: [{ message: { content, role: "assistant" } }] };
  }
}
