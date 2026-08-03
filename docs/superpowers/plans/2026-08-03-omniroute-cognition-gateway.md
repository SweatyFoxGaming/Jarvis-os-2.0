# Route Jarvis's Cognition Module Through OmniRoute Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Groq's SDK and Gemini's three chat-completions call sites with a single OpenAI-compatible client pointed at a self-hosted OmniRoute gateway, while leaving Gemini's Live API (voice-native) and embeddings usage completely untouched.

**Architecture:** A new `src/runtime/omniroute-client.ts` module exposes `generateWithFallback(config, params, models)` — a drop-in transport replacement for both `groq-client.ts`'s existing function of the same name and `server.ts`'s Gemini-specific `generateContentWithFallback`. `getOmniRoute()` (new, in `clients.ts`) returns a plain `{apiKey, baseUrl}` config object, not an SDK instance — every function that currently threads a `Groq | null` parameter through (`generateBriefing`, `reviewCodeDiff`, `reviewTaskDiff`, `generateProactiveThought`, `callGroqAgentChat`, etc.) keeps the exact same parameter-passing shape, just retyped, so `tsc` catches every site that needs updating.

**Tech Stack:** TypeScript/Express, existing `fetchWithRetry` (`src/kernel/http-retry.ts`), no new npm dependencies.

## Global Constraints

- Full design context: `docs/superpowers/specs/2026-08-03-omniroute-cognition-gateway-design.md` — read this first if any task below is ambiguous.
- Voice-native mode (`src/interaction/live-voice.ts`, Gemini Live API) is **not touched by any task in this plan**.
- Embeddings (`src/cognition/memory-store.ts`, Gemini's `embedContent`) are **not touched by any task in this plan**.
- `getAi()` (the Gemini `GoogleGenAI` client) is **not removed** — it stays constructed in `server.ts` exactly as today, still passed to `executeTool`, `live-voice.ts`, and `memory-store.ts`.
- Every call site's existing model name/fallback list stays exactly as it is today (`["gemini-3.5-flash", "gemini-3.1-flash-lite", "gemini-flash-latest"]` for chat/transcription, `["llama-3.3-70b-versatile", "llama-3.1-8b-instant"]` / `DEFAULT_MODELS` for the coding agent) — this plan changes transport, never which models are requested.
- `npx tsc --noEmit` and `npm test` must both pass after every task, before that task's commit — **except** Tasks 2-6, which together form one atomic interface-then-callers migration unit (the `clients.ts` signature change in Task 2 necessarily breaks every caller until Task 6 finishes retyping the last of them). `tsc` is allowed to show errors confined to already-identified pending callers between Tasks 2 and 5; Task 6's own completion gate (its Step 4) is where the whole codebase must be clean again, and every task from 7 onward follows the normal per-task clean-tsc rule.
- No live OmniRoute instance, live Gemini, or live Groq credentials required by any automated test — all HTTP calls are mocked.

---

## File Structure

| File | Change |
|---|---|
| `src/runtime/omniroute-client.ts` | Create — `OmniRouteConfig` type, `generateWithFallback`, tool-schema conversion (reuses `toGroqSchema`/`toGroqTools`) |
| `src/runtime/clients.ts` | Modify — add `getOmniRoute()`/`setSharedClient()`; remove the Groq half of `getGroq()`/`setSharedClients()` |
| `src/runtime/groq-client.ts` | Modify — `generateWithFallback`'s client parameter retypes from `Groq` to `OmniRouteConfig`, calls the new HTTP layer internally |
| `src/runtime/groq-agent-client.ts` | Modify — `callGroqAgentChat`'s `groq: Groq` parameter retypes to `OmniRouteConfig` |
| `src/world/briefing.ts` | Modify — `generateBriefing`'s `groq: Groq \| null` parameter retypes |
| `src/executive/departments.ts` | Modify — `reviewCodeDiff`/`reviewTaskDiff`'s `groq: Groq \| null` parameters retype |
| `src/self/identity.ts` | Modify — `generateProactiveThought`'s Groq parameter retypes |
| `src/executive/coding-agent.ts`, `src/adaptation/reflection.ts`, `src/adaptation/daily-adaptation.ts`, `src/cognition/knowledge-graph.ts` | Modify — same parameter retype wherever they pass a Groq client through |
| `src/interaction/routes/briefing-memory-routes.ts`, `knowledge-routes.ts`, `build-requests-routes.ts` | Modify — `getGroq()` → `getOmniRoute()` |
| `src/server.ts` | Modify — client construction, three call-site migrations (voice-input transcription, chat, `/v1/chat/completions`) |
| `.env.example` | Modify — document `OMNIROUTE_API_KEY`/`OMNIROUTE_BASE_URL` |

---

## Task 1: `omniroute-client.ts` core module

**Files:**
- Create: `src/runtime/omniroute-client.ts`
- Test: `tests/index.test.ts`

**Interfaces:**
- Produces: `OmniRouteConfig` (`{apiKey: string; baseUrl: string}`), `generateWithFallback(config: OmniRouteConfig, params: any, models: string[]): Promise<any>`

- [ ] **Step 1: Write the failing tests**

Add to `tests/index.test.ts`:

```typescript
import { generateWithFallback as omniRouteGenerateWithFallback } from "../src/runtime/omniroute-client.js";

registerTest("OmniRouteClient", "generateWithFallback returns the first model's successful response", async () => {
  const originalFetch = global.fetch;
  global.fetch = (async (url: string, init: any) => {
    const body = JSON.parse(init.body);
    if (body.model !== "model-a") throw new Error("expected the first model to be tried first");
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
  }) as any;
  try {
    const result = await omniRouteGenerateWithFallback({ apiKey: "test-key", baseUrl: "http://127.0.0.1:20128/v1" }, { messages: [] }, ["model-a", "model-b"]);
    if (result.choices[0].message.content !== "ok") {
      throw new Error(`OmniRouteClient: expected "ok", got: ${JSON.stringify(result)}`);
    }
  } finally {
    global.fetch = originalFetch;
  }
});

registerTest("OmniRouteClient", "generateWithFallback tries the next model when the first fails", async () => {
  const originalFetch = global.fetch;
  let attempts: string[] = [];
  global.fetch = (async (url: string, init: any) => {
    const body = JSON.parse(init.body);
    attempts.push(body.model);
    if (body.model === "model-a") return new Response("server error", { status: 500 });
    return new Response(JSON.stringify({ choices: [{ message: { content: "from model-b" } }] }), { status: 200 });
  }) as any;
  try {
    const result = await omniRouteGenerateWithFallback({ apiKey: "test-key", baseUrl: "http://127.0.0.1:20128/v1" }, { messages: [] }, ["model-a", "model-b"]);
    if (result.choices[0].message.content !== "from model-b" || attempts.join(",") !== "model-a,model-a,model-a,model-a,model-b") {
      // fetchWithRetry retries 500s up to 3 times by default before this function's own
      // per-model loop moves to the next model — model-a is attempted 4 times total
      // (1 initial + 3 retries) before falling through to model-b.
      throw new Error(`OmniRouteClient: expected fallback to model-b after model-a's retries, got content="${result.choices?.[0]?.message?.content}", attempts=${attempts.join(",")}`);
    }
  } finally {
    global.fetch = originalFetch;
  }
});

registerTest("OmniRouteClient", "generateWithFallback throws when every model fails", async () => {
  const originalFetch = global.fetch;
  global.fetch = (async () => new Response("error", { status: 500 })) as any;
  try {
    await omniRouteGenerateWithFallback({ apiKey: "test-key", baseUrl: "http://127.0.0.1:20128/v1" }, { messages: [] }, ["model-a"]);
    throw new Error("OmniRouteClient: expected generateWithFallback to throw when every model fails");
  } catch (err: any) {
    if (err.message === "OmniRouteClient: expected generateWithFallback to throw when every model fails") throw err;
    // any other thrown error is the expected outcome
  } finally {
    global.fetch = originalFetch;
  }
});

registerTest("OmniRouteClient", "generateWithFallback sends the API key as a Bearer token", async () => {
  const originalFetch = global.fetch;
  let seenAuth: string | null = null;
  global.fetch = (async (url: string, init: any) => {
    seenAuth = init.headers?.Authorization ?? null;
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
  }) as any;
  try {
    await omniRouteGenerateWithFallback({ apiKey: "my-secret-key", baseUrl: "http://127.0.0.1:20128/v1" }, { messages: [] }, ["model-a"]);
    if (seenAuth !== "Bearer my-secret-key") {
      throw new Error(`OmniRouteClient: expected "Bearer my-secret-key", got: ${seenAuth}`);
    }
  } finally {
    global.fetch = originalFetch;
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test 2>&1 | grep OmniRouteClient`
Expected: FAIL — module doesn't exist yet

- [ ] **Step 3: Implement**

Create `src/runtime/omniroute-client.ts`:

```typescript
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
```

- [ ] **Step 4: Run tests, verify pass, typecheck, commit**

Run: `npx tsc --noEmit && npm test`
Expected: no errors, all tests pass

```bash
git add src/runtime/omniroute-client.ts tests/index.test.ts
git commit -m "feat: add the OmniRoute transport client"
```

---

## Task 2: `clients.ts` — add `getOmniRoute()`, remove Groq's client slot

**Files:**
- Modify: `src/runtime/clients.ts`

**Interfaces:**
- Consumes: `OmniRouteConfig` (Task 1)
- Produces: `getOmniRoute(): OmniRouteConfig | null`, `setSharedClient(ai: GoogleGenAI | null, omniRoute: OmniRouteConfig | null): void`

- [ ] **Step 1: Rewrite `clients.ts`**

Replace the full file content:

```typescript
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
```

- [ ] **Step 2: Typecheck (this will show every call site that still needs updating — do not fix them here, later tasks handle each one)**

Run: `npx tsc --noEmit 2>&1 | head -40`
Expected: errors in `server.ts` (still calls `setSharedClients`/constructs `Groq`) and every file that calls `getGroq()` — this is expected; Task 5 fixes `server.ts`'s construction, Task 6 fixes the downstream signature callers, Task 10 fixes the three route files. Do not attempt to fix these now.

- [ ] **Step 3: Commit**

```bash
git add src/runtime/clients.ts
git commit -m "feat: add getOmniRoute(), remove Groq's client slot from clients.ts"
```

Per this plan's Global Constraints, `tsc` is not required to be clean after this specific task — Tasks 2-6 form one atomic migration unit, and the clean-tsc gate applies at Task 6's completion.

---

## Task 3: `groq-client.ts` — retype and swap transport

**Files:**
- Modify: `src/runtime/groq-client.ts`

**Interfaces:**
- Consumes: `OmniRouteConfig`, `generateWithFallback` from `omniroute-client.ts` (Task 1)
- Produces: `generateWithFallback(config: OmniRouteConfig, params: any, models: string[]): Promise<any>` (same name, same file, now delegating to the new transport — callers elsewhere in the codebase that import `generateWithFallback` from `groq-client.js` keep working unchanged, since this file re-exports the same function name with the same shape)

- [ ] **Step 1: Update the import and `generateWithFallback`**

In `src/runtime/groq-client.ts`, replace:

```typescript
import Groq from "groq-sdk";
import { ObservationPlatform } from "../kernel/observation.js";

const observation = ObservationPlatform.getInstance();
```

with:

```typescript
import type { OmniRouteConfig } from "./omniroute-client.js";
import { generateWithFallback as omniRouteGenerateWithFallback } from "./omniroute-client.js";
```

(The `observation`/`ObservationPlatform` import is no longer needed in this file once `generateWithFallback`'s own telemetry logging is removed below — `omniroute-client.ts`'s `generateWithFallback` already logs the same events.)

Replace the existing `generateWithFallback` function:

```typescript
export async function generateWithFallback(groq: Groq, params: any, models: string[]): Promise<Groq.Chat.Completions.ChatCompletion> {
  let lastError: any = null;
  for (const model of models) {
    try {
      observation.logTelemetry("info", "Cognition", `Attempting Groq content generation with model: ${model}`);
      const response = await groq.chat.completions.create({ ...params, model });
      observation.logTelemetry("info", "Cognition", `Successfully generated content with Groq model: ${model}`);
      return response as Groq.Chat.Completions.ChatCompletion;
    } catch (error: any) {
      lastError = error;
      observation.logTelemetry("warn", "Cognition", `Groq model ${model} failed: ${error.message || error}`);
    }
  }
  throw lastError || new Error("All fallback models failed content generation");
}
```

with:

```typescript
export async function generateWithFallback(config: OmniRouteConfig, params: any, models: string[]): Promise<any> {
  return omniRouteGenerateWithFallback(config, params, models);
}
```

Leave `toGroqSchema` and `toGroqTools` completely unchanged — both are pure data transformation with no SDK dependency.

- [ ] **Step 2: Typecheck (still expected to show errors in downstream callers — Task 4 and Task 6 fix those)**

Run: `npx tsc --noEmit 2>&1 | grep groq-client`
Expected: no errors originating from `groq-client.ts` itself (its own file should be internally consistent); errors in files that call it with a `Groq` argument are expected until Task 6.

- [ ] **Step 3: Commit**

```bash
git add src/runtime/groq-client.ts
git commit -m "feat: swap groq-client.ts's transport to OmniRoute"
```

---

## Task 4: `groq-agent-client.ts` — retype `callGroqAgentChat`

**Files:**
- Modify: `src/runtime/groq-agent-client.ts`

**Interfaces:**
- Consumes: `OmniRouteConfig` (Task 1), `generateWithFallback` from `groq-client.ts` (Task 3)
- Produces: `callGroqAgentChat(config: OmniRouteConfig, messages: AgentMessage[], tools: AgentTool[], modelOrder?: string[]): Promise<AgentChatResult>`

- [ ] **Step 1: Update the import and `callGroqAgentChat`'s signature**

In `src/runtime/groq-agent-client.ts`, replace:

```typescript
import Groq from "groq-sdk";
import { toGroqSchema, generateWithFallback } from "./groq-client.js";
```

with:

```typescript
import type { OmniRouteConfig } from "./omniroute-client.js";
import { toGroqSchema, generateWithFallback } from "./groq-client.js";
```

Replace the `callGroqAgentChat` signature and its `generateWithFallback` call:

```typescript
export async function callGroqAgentChat(
  groq: Groq,
  messages: AgentMessage[],
  tools: AgentTool[],
  modelOrder?: string[]
): Promise<AgentChatResult> {
```

becomes:

```typescript
export async function callGroqAgentChat(
  config: OmniRouteConfig,
  messages: AgentMessage[],
  tools: AgentTool[],
  modelOrder?: string[]
): Promise<AgentChatResult> {
```

And its body's call site:

```typescript
  const response = await generateWithFallback(
    groq,
    { messages: messages as any, tools: groqTools as any, tool_choice: "auto" },
    models
  );
```

becomes:

```typescript
  const response = await generateWithFallback(
    config,
    { messages: messages as any, tools: groqTools as any, tool_choice: "auto" },
    models
  );
```

Every other line in this file (`DEFAULT_MODELS`, `JARVIS_CODING_AGENT_MODEL` override logic, `toGroqSchema`/`toGroqTools` usage, `parseGroqAgentResponse`, all the interfaces) stays exactly as-is — this is a type-and-parameter-name change only.

- [ ] **Step 2: Find and fix `callGroqAgentChat`'s own callers**

Run: `grep -rn "callGroqAgentChat(" src/ --include="*.ts"` — this will show `coding-agent.ts`'s call site(s). Read the surrounding code in `src/executive/coding-agent.ts` to find where it currently passes a `Groq` instance (likely via `getGroq()`) and change that to `getOmniRoute()`, matching the new parameter type. This is a mechanical change — the function's own internal logic doesn't need to change, only what it imports/calls to obtain the client config (`getGroq()` → `getOmniRoute()` from `../runtime/clients.js`).

- [ ] **Step 3: Typecheck, commit**

Run: `npx tsc --noEmit 2>&1 | grep -E "groq-agent-client|coding-agent"`
Expected: no errors from these two files specifically (other files still pending Task 6).

```bash
git add src/runtime/groq-agent-client.ts src/executive/coding-agent.ts
git commit -m "feat: retype callGroqAgentChat to use OmniRouteConfig"
```

---

## Task 5: `server.ts` — client construction and `.env.example`

**Files:**
- Modify: `src/server.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes: `OmniRouteConfig`, `setSharedClient` (Tasks 1-2)

- [ ] **Step 1: Replace the Groq client construction with OmniRoute construction**

In `src/server.ts`, find the existing construction block (originally around lines 180–186):

```typescript
let groq: Groq | null = null;
if (process.env.GROQ_API_KEY) {
  groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  observation.logTelemetry("info", "Cognition", "Groq client successfully configured with API Key.");
} else {
  observation.logTelemetry("warn", "Cognition", "No GROQ_API_KEY detected. Groq features unavailable.");
}
```

Replace it with:

```typescript
let omniRoute: OmniRouteConfig | null = null;
if (process.env.OMNIROUTE_API_KEY) {
  omniRoute = {
    apiKey: process.env.OMNIROUTE_API_KEY,
    baseUrl: process.env.OMNIROUTE_BASE_URL || "http://127.0.0.1:20128/v1",
  };
  observation.logTelemetry("info", "Cognition", "OmniRoute gateway successfully configured with API Key.");
} else {
  observation.logTelemetry("warn", "Cognition", "No OMNIROUTE_API_KEY detected. OmniRoute-backed features (chat, coding agent) unavailable.");
}
```

Update the `import Groq from "groq-sdk";` line (find it near the top of `server.ts`, alongside the `GoogleGenAI` import) — remove it, and add:

```typescript
import type { OmniRouteConfig } from "./runtime/omniroute-client.js";
```

Find the `setSharedClients(ai, groq);` call and change it to:

```typescript
setSharedClient(ai, omniRoute);
```

Update the corresponding import of `setSharedClients` from `./runtime/clients.js` to `setSharedClient`.

- [ ] **Step 2: Remove `generateContentWithFallback` — its role is now filled by `omniroute-client.ts`'s `generateWithFallback` for the migrated call sites**

Do NOT remove it yet if any call site in this file still references it — later tasks (7-9) migrate each of its 4 call sites one at a time. Leave the function in place until Task 9's final step confirms nothing calls it anymore, then delete it as part of that task's cleanup (noted there explicitly).

- [ ] **Step 3: Document the new env vars**

In `.env.example`, find where `GEMINI_API_KEY`/`GROQ_API_KEY` are documented and add nearby:

```
# OmniRoute gateway (self-hosted, OpenAI-compatible) — powers chat and the
# coding agent. GEMINI_API_KEY is still required separately for voice-native
# mode and semantic memory embeddings, which this does not replace.
OMNIROUTE_API_KEY=
OMNIROUTE_BASE_URL=http://127.0.0.1:20128/v1
```

Leave the `GROQ_API_KEY` line in place but add a one-line comment above it noting it's no longer read by this codebase as of this change (do not delete the line outright — an operator with it already set shouldn't need to notice its removal to understand why nothing broke): `# No longer used — Groq's own usage now goes through OMNIROUTE_API_KEY above.`

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit 2>&1 | head -40`
Expected: remaining errors should now be confined to the downstream Groq-parameter callers (briefing.ts, departments.ts, identity.ts, etc. — Task 6) and the three still-unmigrated Gemini call sites inside `server.ts` itself (Tasks 7-9), not from the construction/import block changed in this task.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts .env.example
git commit -m "feat: construct the OmniRoute client in server.ts, document new env vars"
```

---

## Task 6: Retype every downstream `Groq | null` parameter

**Files:**
- Modify: `src/world/briefing.ts`
- Modify: `src/executive/departments.ts`
- Modify: `src/self/identity.ts`
- Modify: `src/adaptation/reflection.ts`
- Modify: `src/adaptation/daily-adaptation.ts`
- Modify: `src/cognition/knowledge-graph.ts` (if it takes a Groq parameter — confirm via the grep in Step 1)

**Interfaces:**
- Consumes: `OmniRouteConfig` (Task 1)

- [ ] **Step 1: Find every remaining reference**

Run: `npx tsc --noEmit 2>&1 | grep -oE "src/[a-zA-Z0-9_/.-]+\.ts" | sort -u` — this lists every file TypeScript is currently complaining about. Cross-reference against `grep -rln "Groq" src/ --include="*.ts" | grep -v test` to confirm you've found every file with a lingering `Groq` type reference (import, parameter type, or return type).

- [ ] **Step 2: For each file found, apply the same mechanical change**

For `src/world/briefing.ts`, change:

```typescript
export async function generateBriefing(groq: Groq | null, username: string): Promise<{ text: string; itemCount: number; items: PrioritizedItem[] }> {
```

to:

```typescript
export async function generateBriefing(omniRoute: OmniRouteConfig | null, username: string): Promise<{ text: string; itemCount: number; items: PrioritizedItem[] }> {
```

and rename every use of the `groq` parameter inside the function body to `omniRoute` (it's passed straight through to `synthesizeBriefing`/`generateWithFallback` — check the function body to confirm there's no logic that inspects the value beyond a null-check, only threading). Update the `import Groq from "groq-sdk"` (or `import type Groq from "groq-sdk"`) line at the top of the file to `import type { OmniRouteConfig } from "../runtime/omniroute-client.js";` (adjust the relative path to match this file's actual location).

For `src/executive/departments.ts`, apply the identical pattern to both `reviewCodeDiff(objective, files, groq: Groq | null)` and `reviewTaskDiff(taskTitle, taskDescription, files, groq: Groq | null)` — rename the parameter to `omniRoute`, retype to `OmniRouteConfig | null`, update the import.

For `src/self/identity.ts`, `src/adaptation/reflection.ts`, `src/adaptation/daily-adaptation.ts`, and `src/cognition/knowledge-graph.ts` (whichever of these actually has a `Groq`-typed parameter per Step 1's grep — do not blindly edit a file that doesn't need it), apply the same pattern: rename the parameter, retype it, update the import, update every call site within that same file that passes the parameter onward.

- [ ] **Step 3: Find and fix every CALLER of these now-retyped functions**

Run: `grep -rn "generateBriefing(\|reviewCodeDiff(\|reviewTaskDiff(\|generateProactiveThought(" src/ --include="*.ts" | grep -v test` — for each call site currently passing `getGroq()`, change it to `getOmniRoute()` (update the corresponding import from `../runtime/clients.js` at the top of that file too, if `getGroq` was imported by name there).

- [ ] **Step 4: Typecheck — this task's real completion gate**

Run: `npx tsc --noEmit`
Expected: no errors remaining anywhere EXCEPT inside `server.ts`'s three still-unmigrated Gemini call sites (Tasks 7-9 handle those specifically) — if `tsc` shows an error in any file other than `server.ts`, find and fix it as part of this task before moving on.

- [ ] **Step 5: Run tests, commit**

Run: `npm test`
Expected: all tests pass (test files that mock `getGroq()` need updating to mock `getOmniRoute()` instead — find them via `grep -rln "getGroq" tests/` and fix each one as part of this task).

```bash
git add src/world/briefing.ts src/executive/departments.ts src/self/identity.ts src/adaptation/reflection.ts src/adaptation/daily-adaptation.ts tests/
git commit -m "refactor: retype every downstream Groq parameter to OmniRouteConfig"
```

(Adjust the `git add` file list to match exactly which files Step 1's grep actually found — do not add files you didn't need to touch.)

---

## Task 7: `server.ts` — migrate `/api/voice-input`

**Files:**
- Modify: `src/server.ts`

**Interfaces:**
- Consumes: `generateWithFallback` from `omniroute-client.ts` (Task 1), `getOmniRoute` (Task 2)

- [ ] **Step 1: Replace the call site**

Find the `/api/voice-input` handler's Gemini call (originally around lines 349–366):

```typescript
if (ai && !kernel.offlineMode && !forceOffline) {
  try {
    const response = await generateContentWithFallback(ai, {
      contents: [
        "Please transcribe this voice recording accurately into plain English text. If there is no audible speech, return an empty string. Do not add any conversational remarks, commentary, or punctuation padding, just the literal transcribed words.",
        {
          inlineData: {
            data: audio,
            mimeType: mimeType || "audio/webm"
          }
        }
      ]
    });
    const transcription = response.text ? response.text.trim() : "";
```

This specific call sends inline audio data as part of `contents` — Gemini's multimodal `generateContent` accepts raw audio bytes directly. OpenAI's `/chat/completions` format does **not** have a universal equivalent for arbitrary inline audio across all providers (some support `input_audio` in specific formats, most don't) — check OmniRoute's actual `/v1/models` output (or its docs under `docs/guides/` in the cloned source at `/home/ubuntu/.claude/jobs/d5da6251/tmp/omniroute-inspect/OmniRoute`) for whether any of the models in the existing fallback list support audio input via its OpenAI-compatible endpoint before assuming this migrates cleanly. If no model in the current fallback list reliably supports inline audio through OmniRoute's translation layer, leave this ONE specific call site on direct Gemini SDK usage (keep calling `ai.models.generateContent` here, unchanged) and note this as a documented exception in your implementation report — do not force a migration that would silently break voice-input transcription. Verify this empirically against the actually-running local OmniRoute instance if possible (a real audio sample through the actual endpoint) rather than guessing from docs alone.

If audio input IS supported by at least one fallback-list model through OmniRoute, migrate it following the same request/response shape used in Task 9 below (this is structurally the simplest of the three real migrations — no tools, no multi-turn loop, just a single completion call).

- [ ] **Step 2: Typecheck, run tests**

Run: `npx tsc --noEmit && npm test`
Expected: no errors, all tests pass

- [ ] **Step 3: Commit**

```bash
git add src/server.ts
git commit -m "feat: migrate or document /api/voice-input's transcription call site"
```

---

## Task 8: `server.ts` — migrate the `/api/chat` Gemini branch

**Files:**
- Modify: `src/server.ts`

**Interfaces:**
- Consumes: `generateWithFallback` from `omniroute-client.ts` (Task 1), `getOmniRoute` (Task 2), `toGroqTools` from `groq-client.ts` (unchanged, reused directly — no new tool-conversion function needed)

This is the largest single call-site migration. Mirror the existing, already-working Groq branch in the same file (the `else if (step === "Groq")` block, immediately preceding the Gemini branch) exactly — it already solves this exact problem (OpenAI-shaped multi-turn tool-calling) for the same `getAllToolDeclarations()` output.

- [ ] **Step 1: Replace the Gemini branch's request-building and tool loop**

Find the `else if (step === "Gemini")` branch. Replace its body (the two `generateContentWithFallback` calls, the `contents`/`Content[]` construction, the `functionResponse`-parts echo pattern, and the `response.functionCalls`/`response.text` consumption) with the same shape the adjacent Groq branch already uses:

```typescript
      else if (step === "Gemini") {
        if (omniRoute) {
          try {
            observation.incrementMetric("geminiApiCalls");
            session.updateState({
              currentThought: "Querying OmniRoute (Gemini fallback tier)",
            });

            const geminiTools = toGroqTools(getAllToolDeclarations());
            const messages: any[] = [
              { role: "system", content: systemInstruction },
              { role: "user", content: message },
            ];
            // Vision (a live camera frame) has no bearing on this migrated
            // text-only path — the image-attachment branch that existed
            // in the old Gemini-native call is intentionally not carried
            // over here; if OmniRoute's OpenAI-compatible endpoint is
            // later confirmed to support image_url content parts for one
            // of these models, that's a follow-up, not part of this task.
            const chatModels = ["gemini-3.5-flash", "gemini-3.1-flash-lite", "gemini-flash-latest"];

            let response = await generateWithFallback(omniRoute, { messages, tools: geminiTools }, chatModels);
            let toolCalls = response.choices[0]?.message?.tool_calls || [];
            let guard = 0;

            while (toolCalls.length > 0 && guard < 3) {
              guard++;
              const assistantMessage = response.choices[0].message;
              messages.push({
                role: "assistant",
                content: assistantMessage.content,
                tool_calls: assistantMessage.tool_calls,
              });

              const toolResponseMessages: any[] = [];
              for (const call of toolCalls) {
                let args: Record<string, any> = {};
                try {
                  args = JSON.parse(call.function.arguments || "{}");
                } catch {
                  // Malformed arguments from the model — executeTool below
                  // fails cleanly on whatever this leaves args as.
                }

                const result = await executeTool(
                  call.function.name || "",
                  args,
                  req.username,
                  ai,
                  kernel.localLlmEndpoint,
                  { alreadyAttached: false, supportsRoundTrip: true }
                );

                if (result.needsClientAction === "capture_screen") {
                  res.write("data: request_screen\n\n");
                  res.write("data: [DONE]\n\n");
                  res.end();
                  success = true;
                  succeededStep = "Gemini";
                  return;
                }

                if (result.displayDirective) {
                  res.write(`data: display: ${JSON.stringify(result.displayDirective)}\n\n`);
                }
                if (result.audioDirective) {
                  res.write(`data: audio: ${JSON.stringify(result.audioDirective)}\n\n`);
                }

                toolCallsExecuted.push({ name: result.name, ok: result.ok });
                toolResponseMessages.push({
                  role: "tool",
                  tool_call_id: call.id,
                  content: JSON.stringify(result.ok ? { output: result.output } : { error: result.error }),
                });
              }
              messages.push(...toolResponseMessages);

              response = await generateWithFallback(omniRoute, { messages, tools: geminiTools }, chatModels);
              toolCalls = response.choices[0]?.message?.tool_calls || [];
            }

            const finalText = response.choices[0]?.message?.content || "";
            if (finalText) {
              for (const word of finalText.split(" ")) {
                fullReply += word + " ";
                res.write(`data: ${word} \n\n`);
              }
              success = true;
              succeededStep = "Gemini";
            }
          } catch (err: any) {
            observation.logTelemetry("warn", "Cognition", `OmniRoute (Gemini tier) generation failed: ${err.message || err}`);
          }
        }
      }
```

Note: `if (omniRoute)` replaces `if (ai)` as this branch's guard — `ai` (Gemini) is no longer what gates this specific step, `omniRoute` is. `ai` is still passed to `executeTool` unchanged (it needs it for embedding/voice-adjacent tool paths per this plan's Global Constraints).

- [ ] **Step 2: Typecheck, run tests**

Run: `npx tsc --noEmit && npm test`
Expected: no errors, all tests pass

- [ ] **Step 3: Manual verification against the real running OmniRoute instance**

Since this is the highest-risk migrated call site (multi-turn tool-calling, the exact thing this plan's Global Constraints are protecting), manually verify it works against the actual local OmniRoute instance before committing: start the dev server with `OMNIROUTE_API_KEY` pointed at the real running gateway (configured with at least one real provider behind it), send a chat message that requires a tool call (e.g. "what's the weather" if a relevant tool exists, or any message that triggers `looksToolShaped`), and confirm a real tool executes and a real final reply streams back — not just that `tsc`/`npm test` pass.

- [ ] **Step 4: Commit**

```bash
git add src/server.ts
git commit -m "feat: migrate the /api/chat Gemini tier to OmniRoute, mirroring the existing Groq branch"
```

---

## Task 9: `server.ts` — migrate `/v1/chat/completions`, remove the old wrapper

**Files:**
- Modify: `src/server.ts`

**Interfaces:**
- Consumes: `generateWithFallback` from `omniroute-client.ts` (Task 1), `getOmniRoute` (Task 2)

- [ ] **Step 1: Replace the call site**

Find the `/v1/chat/completions` handler's Gemini call (originally around lines 1068–1082):

```typescript
if (ai && !kernel.offlineMode) {
  try {
    observation.incrementMetric("geminiApiCalls");
    const response = await generateContentWithFallback(ai, {
      contents: userMsg,
      config: {
        systemInstruction: "You are JARVIS, a highly sophisticated, fluent, warm, and brilliant AI companion with a charismatic, witty, and deeply human-like conversational style. Speak naturally, with refined British poise, warmth, and intellectual depth. Avoid robotic phrasing, dry bullet points, or repetitive templates unless requested. Engage as a true intellectual partner, responding with direct, fluent, and elegant sentences.",
      }
    });
    reply = response.text || "";
  } catch (err: any) {
    observation.logTelemetry("warn", "Cognition", `Online completion failed: ${err.message}. Reverting to local engine.`);
    const stats = observation.getMetrics();
    reply = localEngine.generateResponse(userMsg, session.workspace, stats.system);
  }
} else {
  const stats = observation.getMetrics();
  reply = localEngine.generateResponse(userMsg, session.workspace, stats.system);
}
```

Replace with:

```typescript
if (omniRoute && !kernel.offlineMode) {
  try {
    observation.incrementMetric("geminiApiCalls");
    const chatModels = ["gemini-3.5-flash", "gemini-3.1-flash-lite", "gemini-flash-latest"];
    const response = await generateWithFallback(omniRoute, {
      messages: [
        {
          role: "system",
          content: "You are JARVIS, a highly sophisticated, fluent, warm, and brilliant AI companion with a charismatic, witty, and deeply human-like conversational style. Speak naturally, with refined British poise, warmth, and intellectual depth. Avoid robotic phrasing, dry bullet points, or repetitive templates unless requested. Engage as a true intellectual partner, responding with direct, fluent, and elegant sentences.",
        },
        { role: "user", content: userMsg },
      ],
    }, chatModels);
    reply = response.choices?.[0]?.message?.content || "";
  } catch (err: any) {
    observation.logTelemetry("warn", "Cognition", `Online completion failed: ${err.message}. Reverting to local engine.`);
    const stats = observation.getMetrics();
    reply = localEngine.generateResponse(userMsg, session.workspace, stats.system);
  }
} else {
  const stats = observation.getMetrics();
  reply = localEngine.generateResponse(userMsg, session.workspace, stats.system);
}
```

The `LocalCognitiveEngine` fallback wiring at this call site is untouched — it's already exactly where it needs to be (per this plan's design), only the thing being tried before falling back to it has changed transport.

- [ ] **Step 2: Remove the now-unused `generateContentWithFallback` wrapper**

Run: `grep -n "generateContentWithFallback" src/server.ts` — confirm zero remaining call sites (Tasks 7-9 should have migrated or explicitly documented an exception for all of them). If any remain (e.g., Task 7 decided to keep voice-input on direct Gemini), leave the wrapper in place and skip this step — note why in your report. If truly zero call sites remain, delete the `generateContentWithFallback` function definition entirely (originally around lines 193–214).

- [ ] **Step 3: Typecheck, run tests**

Run: `npx tsc --noEmit && npm test`
Expected: no errors, all tests pass

- [ ] **Step 4: Commit**

```bash
git add src/server.ts
git commit -m "feat: migrate /v1/chat/completions to OmniRoute, remove the old Gemini-specific wrapper if unused"
```

---

## Task 10: Migrate the three pass-through route files

**Files:**
- Modify: `src/interaction/routes/briefing-memory-routes.ts`
- Modify: `src/interaction/routes/knowledge-routes.ts`
- Modify: `src/interaction/routes/build-requests-routes.ts`

**Interfaces:**
- Consumes: `getOmniRoute` (Task 2)

- [ ] **Step 1: Replace each `getGroq()` call**

In `src/interaction/routes/briefing-memory-routes.ts`, find:

```typescript
const result = await briefing.generateBriefing(getGroq(), req.username);
```

Change to:

```typescript
const result = await briefing.generateBriefing(getOmniRoute(), req.username);
```

Update the import of `getGroq` from `../../kernel/clients.js` (or wherever it's imported from in this file) to `getOmniRoute`.

In `src/interaction/routes/knowledge-routes.ts`, find:

```typescript
const groq = getGroq();
```

(and its subsequent use, e.g. `identity.generateProactiveThought(req.username, groq)`) — rename the local variable to `omniRoute`, change `getGroq()` to `getOmniRoute()`, update the import.

In `src/interaction/routes/build-requests-routes.ts`, find:

```typescript
const qaSummary = await departments.reviewCodeDiff(buildRequest.objective, files, getGroq());
```

Change to:

```typescript
const qaSummary = await departments.reviewCodeDiff(buildRequest.objective, files, getOmniRoute());
```

Update the import.

- [ ] **Step 2: Typecheck, run tests**

Run: `npx tsc --noEmit && npm test`
Expected: no errors, all tests pass — this should be the point where `npx tsc --noEmit` is clean with zero remaining errors anywhere in the codebase, closing out every deferred error from Tasks 2-9.

- [ ] **Step 3: Commit**

```bash
git add src/interaction/routes/briefing-memory-routes.ts src/interaction/routes/knowledge-routes.ts src/interaction/routes/build-requests-routes.ts
git commit -m "feat: migrate the remaining pass-through routes to getOmniRoute()"
```

---

## Task 11: Final cleanup and verification

**Files:**
- Modify: `package.json` (if `groq-sdk` is confirmed fully unused)

- [ ] **Step 1: Confirm zero remaining `groq-sdk` references**

Run: `grep -rln "groq-sdk\|from \"groq\"\|import Groq" src/ --include="*.ts"`
Expected: no output. If anything remains, it's a missed call site from an earlier task — go fix it, don't skip this check.

- [ ] **Step 2: Remove the `groq-sdk` dependency if genuinely unused**

Run: `grep -rn "groq-sdk" package.json`. If Step 1 confirmed zero source references, remove the `"groq-sdk"` line from `package.json`'s `dependencies` and run `npm install` to update the lockfile. If anything in Step 1 still legitimately needs it (shouldn't, per this plan, but verify rather than assume), leave it and note why in your report.

- [ ] **Step 3: Full verification**

Run: `npx tsc --noEmit && npm test`
Expected: no errors, all tests pass, exact same or higher pass count than before this plan started.

- [ ] **Step 4: Manual smoke test against the real running OmniRoute instance**

Start the dev server with real `OMNIROUTE_API_KEY`/`OMNIROUTE_BASE_URL` pointed at the actual local OmniRoute container (already running), plus `GEMINI_API_KEY` still set (for embeddings/voice, unaffected by this plan). Send a real chat message through `/api/chat` with no tool needed (plain conversation) and one that needs a tool, confirm both work end-to-end through the real gateway. Also hit `/v1/chat/completions` directly with a real request. Confirm `docker ps` shows no unexpected new containers and the live `jarvis-postgres`/`jarvis-os-api` containers (if running) are untouched throughout — this plan's dev-server testing should use a throwaway Postgres or the existing worktree `.env`'s configured database, never the live production containers.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: remove the now-unused groq-sdk dependency"
```

(Skip this commit entirely if Step 2 found `groq-sdk` still needed somewhere — don't commit an empty/no-op change.)
