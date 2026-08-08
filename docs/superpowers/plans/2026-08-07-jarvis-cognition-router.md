# Jarvis Cognition Router Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the external OmniRoute gateway dependency with a Jarvis-owned cognition router — multi-key provider pools (Groq, Gemini), per-user fair-share quota tracking, and a real fallback chain (cloud → local LLM endpoint, no tools → keyword engine) — reusing the generic OpenAI-compatible transport and every already-migrated call site's interface shape from the prior OmniRoute integration rather than redoing that work.

**Architecture:** `src/runtime/key-pool.ts` (per-provider key rotation + cooldown) and `src/kernel/state/usage-repo.ts` (per-user sliding-window usage, Postgres-backed, degrades cleanly) are the two new foundational pieces. `src/runtime/cognition-router.ts` orchestrates them plus the renamed generic transport (`omniroute-client.ts` → `openai-compatible-client.ts`, behavior unchanged) into a single `CognitionRouter.generateWithFallback(username, params, models)` that every downstream call site uses in place of the old `OmniRouteConfig`-based calls — same call shape, one new required `username` argument for fair-share tracking.

**Tech Stack:** TypeScript, Postgres (via this codebase's existing repo/migration pattern), plain `fetch` (via the existing `fetchWithRetry`).

## Global Constraints

- Every call site currently typed `OmniRouteConfig | null` becomes `CognitionRouter | null` — same null-check-then-pass-through shape, so no call site's control flow changes beyond the type and the new `username` argument.
- Model identifiers passed into `generateWithFallback` are provider-prefixed strings (`"groq:<model>"` / `"gemini:<model>"`) — the router splits on the first `:` to select provider, key, and base URL per attempt. This preserves every existing call site's `models: string[]` signature; only the string *values* change to add a prefix.
- The local-LLM fallback tier never sends `tools` in its request body — this codebase already measured, live, that the local model ignores tool declarations and pays 130+ seconds of latency for nothing (see `server.ts`'s existing `LocalLLM` execution-chain step). Strip `tools`/`tool_choice` from `params` before this attempt.
- `usage-repo.ts` degrading when Postgres is unreachable means "report no throttling signal," never "block requests" — matches every other repo in this codebase (`Vault`, `TranscriptEvents`, `CodingPlanTasks`, etc.).
- Retries happen only across different keys/providers, never a blind same-key retry on a POST — the `fetchWithRetry` non-idempotent-retry lesson from earlier work this session still applies within each individual attempt.
- Gemini's voice-native Live API and embeddings stay on the direct `@google/genai` SDK via `getAi()` — untouched by this plan, exactly as the original OmniRoute design established.
- `assertSafeEgressUrl`/`normalizeLocalLlmUrl` (`src/kernel/egress.ts`) must be reused, not reimplemented, for the local-LLM-tier request.

---

## Task 1: `src/runtime/key-pool.ts` — per-provider key rotation and cooldown

**Files:**
- Create: `src/runtime/key-pool.ts`
- Test: `tests/index.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `export type Provider = "groq" | "gemini";`
  - `export class KeyPool { constructor(keys: Record<Provider, string[]>) }`
  - `getAvailableKey(provider: Provider): string | null` — round-robins among keys not currently on cooldown for that provider; returns `null` if every configured key for that provider is on cooldown or none are configured.
  - `reportFailure(provider: Provider, key: string, retryAfterSeconds?: number): void` — puts `key` on cooldown until `now + (retryAfterSeconds ?? DEFAULT_COOLDOWN_SECONDS)`.
  - `reportSuccess(provider: Provider, key: string): void` — no-op today (reserved for future adaptive tuning); still call it at the right point so later tuning doesn't need new call sites threaded in.
  - `export const DEFAULT_COOLDOWN_SECONDS = 60;`

- [ ] **Step 1: Write the failing tests**

Match `tests/index.test.ts`'s real `registerTest(category, name, fn)` convention (grep the file for an existing `registerTest("EventBus", ...)` or similar block and copy its exact calling shape before writing these).

```typescript
// category: "KeyPool"
registerTest("KeyPool", "getAvailableKey rotates round-robin among configured keys", () => {
  const pool = new KeyPool({ groq: ["k1", "k2"], gemini: [] });
  const first = pool.getAvailableKey("groq");
  const second = pool.getAvailableKey("groq");
  if (first === second) throw new Error(`expected rotation, got the same key twice: ${first}`);
  if (![first, second].every((k) => ["k1", "k2"].includes(k as string))) {
    throw new Error("returned a key not in the configured pool");
  }
});

registerTest("KeyPool", "getAvailableKey returns null for a provider with no configured keys", () => {
  const pool = new KeyPool({ groq: [], gemini: [] });
  if (pool.getAvailableKey("gemini") !== null) throw new Error("expected null for an empty pool");
});

registerTest("KeyPool", "reportFailure puts a key on cooldown and it's skipped until it elapses", () => {
  const pool = new KeyPool({ groq: ["only-key"], gemini: [] });
  pool.reportFailure("groq", "only-key", 0.05); // 50ms cooldown for a fast test
  if (pool.getAvailableKey("groq") !== null) throw new Error("expected the sole key to be on cooldown");
});

registerTest("KeyPool", "a key becomes available again after its cooldown elapses", async () => {
  const pool = new KeyPool({ groq: ["only-key"], gemini: [] });
  pool.reportFailure("groq", "only-key", 0.05);
  await new Promise((resolve) => setTimeout(resolve, 80));
  if (pool.getAvailableKey("groq") !== "only-key") throw new Error("expected the key to recover after cooldown");
});

registerTest("KeyPool", "all keys on cooldown for a provider returns null, not throw", () => {
  const pool = new KeyPool({ groq: ["k1", "k2"], gemini: [] });
  pool.reportFailure("groq", "k1", 60);
  pool.reportFailure("groq", "k2", 60);
  if (pool.getAvailableKey("groq") !== null) throw new Error("expected null when every key is on cooldown");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Expected: `Cannot find module '../src/runtime/key-pool.js'`.

- [ ] **Step 3: Implement**

```typescript
// src/runtime/key-pool.ts
export type Provider = "groq" | "gemini";

export const DEFAULT_COOLDOWN_SECONDS = 60;

interface KeyState {
  key: string;
  cooldownUntil: number; // epoch ms; 0 means never on cooldown
}

export class KeyPool {
  private state: Record<Provider, KeyState[]>;
  private cursor: Record<Provider, number> = { groq: 0, gemini: 0 };

  constructor(keys: Record<Provider, string[]>) {
    this.state = {
      groq: keys.groq.map((key) => ({ key, cooldownUntil: 0 })),
      gemini: keys.gemini.map((key) => ({ key, cooldownUntil: 0 })),
    };
  }

  getAvailableKey(provider: Provider): string | null {
    const keys = this.state[provider];
    if (keys.length === 0) return null;
    const now = Date.now();
    for (let i = 0; i < keys.length; i++) {
      const idx = (this.cursor[provider] + i) % keys.length;
      if (keys[idx].cooldownUntil <= now) {
        this.cursor[provider] = (idx + 1) % keys.length;
        return keys[idx].key;
      }
    }
    return null;
  }

  reportFailure(provider: Provider, key: string, retryAfterSeconds?: number): void {
    const entry = this.state[provider].find((k) => k.key === key);
    if (!entry) return;
    entry.cooldownUntil = Date.now() + (retryAfterSeconds ?? DEFAULT_COOLDOWN_SECONDS) * 1000;
  }

  reportSuccess(_provider: Provider, _key: string): void {
    // Reserved for future adaptive cooldown tuning.
  }

  // Used by cognition-router.ts's pool-strain check — the fraction of all
  // configured keys, across all providers, currently on cooldown.
  strainRatio(): number {
    const all = [...this.state.groq, ...this.state.gemini];
    if (all.length === 0) return 0;
    const now = Date.now();
    const onCooldown = all.filter((k) => k.cooldownUntil > now).length;
    return onCooldown / all.length;
  }
}
```

- [ ] **Step 4: Run tests, confirm pass**

Export `POSTGRES_HOST=localhost POSTGRES_USER=jarvis_user POSTGRES_DB=jarvis INTERNAL_API_KEY=<real value from .env> OAUTH_TOKEN_ENCRYPTION_KEY=<real value from .env>` first. Run `npx tsc --noEmit && npm test`.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/key-pool.ts tests/index.test.ts
git commit -m "feat: add a per-provider API key pool with rotation and cooldown"
```

---

## Task 2: `src/kernel/state/usage-repo.ts` — per-user fair-share usage tracking

**Files:**
- Create: `src/kernel/state/migrations/007_usage_events.ts` (check `src/kernel/state/migrations/` for the actual next-available id before writing this filename — `006_reward_events.ts` was the highest at plan-writing time, but confirm)
- Create: `src/kernel/state/usage-repo.ts`
- Test: `tests/index.test.ts`

**Interfaces:**
- Consumes: this codebase's existing migration-runner convention (read `006_reward_events.ts` in full before writing the new migration — match its exact export shape, query style, and how it registers with `src/kernel/state/migrations/index.ts`) and existing Postgres pool access pattern (read any existing repo like `src/kernel/state/objective-runs-repo.ts` for the real `getPool()`/query-and-catch-connection-errors convention every repo in this codebase already follows).
- Produces:
  - `export async function recordUsage(username: string, tokens: number): Promise<void>` — inserts a row `{username, tokens, created_at: now}`. Swallows/logs a connection error rather than throwing (matches every other repo's degrade-cleanly convention — check the exact pattern, e.g. try/catch returning early with a warn-level telemetry log).
  - `export async function getRecentShare(username: string, windowMinutes: number): Promise<number | null>` — returns `null` if Postgres is unreachable (the caller treats `null` as "no throttling signal"). Otherwise: sums tokens for `username` in the last `windowMinutes`, sums tokens for ALL users in the same window, counts distinct usernames in the same window; returns `0` if total tokens in the window is `0` (no data yet — never throttle); otherwise returns the ratio `userTokens / (totalTokens / distinctUserCount)` — i.e., this user's tokens relative to what an equal per-user share of the current traffic would be. A lone active user always gets exactly `1.0` (never triggers "over share").

- [ ] **Step 1: Read the existing migration and repo conventions completely**

Read `src/kernel/state/migrations/006_reward_events.ts` and `src/kernel/state/migrations/index.ts` in full. Read one existing simple repo (`src/kernel/state/objective-runs-repo.ts` or similar) in full for the exact Postgres-pool-access and degrade-cleanly pattern used throughout this codebase — every repo's `catch` block on a connection error follows the same shape, use it exactly, don't invent a new one.

- [ ] **Step 2: Write the migration**

Follow `006_reward_events.ts`'s exact structure. Table:

```sql
CREATE TABLE IF NOT EXISTS usage_events (
  id SERIAL PRIMARY KEY,
  username TEXT NOT NULL,
  tokens INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_usage_events_created_at ON usage_events (created_at);
```

(Adjust to match this codebase's actual migration query-builder/raw-SQL convention exactly, per Step 1's reading — do not guess.)

- [ ] **Step 3: Write the failing tests**

Match this codebase's existing repo-test convention for "degrades cleanly when Postgres isn't reachable" (grep `tests/index.test.ts` for an existing example, e.g. under `"Vault"` or `"CodingPlanTasks"`, and copy its exact shape — these tests run with no live Postgres in the test process, by design).

```typescript
// category: "UsageRepo"
registerTest("UsageRepo", "recordUsage degrades cleanly when Postgres isn't reachable", async () => {
  const { recordUsage } = await import("../src/kernel/state/usage-repo.js");
  await recordUsage("test_user", 100); // must not throw
});

registerTest("UsageRepo", "getRecentShare degrades cleanly when Postgres isn't reachable", async () => {
  const { getRecentShare } = await import("../src/kernel/state/usage-repo.js");
  const result = await getRecentShare("test_user", 10);
  if (result !== null) throw new Error(`expected null when Postgres is unreachable, got ${result}`);
});
```

- [ ] **Step 4: Run tests to verify they fail, then implement, then verify they pass**

Implement `usage-repo.ts` following the exact conventions read in Step 1. Export `POSTGRES_HOST=localhost POSTGRES_USER=jarvis_user POSTGRES_DB=jarvis INTERNAL_API_KEY=<real value from .env> OAUTH_TOKEN_ENCRYPTION_KEY=<real value from .env>` and run `npx tsc --noEmit && npm test`.

- [ ] **Step 5: Commit**

```bash
git add src/kernel/state/migrations/ src/kernel/state/usage-repo.ts tests/index.test.ts
git commit -m "feat: add per-user usage tracking for cognition-router fair-share"
```

---

## Task 3: Rename `omniroute-client.ts` → `openai-compatible-client.ts`

**Files:**
- Rename: `src/runtime/omniroute-client.ts` → `src/runtime/openai-compatible-client.ts`
- Modify: every file importing from `omniroute-client.js` (found via Step 1's grep)

**Interfaces:**
- Consumes: nothing new.
- Produces: identical exports (`OmniRouteConfig` → rename the interface itself to `OpenAiCompatibleConfig` for clarity since it's no longer OmniRoute-specific; `generateWithFallback` keeps its exact signature and behavior).

- [ ] **Step 1: Find every reference**

Run: `grep -rln "omniroute-client\|OmniRouteConfig" src/ tests/ --include="*.ts"` — this is the complete list of files this task touches.

- [ ] **Step 2: Rename the file, rename the type**

```bash
git mv src/runtime/omniroute-client.ts src/runtime/openai-compatible-client.ts
```

In the renamed file, rename the `OmniRouteConfig` interface to `OpenAiCompatibleConfig` and update its doc comment to drop the OmniRoute-specific framing (it's a generic OpenAI-compatible chat-completions HTTP client — say that plainly). Keep `generateWithFallback`'s implementation byte-for-byte identical otherwise — this task is a rename, not a behavior change.

- [ ] **Step 3: Update every importing file**

For each file Step 1 found: change the import path from `./omniroute-client.js` / `../runtime/omniroute-client.js` (adjust relative depth per file) to the new `openai-compatible-client.js` path, and rename every `OmniRouteConfig` type reference to `OpenAiCompatibleConfig`. Do NOT rename variable names like `omniRoute` in this task — that's cosmetic churn belonging to later tasks that touch those files anyway for other reasons (Tasks 6, 7, 9); this task only fixes the import path and the type name so `tsc` stays clean.

- [ ] **Step 4: Typecheck, run tests**

Run: `npx tsc --noEmit && npm test`. Expected: clean, no errors, no test regressions — this is a pure rename.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: rename omniroute-client.ts to openai-compatible-client.ts, it was never OmniRoute-specific"
```

---

## Task 4: `src/runtime/cognition-router.ts` — the router

**Files:**
- Create: `src/runtime/cognition-router.ts`
- Test: `tests/index.test.ts`

**Interfaces:**
- Consumes: `KeyPool` (Task 1), `recordUsage`/`getRecentShare` (Task 2), `generateWithFallback`/`OpenAiCompatibleConfig` (Task 3, from `openai-compatible-client.js`), `ObservationPlatform.logTelemetry` (existing), `LocalCognitiveEngine` (existing, `src/runtime/local_engine.ts`), `assertSafeEgressUrl`/`normalizeLocalLlmUrl` (existing, `src/kernel/egress.ts`).
- Produces:
  - `export interface RouterDeps { keyPool: KeyPool; recordUsage: typeof recordUsage; getRecentShare: typeof getRecentShare; localLlmEndpoint: string; localModelName: string; localApiKey?: string; localEngine: { generateResponse: (message: string, workspace: CognitiveWorkspace, systemMetrics: any) => string }; }` — deliberately NOT `workspace`/`systemMetrics` fields on `RouterDeps`: `CognitiveWorkspace` (`src/cognition/workspace.ts`) has a no-arg constructor (every compartment self-initializes, e.g. `public mission = new WorkspaceMission()`), and `ObservationPlatform.getInstance().getMetrics().system` is cheap and always current — so the keyword-engine tier constructs a fresh, minimal `new CognitiveWorkspace()` and reads live metrics at the point of need inside `generateWithFallback`, not from constructor-time-fixed values. This matters because most callers of the router (`departments.ts`, `identity.ts`, `reflection.ts`, `daily-adaptation.ts`, etc.) are background jobs with no real per-request `CognitiveWorkspace` in scope at all — only `server.ts`'s actual chat handlers have one, and threading it from there into a startup-constructed singleton router would be a lifecycle mismatch. `localEngine` defaults to `LocalCognitiveEngine.getInstance()` in real construction (Task 8) but is typed as a minimal interface here so tests can inject a fake without importing the real singleton.
  - `export class CognitionRouter { constructor(deps: RouterDeps) }`
  - `async generateWithFallback(username: string, params: any, models: string[]): Promise<any>` — the public interface every downstream call site uses. `models` are provider-prefixed strings (`"groq:llama-3.3-70b-versatile"`, `"gemini:gemini-2.0-flash"`).

- [ ] **Step 1: Read `local_engine.ts`'s real interface before writing anything**

`LocalCognitiveEngine.generateResponse`'s exact parameter types matter for `RouterDeps` — read the file in full first.

- [ ] **Step 2: Write the failing tests**

```typescript
// category: "CognitionRouter"
registerTest("CognitionRouter", "a normal-capacity request is not throttled and returns the cloud response", async () => {
  const { CognitionRouter } = await import("../src/runtime/cognition-router.js");
  const { KeyPool } = await import("../src/runtime/key-pool.js");
  const keyPool = new KeyPool({ groq: ["gk1"], gemini: [] });

  const router = new CognitionRouter({
    keyPool,
    recordUsage: async () => {},
    getRecentShare: async () => 1.0, // exactly average — never throttled
    localLlmEndpoint: "http://unused:8080",
    localModelName: "unused",
    localEngine: { generateResponse: () => "should not be called" },
    // Injected fake transport — the real generateWithFallback (openai-compatible-client)
    // is swapped for a test double via a constructor-injectable field; add
    // one if RouterDeps doesn't already have a natural seam for this (e.g.
    // `transport?: typeof generateWithFallback`, defaulting to the real
    // import) — needed so this test makes no real network call.
  } as any);

  // (Implementer: wire the fake transport per the seam you add to RouterDeps/CognitionRouter
  // and assert the router returns its response unchanged for a first-try success.)
});

registerTest("CognitionRouter", "an over-share user under a strained pool is delayed, not rejected", async () => {
  // getRecentShare returns e.g. 5.0 (way over an equal share) AND keyPool.strainRatio() > 0.5
  // (achieve this by reporting failures on most configured keys before the call) —
  // assert the call still eventually resolves successfully, just after a measurable delay
  // (e.g. assert elapsed time >= some small threshold using a short test-only delay constant,
  // matching how Task 1's cooldown tests use short durations instead of the real default).
});

registerTest("CognitionRouter", "a 429-shaped failure triggers cooldown and retries the next key", async () => {
  // Inject a fake transport that fails on the first key/model and succeeds on the second;
  // assert the router's final result is the successful one, and that keyPool.getAvailableKey
  // no longer offers the failed key immediately afterward (it's on cooldown).
});

registerTest("CognitionRouter", "full cloud exhaustion falls through to the local LLM tier with tools stripped", async () => {
  // keyPool with no available keys for either provider (getAvailableKey always null) —
  // assert the router attempts the local LLM tier (inject a fake local-tier transport call
  // and assert it was called with params that do NOT include `tools`, even though the
  // original params passed in did include tools).
});

registerTest("CognitionRouter", "local LLM tier also failing falls through to the keyword engine", async () => {
  // keyPool exhausted AND the local-tier fake transport throws —
  // assert localEngine.generateResponse was called and its return value is what
  // generateWithFallback ultimately resolves to (wrapped in the same response shape
  // every other tier returns, e.g. {choices: [{message: {content: <its return value>}}]}).
});
```

Write these against whatever concrete dependency-injection seam you design into `CognitionRouter`/`RouterDeps` in Step 3 — the sketches above describe the required *behavior*, not exact code, since the DI shape depends on real decisions made while reading `local_engine.ts` and `openai-compatible-client.ts` in Step 1. Match `tests/index.test.ts`'s real `registerTest`/throw-based assertion convention throughout, not the pseudocode shape above.

- [ ] **Step 3: Implement**

Design `CognitionRouter` with an injectable transport function (defaulting to the real `generateWithFallback` from `openai-compatible-client.js`) so tests never make real network calls — this is the same dependency-injection pattern already established this session for `shadow-verifier.ts`'s `execFn` parameter.

Core logic for `generateWithFallback(username, params, models)`:
1. `const share = await this.deps.getRecentShare(username, 10);` — if `share !== null && share > 2.0 && this.deps.keyPool.strainRatio() > 0.5`, `await delay(3000)` before proceeding (use a small injectable delay function, not a bare `setTimeout`-in-code, so tests can use a short delay instead of waiting 3 real seconds).
2. For each `model` in `models`: split on the first `:` to get `provider` and `realModel`. Get an available key via `keyPool.getAvailableKey(provider)`; if `null`, skip to the next model (this covers "this provider is fully on cooldown, try the next model/provider in the list"). Otherwise attempt via the transport function against that provider's real base URL (`https://api.groq.com/openai/v1` for `groq`, `https://generativelanguage.googleapis.com/v1beta/openai` for `gemini`) with that key, for just that one `realModel`. On success: `keyPool.reportSuccess(...)`, `await this.deps.recordUsage(username, <tokens from the response's usage field if present, else a reasonable estimate>)`, return the response. On failure: `keyPool.reportFailure(provider, key, <Retry-After from the error if parseable>)`, continue to the next model.
3. If every model in the list failed (cloud fully exhausted): build `localParams` as a shallow copy of `params` with `tools`/`tool_choice` deleted; `assertSafeEgressUrl(normalizeLocalLlmUrl(this.deps.localLlmEndpoint))`; attempt the transport function against `{apiKey: this.deps.localApiKey ?? "", baseUrl: normalizeLocalLlmUrl(this.deps.localLlmEndpoint)}` with `[this.deps.localModelName]`. Log this tier transition via `ObservationPlatform.logTelemetry("info", "Cognition", ...)`. On success, return it in the same shape.
4. If the local LLM tier also fails: log the transition, call `this.deps.localEngine.generateResponse(<the last user message from params.messages>, this.deps.workspace, this.deps.systemMetrics)`, and wrap its plain-string return value into the same OpenAI-compatible shape every caller already expects: `{choices: [{message: {content: <string>, role: "assistant"}}]}`.

- [ ] **Step 4: Run tests, confirm pass**

Export the standard env vars and run `npx tsc --noEmit && npm test`.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/cognition-router.ts tests/index.test.ts
git commit -m "feat: add the CognitionRouter — multi-key failover, fair-share throttling, real fallback chain"
```

---

## Task 5: `src/runtime/clients.ts` — `getCognitionRouter()`/`setSharedRouter()`

**Files:**
- Modify: `src/runtime/clients.ts`
- Modify: any test file stubbing `getOmniRoute`/`setSharedClient` (found via grep)

**Interfaces:**
- Consumes: `CognitionRouter` (Task 4).
- Produces: `getCognitionRouter(): CognitionRouter | null`, `setSharedRouter(router: CognitionRouter | null): void` — same singleton-holder shape `getOmniRoute()`/`setSharedClient()` already has, just renamed and retyped.

- [ ] **Step 1: Read the current `getOmniRoute`/`setSharedClient` implementation in full**

- [ ] **Step 2: Rename and retype**

Apply the identical structure with `CognitionRouter | null` in place of `OmniRouteConfig | null`, and the new names.

- [ ] **Step 3: Fix callers and test stubs**

`grep -rln "getOmniRoute\|setSharedClient" src/ tests/ --include="*.ts"` — update every reference's name (the actual call sites' logic/control-flow doesn't change, only the imported name and the type flowing through it — full retyping of call sites happens in Task 9, this task only fixes what's needed for `clients.ts` itself to compile and for any test that directly stubs this specific function).

- [ ] **Step 4: Typecheck, run tests, commit**

Run: `npx tsc --noEmit && npm test` (some errors are expected in files Task 9 hasn't touched yet — confirm any remaining error is genuinely about a downstream file still expecting the old `getOmniRoute` name/type, not a mistake in this task's own change).

```bash
git add src/runtime/clients.ts tests/
git commit -m "feat: clients.ts exposes getCognitionRouter()/setSharedRouter() in place of getOmniRoute()/setSharedClient()"
```

---

## Task 6: `src/runtime/groq-client.ts` — retype to `CognitionRouter`

**Files:**
- Modify: `src/runtime/groq-client.ts`

**Interfaces:**
- Consumes: `CognitionRouter` (Task 4).
- Produces: `generateWithFallback(router: CognitionRouter, username: string, params: any, models: string[]): Promise<any>` — delegates to `router.generateWithFallback(username, params, models)`. (This file's own `generateWithFallback` becomes a thin, username-aware wrapper — every caller of THIS file's function, not the router directly, needs the same one new `username` argument threaded through; that's Task 9's job for callers outside this file.)

- [ ] **Step 1: Read the current file in full** (it's short — under 70 lines).

- [ ] **Step 2: Update the delegation**

```typescript
import type { CognitionRouter } from "./cognition-router.js";

// ... toGroqSchema/toGroqTools unchanged ...

export async function generateWithFallback(router: CognitionRouter, username: string, params: any, models: string[]): Promise<any> {
  return router.generateWithFallback(username, params, models);
}
```

- [ ] **Step 3: Typecheck, commit**

```bash
git add src/runtime/groq-client.ts
git commit -m "feat: groq-client.ts's generateWithFallback delegates to CognitionRouter, threads username"
```

(Expect remaining `tsc` errors in this function's own callers — Task 9 fixes those.)

---

## Task 7: `src/runtime/groq-agent-client.ts` — retype, thread `username` into `callGroqAgentChat`

**Files:**
- Modify: `src/runtime/groq-agent-client.ts`
- Modify: `src/executive/coding-agent.ts` (the sole caller of `callGroqAgentChat` — needs `username` threaded from ITS OWN caller too; trace it via `grep -rn "runCodingAgent(" src/` to find where `username` already exists at the top of that call chain, e.g. a build-request processing route)

**Interfaces:**
- Consumes: `CognitionRouter` (Task 4).
- Produces: `callGroqAgentChat(router: CognitionRouter, username: string, messages: AgentMessage[], tools: AgentTool[], modelOrder?: string[]): Promise<AgentChatResult>`.

- [ ] **Step 1: Read the current file in full, and trace `runCodingAgent`'s real caller chain**

`runCodingAgent` (in `coding-agent.ts`) doesn't currently take `username` either. Find its own caller(s) via `grep -rn "runCodingAgent(" src/` — trace upward until you find where `username`/`req.username` is genuinely available (this codebase threads `username` almost everywhere since it's inherently per-user; it should be available a level or two up, not require inventing a new source of truth).

- [ ] **Step 2: Thread `username` through both functions**

Add `username: string` as a new parameter to both `callGroqAgentChat` and `runCodingAgent`, pass it through at each of the 3 `callGroqAgentChat` call sites inside `coding-agent.ts` (lines ~265, ~500, ~618 per this plan's own audit — re-verify current line numbers), and update `runCodingAgent`'s own caller(s) found in Step 1 to pass their already-available `username` value in.

- [ ] **Step 3: Retype the `OpenAiCompatibleConfig`/router parameter**

Same rename pattern as Task 6: `config: OpenAiCompatibleConfig` → `router: CognitionRouter`, delegating via `router.generateWithFallback(username, {...}, models)` instead of the old direct transport call.

- [ ] **Step 4: Typecheck, run tests, commit**

```bash
git add src/runtime/groq-agent-client.ts src/executive/coding-agent.ts
git commit -m "feat: thread username through the coding agent's call chain into CognitionRouter"
```

(Expect remaining `tsc` errors in `coding-agent.ts`'s own callers if they don't yet pass `username` — fix them as part of this task if they're trivial one-line additions with `username` already in scope; if a genuinely new plumbing problem turns up, note it in your report rather than guessing.)

---

## Task 8: `src/server.ts` — client construction, `.env.example`

**Files:**
- Modify: `src/server.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes: `CognitionRouter`, `KeyPool` (Tasks 1, 4), `setSharedRouter` (Task 5).

- [ ] **Step 1: Read the current OmniRoute client-construction block in `server.ts` in full** (originally near where `process.env.OMNIROUTE_API_KEY` is checked, per this plan's earlier audit — re-locate exactly).

- [ ] **Step 2: Replace it**

```typescript
const groqKeys = (process.env.GROQ_API_KEYS || "").split(",").map((k) => k.trim()).filter(Boolean);
const geminiKeys = (process.env.GEMINI_API_KEYS || "").split(",").map((k) => k.trim()).filter(Boolean);

if (groqKeys.length > 0 || geminiKeys.length > 0) {
  const keyPool = new KeyPool({ groq: groqKeys, gemini: geminiKeys });
  const router = new CognitionRouter({
    keyPool,
    recordUsage,
    getRecentShare,
    localLlmEndpoint: kernel.localLlmEndpoint,
    localModelName: kernel.localModelName,
    localApiKey: kernel.localApiKey,
    localEngine: LocalCognitiveEngine.getInstance(), // the real singleton — matches this codebase's existing usage elsewhere, no per-call workspace/metrics needed here (see Task 4's RouterDeps note)
  });
  setSharedRouter(router);
} else {
  observation.logTelemetry("warn", "Cognition", "No GROQ_API_KEYS or GEMINI_API_KEYS configured. Cloud-backed cognition features unavailable — falling back to local LLM/keyword engine only.");
}
```

Adjust to match exactly how/where the OmniRoute construction block currently lives (module scope vs. inside an async startup function) — don't change its lifecycle, only what it constructs.

- [ ] **Step 3: Update `.env.example`**

Replace the `OMNIROUTE_API_KEY`/`OMNIROUTE_BASE_URL` block with:

```
# Cognition router — Jarvis's own multi-key provider pool (replaces the
# prior OmniRoute integration). Comma-separated; supports multiple keys per
# provider so one hitting a rate limit doesn't take the whole provider down.
# GEMINI_API_KEY (singular) is still required separately for voice-native
# mode and semantic memory embeddings, which this does not replace.
GROQ_API_KEYS=
GEMINI_API_KEYS=
```

- [ ] **Step 4: Typecheck, run tests, commit**

```bash
git add src/server.ts .env.example
git commit -m "feat: construct the CognitionRouter from GROQ_API_KEYS/GEMINI_API_KEYS in server.ts"
```

---

## Task 9: Retype every downstream call site to `CognitionRouter`, thread `username` everywhere needed

**Files:** (discovered via Step 1's `tsc`/grep sweep — expect at minimum)
- `src/world/briefing.ts`, `src/executive/departments.ts`, `src/self/identity.ts`, `src/adaptation/reflection.ts`, `src/adaptation/daily-adaptation.ts`, `src/cognition/knowledge-graph.ts`, `src/kernel/scheduler.ts`, `src/executive/autonomous_executive.ts`, `src/interaction/live-voice.ts` (only its 3 narrow post-turn-analysis call sites, exactly as this codebase's earlier OmniRoute migration scoped it — do not touch `ai.live.connect()`), `src/interaction/routes/briefing-memory-routes.ts`, `src/interaction/routes/knowledge-routes.ts`, `src/interaction/routes/build-requests-routes.ts`.

**Interfaces:**
- Consumes: `CognitionRouter`, `getCognitionRouter` (Tasks 4, 5).

- [ ] **Step 1: Find every remaining reference**

Run: `npx tsc --noEmit 2>&1 | grep -oE "src/[a-zA-Z0-9_/.-]+\.ts" | sort -u` and cross-reference with `grep -rln "OmniRouteConfig\|getOmniRoute\|omniRoute" src/ --include="*.ts" | grep -v test`.

- [ ] **Step 2: Apply the same mechanical retype to every file found**

For each: rename the parameter (`omniRoute` → `router`), retype (`OmniRouteConfig | null` → `CognitionRouter | null`), update the import, and — this is the one real difference from the original migration's equivalent task — add `username` as a new argument to every `generateWithFallback`/`callGroqAgentChat` call inside that file if it isn't already threaded (most of these functions already take `username` as a parameter for their own purposes; use that same value rather than inventing a second source).

`departments.ts`'s `reviewCodeDiff(objective, files, omniRoute)` is the one function in this file that genuinely lacks `username` — add it as a new parameter: `reviewCodeDiff(objective, files, router, username)`, and update its sole caller in `build-requests-routes.ts` (`departments.reviewCodeDiff(buildRequest.objective, files, getOmniRoute())` → `departments.reviewCodeDiff(buildRequest.objective, files, getCognitionRouter(), req.username)`).

- [ ] **Step 3: Fix every caller of these now-retyped functions**

`grep -rn "generateBriefing(\|reviewCodeDiff(\|reviewTaskDiff(\|generateProactiveThought(" src/ --include="*.ts" | grep -v test` — update each `getOmniRoute()` call to `getCognitionRouter()`.

- [ ] **Step 4: Typecheck — this task's real completion gate**

Run: `npx tsc --noEmit`. Expected: no errors remaining anywhere EXCEPT `server.ts`'s two still-unmigrated call sites (Tasks 10-11 handle those).

- [ ] **Step 5: Run tests, fix any test stubbing the old names, commit**

```bash
git add -A
git commit -m "refactor: retype every downstream call site to CognitionRouter, thread username through reviewCodeDiff"
```

(List the exact files in `git add` per what Step 1 actually found, not `-A`, if you'd rather be precise — either is fine as long as the diff matches what this task describes.)

---

## Task 10: `src/server.ts` — migrate the `/api/chat` Gemini branch

**Files:**
- Modify: `src/server.ts`

**Interfaces:**
- Consumes: `CognitionRouter`, `toGroqTools` (existing, unchanged).

- [ ] **Step 1: Read the current `else if (step === "Gemini")` branch and the adjacent working Groq/router branch in full**

- [ ] **Step 2: Replace the Gemini branch's body**

Mirror the adjacent already-working branch exactly (same request-building, tool-loop, and streaming-response pattern), but targeting Gemini via the router: `if (router) { ... const chatModels = ["gemini:gemini-2.0-flash", "gemini:gemini-1.5-flash"]; let response = await router.generateWithFallback(req.username, { messages, tools: geminiTools }, chatModels); ... }` — guard is `if (router)`, matching every other now-router-based branch in this file.

- [ ] **Step 3: Typecheck, run tests**

Run: `npx tsc --noEmit && npm test`.

- [ ] **Step 4: Manual verification against real keys, if available**

If `GROQ_API_KEYS`/`GEMINI_API_KEYS` are configured with real, working keys in this environment, start the dev server and send a chat message that requires a tool call, confirming a real tool executes and a real reply streams back. If no real keys are available in this sandbox, document that clearly and rely on the automated tests plus a careful read-through diff against the already-proven adjacent branch.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts
git commit -m "feat: migrate the /api/chat Gemini tier to CognitionRouter"
```

---

## Task 11: `src/server.ts` — migrate `/v1/chat/completions`, remove the old wrapper

**Files:**
- Modify: `src/server.ts`

**Interfaces:**
- Consumes: `CognitionRouter`.

- [ ] **Step 1: Read the current `/v1/chat/completions` handler's Gemini call in full**

- [ ] **Step 2: Replace it**

Same pattern as Task 10: `if (router && !kernel.offlineMode) { ... const response = await router.generateWithFallback(req.username, { messages: [...] }, ["gemini:gemini-2.0-flash", "gemini:gemini-1.5-flash"]); reply = response.choices?.[0]?.message?.content || ""; ... }`, keeping the existing `LocalCognitiveEngine` catch-block fallback untouched (the router already has its OWN internal local-LLM/keyword fallback chain for cloud exhaustion — this outer catch is for a different failure class, e.g. the router itself throwing on a bug or misconfiguration; leave it as this file's last line of defense exactly as it already is).

- [ ] **Step 3: Remove the now-unused old wrapper function, if any remain**

Run: `grep -n "generateContentWithFallback" src/server.ts` — if zero call sites remain anywhere in the file, delete that function definition entirely. If any remain (e.g. Task 7 from the original migration kept `/api/voice-input` on direct Gemini SDK, unrelated to this router), leave the wrapper in place and note why in your report.

- [ ] **Step 4: Typecheck, run tests, commit**

```bash
git add src/server.ts
git commit -m "feat: migrate /v1/chat/completions to CognitionRouter, remove the unused Gemini-specific wrapper if any"
```

---

## Task 12: Final cleanup and verification

**Files:** none new — verification only, fix anything found.

- [ ] **Step 1: Full sweep for stale naming**

Run: `grep -rn "omniroute\|OmniRoute\|OMNIROUTE" src/ tests/ docs/superpowers/plans/2026-08-07-jarvis-cognition-router.md .env.example --include="*.ts" -i` — every remaining hit should be either historical/comparative prose in a comment (explicitly explaining what this replaced) or inside the untouched original `docs/superpowers/plans/2026-08-03-omniroute-cognition-gateway.md`/`docs/superpowers/specs/2026-08-03-omniroute-cognition-gateway-design.md` files (out of scope — those are this branch's own history, not live code). No functional code, env var, or import path should still reference OmniRoute.

- [ ] **Step 2: Confirm `tsc --noEmit` is fully clean**

Run: `npx tsc --noEmit`. Expected: zero errors anywhere.

- [ ] **Step 3: Confirm the full test suite passes**

Export the standard env vars and run `npm test`. Expected: all tests pass, including every new test added across this plan's 12 tasks.

- [ ] **Step 4: Confirm Gemini voice-native and embeddings are untouched**

`grep -n "ai.live.connect\|embedContent" src/interaction/live-voice.ts src/**/*.ts` — confirm these still use the direct `@google/genai` SDK via `getAi()`, unaffected by this entire plan.

- [ ] **Step 5: If real `GROQ_API_KEYS`/`GEMINI_API_KEYS` are available in this environment, do one real end-to-end manual check**

Start the dev server, send a real chat message, confirm a real cloud response comes back through the new router (check server logs for `CognitionRouter`/key-pool telemetry lines rather than the old OmniRoute ones). If no real keys are available, document that plainly rather than claiming a check that didn't happen.

- [ ] **Step 6: Update `docs/superpowers/specs/2026-08-07-jarvis-cognition-router-design.md`'s status if needed, commit final state**

```bash
git add -A
git commit -m "chore: final verification for the Jarvis cognition router migration" --allow-empty
```

(Empty commit only if Steps 1-5 found nothing needing a code change — otherwise commit whatever was actually fixed.)
