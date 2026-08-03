# Route Jarvis's Cognition Module Through a Self-Hosted OmniRoute Gateway

## Goal

Replace Jarvis's direct use of the `@google/genai` (Gemini) SDK for **text-based** cognition — chat, voice-input transcription, and the OpenAI-compatible `/v1/chat/completions` route — with a single OpenAI-compatible HTTP client pointed at a self-hosted OmniRoute gateway (already running locally at `http://127.0.0.1:20128`), so Jarvis's model access is no longer limited to Gemini/Groq specifically and can expand into OmniRoute's broader provider catalog (290+ providers, 90+ free) over time. Groq's existing usage migrates the same way, onto the same new client.

## Why

The user wants access to more/free models than Gemini and Groq alone provide, without giving up the reliability characteristics already earned through real production use — specifically the coding agent's hard-won, empirically-validated model fallback chain (`groq-agent-client.ts` documents four dead ends: a model that doesn't exist on this account, one with an 8,000 TPM rate limit too tight to finish a session, one that fails to parse tool-call output past a few turns, and a shared-quota collision with the main chat backend — before landing on `llama-3.3-70b-versatile` → `llama-3.1-8b-instant`). This migration must not silently regress that.

## Out of Scope: Voice-Native Mode

The `/ws/voice` WebSocket's voice-native mode uses Gemini's **Live API** (`ai.live.connect()` in `src/interaction/live-voice.ts`) — a bidirectional streaming session with audio modalities, live input/output transcription, and voice selection (`speechConfig.voiceConfig`). This has no OpenAI chat-completions equivalent; OmniRoute being OpenAI-compatible doesn't help here. Voice-native mode is explicitly **excluded** from this migration and keeps calling Gemini's Live API directly, unchanged — `GEMINI_API_KEY` remains required for that one feature specifically. `src/interaction/live-voice.ts` is **not** touched by this plan. Migrating voice-native mode (to an OpenAI Realtime-API-shaped integration, if OmniRoute even supports one well) is an explicit, separate, later decision.

## Architecture

A single new module, `src/runtime/omniroute-client.ts`, replaces the two SDK-specific client slots in `src/runtime/clients.ts`. It is constructed once at startup from `OMNIROUTE_API_KEY` (new) and `OMNIROUTE_BASE_URL` (new, defaults to `http://127.0.0.1:20128/v1`), following the exact same late-binding getter pattern `clients.ts` already uses (a getter function, not a value captured at import time, since `server.ts`'s startup code that constructs the real client runs after every module that might import a getter has already finished loading).

It exposes:

- `generateWithFallback(params, models)` — the direct analog of `groq-client.ts`'s existing function of the same name: tries each model in `models` in order via OpenAI-compatible `POST /chat/completions`, returns on first success, throws the last error if every model fails. `params` is the same free-form OpenAI-compatible request body shape (`messages`, `tools`, `response_format`, etc.) `groq-client.ts`'s version already accepts — this is a transport swap, not a new interface.
- `toOpenAiTools(declarations)` — converts this codebase's existing `FunctionDeclaration[]` shape (Gemini's `Type`-enum-tagged schema, produced by `getAllToolDeclarations()`) into OpenAI's `{type: "function", function: {...}}` array. **Reuses `groq-client.ts`'s existing `toGroqSchema`** for the actual type-enum translation (`Type.OBJECT` → `"object"`, etc.) and `additionalProperties` injection — that function already solves this exact problem for Groq's OpenAI-compatible API, and OmniRoute's is the same shape, so no new schema-translation logic is needed, only a thin wrapper matching OpenAI's `tools` array structure (which is what `toGroqTools` already produces — this may end up being a direct reuse of `toGroqTools`/`toGroqSchema` with no new code at all, confirmed during implementation).

No `generateStructured`/`generateWithTools`/`streamText` abstraction beyond this — the three real call sites being migrated (see Components) each build their own `params` object and call `generateWithFallback` directly, mirroring exactly how the existing Groq branch in `server.ts` already does it (`server.ts:704`, `toGroqTools(getAllToolDeclarations())`, then a Groq-shaped call). This keeps the new client a thin transport layer, not a second abstraction competing with the one `groq-client.ts` already provides.

Every function is built on the existing `fetchWithRetry` helper (`src/kernel/http-retry.ts`), reusing its timeout/retry-after/telemetry behavior rather than introducing a second, differently-behaved HTTP client into the codebase.

Every call site continues to pass its own explicit model name/list — `["gemini-3.5-flash", "gemini-3.1-flash-lite", "gemini-flash-latest"]` for the chat/transcription paths, `DEFAULT_MODELS` for the coding agent — rather than delegating to OmniRoute's own "auto" combo routing. This is a deliberate, non-negotiable constraint (see "Why," above): OmniRoute's automatic model selection has no knowledge of which specific models Jarvis has already empirically ruled out, so letting it choose could silently reintroduce a previously-solved failure mode.

## Components

| File | Change |
|---|---|
| `src/runtime/omniroute-client.ts` | Create — `generateWithFallback`, `toOpenAiTools` (or direct reuse of `toGroqTools`), built on `fetchWithRetry` against `${OMNIROUTE_BASE_URL}/chat/completions` |
| `src/runtime/clients.ts` | Modify — `getAi()`/`getGroq()`/`setSharedClients()` become a single `getOmniRoute()`/`setSharedClient()`. `getGroq()`'s callers (see below) switch to `getOmniRoute()` since Groq's own usage also migrates onto this client |
| `src/runtime/groq-client.ts` | Modify — `generateWithFallback` calls the new client's HTTP layer instead of `groq.chat.completions.create()`; keeps its exact external signature. `toGroqSchema`/`toGroqTools` need no changes — they're pure data transformation with no SDK dependency, reused as-is |
| `src/runtime/groq-agent-client.ts` | Modify — `DEFAULT_MODELS`, `JARVIS_CODING_AGENT_MODEL` override, and the tool-calling flow stay exactly as documented; only the transport underneath changes, via `groq-client.ts`'s already-updated `generateWithFallback` |
| `src/server.ts` | Modify — client construction (env vars, startup warning) at lines ~162–187; `generateContentWithFallback` (lines 193–214, the Gemini-specific wrapper) removed, its 4 call sites (voice-input transcription 352–362, chat initial turn 808–821, chat tool-followup 880–883, `/v1/chat/completions` 1071–1076) migrated to the new client, request/response shapes converted to OpenAI format matching the existing parallel Groq branch's pattern (`assistant` message with `tool_calls`, `tool` role messages per result — not Gemini's `functionResponse`-parts/`thought_signature` echo pattern, which is Gemini-Live/generateContent-specific and has no bearing on an OpenAI-shaped request) |
| `src/cognition/memory-store.ts` | Modify — `memoryStore.recall`/`memoryStore.remember` take `ai: GoogleGenAI | null` as a parameter; signature changes to accept the new client type. Only touches the non-voice call sites (`server.ts:439, 940`); the voice-specific call sites in `live-voice.ts` (out of scope) keep passing a real `GoogleGenAI` instance there, since that file is untouched |
| `src/capabilities/tools.ts` | Modify — `executeTool`'s `ai: GoogleGenAI | null` parameter (used at the non-voice call sites `server.ts:745, 843`) changes type to match; `getAllToolDeclarations()` itself is unchanged (still produces Gemini's `Type`-tagged `FunctionDeclaration[]`, translated at the call site same as today's Groq path already does) |
| `src/interaction/routes/briefing-memory-routes.ts`, `knowledge-routes.ts`, `build-requests-routes.ts` | Modify — type-only change: these pass `getGroq()`'s return value through to `briefing.ts`/`departments.ts`, which already call through `groq-client.ts`'s shared helpers; no logic change |
| `.env.example` | Modify — document `OMNIROUTE_API_KEY`/`OMNIROUTE_BASE_URL`; note `GEMINI_API_KEY` is still required for voice-native mode specifically |

Every other file that currently imports `groq-client.ts`/`groq-agent-client.ts` (`daily-adaptation.ts`, `reflection.ts`, `knowledge-graph.ts`, `coding-agent.ts`, `identity.ts`, `reward-routes.ts`, `departments.ts`) calls through the shared `generateWithFallback`/`toGroqSchema` funnel and needs no changes beyond what a type signature update requires (`Groq` → the new client's type, wherever one of these files' own signatures names it explicitly).

## Data Flow

Cognition code builds a request `params` object (messages, optionally `tools`/`response_format`) and calls `omniroute-client.ts`'s `generateWithFallback(params, models)` → for each model in `models`, in order, `fetchWithRetry` POSTs `{...params, model}` to `${OMNIROUTE_BASE_URL}/chat/completions` with the `OMNIROUTE_API_KEY` credential → on success, returns the parsed OpenAI-shaped response (`.choices[0].message`, `.choices[0].message.tool_calls`, etc. — the same shape the existing Groq branch already consumes) → on failure, logs a warning (matching `generateWithFallback`'s existing telemetry pattern) and tries the next model → if every model in the list fails, throws the last error.

The **caller** (not the client) decides what happens next on a thrown error — this preserves each call site's existing, already-correct fallback wiring exactly as it is today:
- `/api/voice-input`: outer handler catch → 500 response (unchanged; no `LocalCognitiveEngine` involvement here today, none added).
- `/api/chat`'s Gemini/text-generation step: branch-level catch logs and lets the `executionChain` loop continue to its next step, eventually reaching the existing `"Simulated"` step (`LocalCognitiveEngine.generateResponse`) if every other step also fails (unchanged multi-layer structure).
- `/v1/chat/completions`: direct catch → `LocalCognitiveEngine.generateResponse(userMsg, session.workspace, stats.system)` (unchanged — this is the one call site with a tight catch-to-local binding today, and it stays exactly that shape, just wrapping a call to the new client instead of `generateContentWithFallback`).

`omniroute-client.ts` itself has **no `LocalCognitiveEngine` awareness or fallback logic** — that class needs `CognitiveWorkspace`/`systemMetrics` context only available at each real call site, not something a generic transport client can construct. The client's only job is: try the model list, return on success, throw on total failure — exactly what `generateContentWithFallback` and `groq-client.ts`'s `generateWithFallback` already do today.

## Error Handling

- **Startup**: if `OMNIROUTE_API_KEY` is unset, log a warning matching today's `GEMINI_API_KEY`/`GROQ_API_KEY`-missing warning style, and run in local-only mode for all migrated call sites (voice-native mode is unaffected, still gated on `GEMINI_API_KEY` alone).
- **Per-call**: `fetchWithRetry` already handles transient failures (timeouts, 5xx, rate limits) with its existing retry/backoff logic — no new retry logic needed in `omniroute-client.ts` itself, matching how `groq-client.ts`'s `generateWithFallback` already relies on nothing beyond the per-model try/catch loop.
- **Total failure** (every model in a call's list fails): the thrown error propagates to the caller, which handles it exactly as it does today (see Data Flow) — no new fallback logic introduced.

## Testing

- Existing tests that mock `getAi()`/`getGroq()` are updated to mock the new `getOmniRoute()`.
- New unit tests for `omniroute-client.ts`'s `generateWithFallback` (try-next-model-on-failure, throw-on-total-failure) and its tool-schema conversion, mirroring the existing test coverage style for `groq-client.ts`'s `generateWithFallback`/`toGroqSchema`.
- `server.ts`'s three migrated call sites keep whatever test coverage they already have, updated to mock the new client instead of `GoogleGenAI`.
- No live OmniRoute or live Gemini/Groq credentials required for any automated test — all HTTP calls are mocked, matching this codebase's existing testing conventions established throughout this project.

## Out of Scope

- Voice-native mode / Gemini Live API (`live-voice.ts`) — see the dedicated section above.
- Changing which specific models are requested (the exact model names/fallback lists stay as they are today; expanding the model list is a future, separate decision made one model at a time, informed by real testing — not part of this migration).
- OmniRoute's own configuration (provider credentials, dashboard setup) — that's the user's responsibility via OmniRoute's own UI, not something Jarvis's code manages.
- Routing Claude Code's own traffic through OmniRoute — explicitly out of scope per the earlier research finding that Anthropic doesn't support this pattern; not part of this project.
