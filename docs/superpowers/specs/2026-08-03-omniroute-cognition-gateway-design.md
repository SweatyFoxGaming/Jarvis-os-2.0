# Route Jarvis's Cognition Module Through a Self-Hosted OmniRoute Gateway

## Goal

Replace Jarvis's direct use of the `@google/genai` (Gemini) and `groq-sdk` (Groq) SDKs with a single OpenAI-compatible HTTP client pointed at a self-hosted OmniRoute gateway (already running locally at `http://127.0.0.1:20128`), so Jarvis's model access is no longer limited to Gemini/Groq specifically and can expand into OmniRoute's broader provider catalog (290+ providers, 90+ free) over time.

## Why

The user wants access to more/free models than Gemini and Groq alone provide, without giving up the reliability characteristics already earned through real production use — specifically the coding agent's hard-won, empirically-validated model fallback chain (`groq-agent-client.ts` documents four dead ends: a model that doesn't exist on this account, one with an 8,000 TPM rate limit too tight to finish a session, one that fails to parse tool-call output past a few turns, and a shared-quota collision with the main chat backend — before landing on `llama-3.3-70b-versatile` → `llama-3.1-8b-instant`). This migration must not silently regress that.

## Architecture

A single new module, `src/runtime/omniroute-client.ts`, replaces the two SDK-specific client slots in `src/runtime/clients.ts`. It is constructed once at startup from `OMNIROUTE_API_KEY` (new) and `OMNIROUTE_BASE_URL` (new, defaults to `http://127.0.0.1:20128/v1`), following the exact same late-binding getter pattern `clients.ts` already uses for `getAi()`/`getGroq()` (a getter function, not a value captured at import time, since `server.ts`'s startup code that constructs the real client runs after every module that might import a getter has already finished loading).

It exposes four functions, matching what Jarvis's code actually does today rather than mirroring a generic SDK:

- `generateText(prompt, systemInstruction?, models?)` — plain text completion.
- `generateStructured(prompt, schema, systemInstruction?, models?)` — today's Gemini `responseSchema` calls, translated to OpenAI's `response_format: {type: "json_schema", json_schema: {...}}`.
- `generateWithTools(prompt, tools, systemInstruction?, models?)` — today's Gemini `functionDeclarations` / Groq `tool_choice` calls, translated to OpenAI's `tools` array shape.
- `streamText(prompt, onChunk, systemInstruction?, models?)` — today's `generateContentStream` usage in the chat endpoint, translated to OpenAI's SSE streaming format.

Every function takes an explicit `models` parameter — a single model name or an ordered list — rather than picking a model itself or delegating to OmniRoute's own "auto" combo routing. This is a deliberate, non-negotiable constraint (see "Why," above): OmniRoute's automatic model selection has no knowledge of which specific models Jarvis has already empirically ruled out, so letting it choose could silently reintroduce a previously-solved failure mode. Every function is built on the existing `fetchWithRetry` helper (`src/kernel/http-retry.ts`), reusing its timeout/retry-after/telemetry behavior rather than introducing a second, differently-behaved HTTP client into the codebase.

## Components

| File | Change |
|---|---|
| `src/runtime/omniroute-client.ts` | Create — the four functions above, OpenAI-compat request/response translation, built on `fetchWithRetry` |
| `src/runtime/clients.ts` | Modify — `getAi()`/`getGroq()`/`setSharedClients()` become a single `getOmniRoute()`/`setSharedClient()` |
| `src/runtime/groq-client.ts` | Modify — `generateWithFallback` (the function that actually calls the SDK) keeps its exact external signature and behavior, calling `omniroute-client.ts` internally instead of `groq.chat.completions.create()`. `toGroqSchema` is pure data transformation (no SDK/API calls) and needs no changes at all — reused as-is by `omniroute-client.ts`'s schema translation, since it already solves "Gemini `Type`-shaped schema → lowercase JSON Schema" |
| `src/runtime/groq-agent-client.ts` | Modify — `DEFAULT_MODELS`, `JARVIS_CODING_AGENT_MODEL` override, and the tool-calling flow stay exactly as documented; only the transport underneath changes |
| `src/server.ts` | Modify — client construction (env vars, startup warning), plus the two real Gemini-specific call sites (`responseSchema`→structured, `functionDeclarations`→tools, `generateContentStream`→`streamText`) |
| `src/interaction/live-voice.ts` | Modify — same Gemini-specific translation work as `server.ts` |
| `src/interaction/routes/briefing-memory-routes.ts`, `knowledge-routes.ts`, `build-requests-routes.ts` | Modify — type-only change: these pass the client object through to `briefing.ts`/`departments.ts`, which already call through `groq-client.ts`'s shared helpers; no logic change |
| `.env.example` | Modify — document `OMNIROUTE_API_KEY`/`OMNIROUTE_BASE_URL` |

Every other file that currently imports `groq-client.ts`/`groq-agent-client.ts` (`daily-adaptation.ts`, `reflection.ts`, `knowledge-graph.ts`, `coding-agent.ts`, `identity.ts`, `reward-routes.ts`, `departments.ts`) calls through the shared `generateWithFallback`/`toGroqSchema` funnel and needs no changes beyond what a type signature update requires.

## Data Flow

Cognition code calls one of the four `omniroute-client.ts` functions with an explicit model name/list → the client builds an OpenAI-compatible request body → `fetchWithRetry` POSTs it to `${OMNIROUTE_BASE_URL}/chat/completions` with the `OMNIROUTE_API_KEY` credential → the response is parsed back into the same shape today's callers already expect (so downstream logic at each call site doesn't need to change beyond the call itself) → on a network error, non-2xx after retries, or timeout, the function catches it and falls back to `LocalCognitiveEngine`'s canned-response generation, so an OmniRoute outage degrades Jarvis to basic mode rather than breaking cognition entirely.

For `generateWithFallback`-style multi-model fallback (already used by the coding agent and main chat), the existing per-model try/catch loop is preserved unchanged — it now calls `omniroute-client.ts` once per model in the list instead of `groq.chat.completions.create()`, falling through to the next model on failure exactly as it does today, with the `LocalCognitiveEngine` fallback only kicking in if every model in the list fails (matching a total-outage scenario, not a single bad model).

## Error Handling

- **Startup**: if `OMNIROUTE_API_KEY` is unset, log a warning matching today's `GEMINI_API_KEY`/`GROQ_API_KEY`-missing warning style, and run in local-only mode (no separate direct-provider path remains as a backup, since this fully replaces the SDKs).
- **Per-call**: `fetchWithRetry` already handles transient failures (timeouts, 5xx, rate limits) with its existing retry/backoff logic — no new retry logic needed in `omniroute-client.ts` itself.
- **Total failure**: after retries are exhausted (or every model in a fallback list has failed), catch and route to `LocalCognitiveEngine`.
- **Schema/tool-call translation errors**: a malformed translation (e.g., an OpenAI response that doesn't parse into the shape a caller expects) is treated as a call failure — same fallback path as a network error, not a separate error class, since callers only need to know "did this call succeed or not."

## Testing

- Existing tests that mock `getAi()`/`getGroq()` are updated to mock the new `getOmniRoute()`.
- New unit tests for `omniroute-client.ts`'s schema-translation logic specifically (Gemini `responseSchema`-shaped input → OpenAI `json_schema` output, and the reverse for responses) since this is genuinely new logic, not a signature change.
- New unit tests for the `LocalCognitiveEngine` fallback path actually firing on a simulated OmniRoute failure.
- `generateWithFallback`'s existing per-model fallback behavior gets a test confirming it still tries every model in the list in order before falling through, now against the new transport.
- No live OmniRoute or live Gemini/Groq credentials required for any automated test — all HTTP calls are mocked, matching this codebase's existing testing conventions established throughout this project.

## Out of Scope

- Changing which specific models are requested (the exact model names/fallback lists stay as they are today; expanding the model list is a future, separate decision made one model at a time, informed by real testing — not part of this migration).
- OmniRoute's own configuration (provider credentials, dashboard setup) — that's the user's responsibility via OmniRoute's own UI, not something Jarvis's code manages.
- Routing Claude Code's own traffic through OmniRoute — explicitly out of scope per the earlier research finding that Anthropic doesn't support this pattern; not part of this project.
