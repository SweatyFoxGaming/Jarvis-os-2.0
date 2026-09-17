# Jarvis Cognition Router (replaces the OmniRoute integration)

## Goal

Replace Jarvis's dependency on the external, self-hosted OmniRoute gateway with a Jarvis-owned router that provides the exact same interface every already-migrated call site uses today, backed instead by Jarvis's own multi-key provider pools (Groq, Gemini) with per-user fair-share quota tracking and a fallback chain down to the real local LLM endpoint and finally a keyword-based engine — so cloud-quota exhaustion degrades gracefully and fairly across multiple users, without ever depending on a third party's shared connection pool, and without requiring the operator to manually rotate in a new key every time one runs dry.

## Why

Live-testing the running OmniRoute instance surfaced the exact failure this design exists to prevent: a request to one of its combo routes failed with `exhausted_connection:auggie` — a real, reproduced error showing OmniRoute's "auto/*" routes depend on connection pools shared with other, unrelated OmniRoute users, entirely outside Jarvis's control. Jarvis is used by multiple people sharing the same instance, so this needed a real fix, not a workaround: quota exhaustion has to degrade gracefully and fairly (one heavy user shouldn't starve everyone else), and the operator shouldn't be stuck manually adding API keys every time a shared pool runs dry.

The prior OmniRoute integration (`feat/omniroute-cognition-gateway`, 7 of 11 tasks complete) already did real, valuable work: it replaced every direct Groq SDK / Gemini-native-for-chat call site with a generic `generateWithFallback(config, params, models)` call against a plain OpenAI-compatible `{baseUrl, apiKey}` HTTP endpoint. That abstraction was never actually OmniRoute-specific — it's a generic OpenAI-compatible chat-completions client. This design keeps that abstraction and its already-reviewed call-site migrations, and replaces only what answers the HTTP request.

## Architecture

Three new pieces, plus a rename of the now-misleadingly-named existing transport module:

1. **Key pool manager** (`src/runtime/key-pool.ts`) — holds, per provider (`groq`, `gemini`), an ordered list of API keys parsed from a comma-separated env var (`GROQ_API_KEYS`, `GEMINI_API_KEYS`). `getAvailableKey(provider)` returns the next key not currently on cooldown, round-robin among available keys to spread load. `reportFailure(provider, key, retryAfterSeconds?)` puts a key on cooldown (honoring a `Retry-After` header when the provider sends one, otherwise a conservative default). `reportSuccess(provider, key)` is a no-op today, reserved for future adaptive cooldown tuning.

2. **Per-user fair-share tracker** (`src/kernel/state/usage-repo.ts`) — a Postgres-backed sliding-window token counter per username (`recordUsage(username, tokens)`, `getRecentShare(username, windowMinutes)` returning that user's fraction of total pool usage in the window). Degrades cleanly when Postgres is unreachable — matching every other repo in this codebase — by reporting "no data, don't throttle" rather than blocking requests.

3. **Cognition router** (`src/runtime/cognition-router.ts`) — the new thing every call site actually talks to. `CognitionRouter.generateWithFallback(username, params, models)`:
   - Checks the requesting user's recent fair share via the usage tracker. If the user is significantly over an equal share (initial policy: more than 2x the average per-user share in the last 10 minutes) **and** the pool is currently under real strain (more than half of a provider's keys are on cooldown), the call is delayed a few seconds before proceeding — never rejected outright. A user with no recent history, or a pool with spare capacity, is never throttled.
   - Picks a provider in priority order (Groq first — already the faster/cheaper existing default — then Gemini via its documented OpenAI-compatible endpoint), gets an available key from the pool, and calls the renamed generic OpenAI-compatible HTTP client (below) with that provider's real base URL and the selected key.
   - On a 429/quota-shaped error, reports the failure to the key pool (cooldown) and retries with the next available key, then the next provider — bounded retries, matching this codebase's existing per-model-fallback-as-retry-mechanism convention (no blind retry-on-POST-5xx, per the `fetchWithRetry` lesson from earlier work this session).
   - If every key across every configured provider is genuinely exhausted, falls back to the operator-configured local LLM endpoint (`kernel.localLlmEndpoint`/`localModelName`/`localApiKey`, defaulting to the real `llama-cpp` Docker service already in this deployment) via the *same* generic OpenAI-compatible transport — **without** `tools` in the request, even if the caller passed them: this codebase already measured, live, that this local model ignores tool declarations entirely and pays 130+ seconds of latency for the privilege (see `server.ts`'s existing `LocalLLM` execution-chain step), so the router strips tools before this attempt rather than repeat that mistake. Reuses the existing `assertSafeEgressUrl`/`normalizeLocalLlmUrl` helpers (`src/kernel/egress.ts`) exactly as the current direct call site does.
   - If even the local LLM endpoint is unreachable or errors, falls through to `LocalCognitiveEngine.generateResponse()` (the trivial keyword-pattern engine already used as this codebase's absolute last resort in the same execution chain) — this tier never fails to return *something*, by construction.
   - Logs every fallback tier transition as a real observability event (`ObservationPlatform.logTelemetry`) so operators can see how often cloud capacity was actually exhausted, and how often it went all the way to the keyword engine — no silent quality degradation.
   - Records real usage (tokens actually consumed) back into the usage tracker after a successful cloud call.

**Correction from the first draft of this spec**: earlier revisions of this document described the fallback as "the existing local llama-cpp engine (`LocalCognitiveEngine`)," conflating two genuinely different things this codebase already has — the real local LLM server (`kernel.localLlmEndpoint`, a real llama.cpp/Ollama-class backend) and `LocalCognitiveEngine` (a trivial keyword-pattern responder with no actual model). The router's fallback chain is Groq keys → Gemini keys → the real local LLM endpoint (no tools) → the keyword engine, in that order — not a single "local" tier.

4. **Rename**: `src/runtime/omniroute-client.ts` → `src/runtime/openai-compatible-client.ts`. Its `generateWithFallback(config: {apiKey, baseUrl}, params, models)` function is unchanged in behavior — it was already a generic OpenAI-compatible chat-completions HTTP client, never actually OmniRoute-specific. The router calls this directly per provider attempt; it's an implementation detail now, not the top-level interface call sites use.

**Gemini via its OpenAI-compatible endpoint, not the native SDK**: Google's Gemini API has a documented, stable OpenAI-compatibility layer at `https://generativelanguage.googleapis.com/v1beta/openai/`. Using it means the exact same generic HTTP client handles both providers — no separate Gemini-shape translation layer needed, and the multi-turn tool-calling logic already written for the Groq/OmniRoute branch (the pattern Task 8 was going to mirror) works unchanged against Gemini too. This only covers text/tool-calling chat — Gemini's voice-native Live API and embeddings stay on the direct `@google/genai` SDK via `getAi()`, exactly as the original OmniRoute design already established (unaffected by this change).

## Components

| File | Responsibility |
|---|---|
| `src/runtime/key-pool.ts` | Create — per-provider key rotation, cooldown tracking on failure |
| `src/kernel/state/usage-repo.ts` | Create — Postgres-backed per-user sliding-window usage tracking, degrades cleanly |
| `src/kernel/state/migrations/00X_usage_events.ts` | Create — new migration for the usage-tracking table |
| `src/runtime/cognition-router.ts` | Create — orchestrates fair-share check → provider/key selection → attempt → retry-on-quota-error → local-fallback-on-total-exhaustion → usage recording |
| `src/runtime/omniroute-client.ts` → `src/runtime/openai-compatible-client.ts` | Rename — same `generateWithFallback({apiKey, baseUrl}, params, models)` behavior, now an internal transport detail the router calls per attempt, not the top-level interface |
| `src/runtime/clients.ts` | Modify — `getOmniRoute()`/`setSharedClient()` become `getCognitionRouter()`/`setSharedRouter()`, returning/holding a `CognitionRouter` instance instead of a plain config object |
| `src/server.ts` | Modify — client construction builds the key pools from `GROQ_API_KEYS`/`GEMINI_API_KEYS` (plural, comma-separated) instead of `OMNIROUTE_API_KEY`/`OMNIROUTE_BASE_URL`; `.env.example` updated accordingly; the still-unmigrated `/api/chat` Gemini branch and `/v1/chat/completions` (the two tasks that were paused, per the original plan's Tasks 8-9) now get built against the router directly, no separate migration needed later |
| Every existing `OmniRouteConfig`-typed call site (`departments.ts`, `identity.ts`, `reflection.ts`, `daily-adaptation.ts`, `knowledge-graph.ts`, `briefing.ts`, `groq-client.ts`, `groq-agent-client.ts`, `coding-agent.ts`, `scheduler.ts`, `autonomous_executive.ts`, `live-voice.ts`'s 3 narrow call sites) | Modify — retype `OmniRouteConfig \| null` parameters to `CognitionRouter \| null`; most already have `username` in scope at the call site (this is an inherently per-user system) and just need to pass it through to `generateWithFallback`. Two real exceptions found by audit: `departments.ts`'s `reviewCodeDiff` and `groq-agent-client.ts`'s `callGroqAgentChat` don't currently receive `username` as a parameter, though their callers (`build-requests-routes.ts`'s Express handler; the coding-agent call site) do have it available — these two need a new `username` parameter added and threaded through from their existing callers. |

## Data Flow

Call site (e.g. `departments.runResearch(objective, router, username)`) → `router.generateWithFallback(username, params, models)` → fair-share check against `usage-repo` → pick provider + available key from `key-pool` → attempt via `openai-compatible-client.ts`'s `generateWithFallback` against that provider's real base URL → on success, record usage, return the response → on 429/quota error, report failure to `key-pool` (cooldown), retry next key/provider → if every cloud key across every provider is exhausted, attempt the real local LLM endpoint (tools stripped) via the same transport → if that also fails, fall through to `LocalCognitiveEngine.generateResponse()` → log every tier transition, return the response in the same shape regardless of which tier answered.

## Error Handling

- A key on cooldown becomes available again after its cooldown window elapses (provider's `Retry-After` header if present, otherwise a conservative fixed default, configurable).
- `usage-repo` degrading when Postgres is unreachable means "don't throttle," never "block all requests" — matches this codebase's established degrade-cleanly convention for every other repo.
- Local-fallback is a real, logged event (`ObservationPlatform.logTelemetry`), not a silent substitution — operators can see how often cloud capacity was actually exhausted.
- Retries only happen across different keys/providers (matching the existing per-model-fallback pattern), never a blind retry against the same key/provider on a POST — the `fetchWithRetry` lesson from earlier work this session (don't retry non-idempotent requests blindly) still applies to how each individual attempt itself is made.

## Testing

- `key-pool.ts`: unit tests for rotation order, cooldown-then-recovery, all-keys-on-cooldown state (returns null, doesn't throw).
- `usage-repo.ts`: unit tests matching this codebase's existing repo-test convention — sliding-window accounting correctness, degrades cleanly (no throttling signal) when Postgres isn't reachable.
- `cognition-router.ts`: tests using injected fake key pool / usage tracker / local-LLM-fetch / keyword-engine (dependency injection — the same pattern already established this session for `shadow-verifier.ts`'s `execFn` parameter), asserting: normal-capacity requests aren't throttled, an over-share user under a strained pool is delayed not rejected, a 429 triggers cooldown-and-retry with the next key, full cloud exhaustion falls through to the local LLM tier with `tools` stripped from the request, and local-LLM-also-failing falls through to the keyword engine — each transition logged. No real network calls in automated tests.
- Manual verification against real provider keys (if available in the deployment environment) as a documented, evidence-based check — same convention this whole session has used for anything credential- or hardware-gated.

## Out of Scope

- The OmniRoute Docker container itself — dropped as a dependency; stopping/removing the running local instance is a manual operator step, not a code change in this plan.
- Supporting providers beyond Groq and Gemini in this first version — the design is provider-list-extensible in principle (add another entry to the pool config), but wiring in a third provider is future work.
- Per-user bring-your-own-key — explicitly considered and rejected during design discussion; the shared-pool-with-fair-share model was the chosen direction.
- Sophisticated ML-based quota prediction, dynamic pricing-aware routing, or adaptive cooldown-duration tuning — a simple sliding-window fair-share policy plus fixed/`Retry-After`-based cooldown is sufficient for this phase.
- Gemini's voice-native Live API and embeddings usage — entirely unaffected, stays on direct `@google/genai` SDK calls via `getAi()`, exactly as the original OmniRoute design already established.
