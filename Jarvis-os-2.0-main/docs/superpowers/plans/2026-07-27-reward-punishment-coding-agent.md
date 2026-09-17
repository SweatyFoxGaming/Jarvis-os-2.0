# Reward/Punishment System for the Coding Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the coding agent a persistent reward ledger over real outcomes (per-task review verdicts, terminal build outcomes) that biases which model it tries first, how carefully it proceeds, and whether it pauses to ask before starting — all read-side aggregations over one new table, no changes to any LLM's weights.

**Architecture:** One new Postgres table (`reward_events`) plus two new nullable columns on `build_requests` (`coding_model_used`, `task_category`). A new `reward-events-repo.ts` owns the single write path and three read aggregations (`getModelPreferenceOrder`, `getCategoryScore`, `getOverallScore`); every consumer (dashboard, model-order override in the coding loop, a caution sentence in its system prompt, a confirmation gate in `confirmDirection`) only ever reads from this one repo.

**Tech Stack:** Node.js/TypeScript, Express, PostgreSQL via `pg`, Groq SDK. No new dependencies.

**Full design context:** `docs/superpowers/specs/2026-07-27-reward-punishment-coding-agent-design.md` — read this first if any task below is ambiguous; it explains *why*, this plan only covers *what/how*.

## Global Constraints

- No changes to any LLM provider, no fine-tuning, no weight updates — this is a behavior-layer bias, not RL. Naming throughout must say what it is (`reward-events`), never imply gradient-based learning.
- Every new repo read function degrades to "no data" (`null`, or an unchanged input) on any DB failure or empty result set — never throws, never treated as a score of 0. Match the exact pattern already used by `getRecentOutcomeSuccessRate`/`getLatestAwaitingConsult` etc.
- `recordRewardEvent` is fire-and-forget from every caller's perspective: internally try/catch + `observation.logTelemetry("warn", ...)`, never lets a recording failure block or fail a coding session.
- No new chat tool, no new capability-gated user action beyond the one new read-only `reward.read` capability for the dashboard route.
- `npx tsc --noEmit` and `npm test` must both pass after every task below, before that task's commit.
- Never reorder/renumber a migration once it's been committed on this branch's history — this plan's migration is `006_reward_events`; if a conflicting `006` lands on `main` before this ships, renumber to the next free id, don't overwrite.

---

## File Structure

| File | Change |
|---|---|
| `src/kernel/state/migrations/006_reward_events.ts` | Create — `reward_events` table + `build_requests` columns |
| `src/kernel/state/migrations/index.ts` | Modify — register `m006` |
| `src/kernel/state/reward-events-repo.ts` | Create — write path + 3 read aggregations |
| `src/executive/task-category.ts` | Create — `classifyTaskCategory` pure function |
| `src/runtime/groq-agent-client.ts` | Modify — `modelOrder` param, `modelUsed` in `AgentChatResult` |
| `src/kernel/state/build-requests-repo.ts` | Modify — `recordCodeDraft` accepts/persists `modelUsed`/`category`; `getLatestPendingRewardGate` added |
| `src/executive/coding-agent.ts` | Modify — category/model-order resolution, caution injection, reward recording, widened `CodingAgentResult` |
| `src/executive/autonomous_executive.ts` | Modify — extract `startCoding`, add the reward gate |
| `src/interaction/routes/build-requests-routes.ts` | Modify — record `terminal_outcome` events at approve-code/reject-code |
| `src/interaction/routes/reward-routes.ts` | Create — `GET /api/reward/summary` |
| `src/kernel/security.ts` | Modify — add `reward.read` capability |
| `src/server.ts` | Modify — mount `rewardRouter` |
| `src/interaction/static/index.html` | Modify — dashboard panel |
| `tests/index.test.ts` | Modify — unit + degrade-cleanly tests |
| `tests/db-integration.test.ts` | Modify — real-Postgres aggregation test |

---

### Task 1: Migration — `reward_events` table + `build_requests` columns

**Files:**
- Create: `src/kernel/state/migrations/006_reward_events.ts`
- Modify: `src/kernel/state/migrations/index.ts`
- Test: `tests/index.test.ts` (existing `Migrations` category test already covers this once registered — no new test needed)

**Interfaces:**
- Produces: `reward_events` table `(id, build_request_id, source, model_used, category, reward_value, created_at)`; `build_requests.coding_model_used TEXT`, `build_requests.task_category TEXT` (both nullable).

- [ ] **Step 1: Write the migration**

```ts
// src/kernel/state/migrations/006_reward_events.ts
import type { Migration } from "./runner.js";

// Backs the reward/punishment system for the coding agent (see
// docs/superpowers/specs/2026-07-27-reward-punishment-coding-agent-design.md).
// This is RL-flavored, not RL — a persistent reward ledger over real
// outcomes (per-task review verdicts, terminal build outcomes) that biases
// model preference and prompting, never a weight update (impossible
// against hosted LLM APIs regardless). One write path, several read-side
// aggregations — see reward-events-repo.ts.
const migration: Migration = {
  id: "006_reward_events",
  description:
    "Create reward_events (one row per reward-worthy coding-agent signal) and add build_requests.coding_model_used/task_category so a build request's terminal outcome can be tagged with the same model/category its earlier task-review events used.",
  up: async (client) => {
    await client.query(`
      CREATE TABLE reward_events (
        id SERIAL PRIMARY KEY,
        build_request_id INTEGER NOT NULL REFERENCES build_requests(id) ON DELETE CASCADE,
        source TEXT NOT NULL,
        model_used TEXT,
        category TEXT NOT NULL,
        reward_value INTEGER NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await client.query(`CREATE INDEX reward_events_model_idx ON reward_events(model_used);`);
    await client.query(`CREATE INDEX reward_events_category_idx ON reward_events(category);`);
    await client.query(`CREATE INDEX reward_events_source_idx ON reward_events(source);`);
    await client.query(`ALTER TABLE build_requests ADD COLUMN coding_model_used TEXT;`);
    await client.query(`ALTER TABLE build_requests ADD COLUMN task_category TEXT;`);
  },
};

export default migration;
```

- [ ] **Step 2: Register it**

Edit `src/kernel/state/migrations/index.ts`: add `import m006 from "./006_reward_events.js";` alongside the existing imports, and change the final line to `export const ALL_MIGRATIONS = [m001, m002, m003, m004, m005, m006];`.

- [ ] **Step 3: Run the existing migration tests**

Run: `npx tsc --noEmit && npm test 2>&1 | grep -E "Migrations|FAILED|TOTALS"`
Expected: all `Migrations` category tests pass, including the new migration counted in `ALL_MIGRATIONS has unique, non-empty ids`.

- [ ] **Step 4: Verify it applies cleanly against a real Postgres**

Spin up a disposable Postgres (matches this session's own established pattern):
```bash
docker run -d --name reward-migration-test-pg -e POSTGRES_PASSWORD=testpass -e POSTGRES_DB=jarvis_test -p 55440:5432 postgres:16
sleep 4
POSTGRES_HOST=localhost POSTGRES_PORT=55440 POSTGRES_USER=postgres POSTGRES_PASSWORD=testpass POSTGRES_DB=jarvis_test DB_INTEGRATION_TEST_CONFIRM=i-accept-data-loss-in-this-database npx tsx tests/db-integration.test.ts
docker rm -f reward-migration-test-pg
```
Expected: log line `Applied migration "006_reward_events": ...` and the existing db-integration suite still passes in full.

- [ ] **Step 5: Commit**

```bash
git add src/kernel/state/migrations/006_reward_events.ts src/kernel/state/migrations/index.ts
git commit -m "feat: add reward_events table and build_requests reward columns"
```

---

### Task 2: `task-category.ts` — pure classifier

**Files:**
- Create: `src/executive/task-category.ts`
- Test: `tests/index.test.ts`

**Interfaces:**
- Produces: `export function classifyTaskCategory(objective: string): string` — returns one of `"database" | "frontend" | "security" | "general"`.

- [ ] **Step 1: Write the failing test**

Add to `tests/index.test.ts`, near the other pure-function test blocks (e.g. after the `Env` category), and add `import { classifyTaskCategory } from "../src/executive/task-category.js";` to the top import block:

```ts
registerTest("TaskCategory", "classifyTaskCategory recognizes database/migration work", () => {
  if (classifyTaskCategory("Add a migration to rename the users table") !== "database") {
    throw new Error("TaskCategory: expected 'database' for a migration-related objective");
  }
});

registerTest("TaskCategory", "classifyTaskCategory recognizes frontend/UI work", () => {
  if (classifyTaskCategory("Build a new dashboard panel for the frontend") !== "frontend") {
    throw new Error("TaskCategory: expected 'frontend' for a dashboard/UI-related objective");
  }
});

registerTest("TaskCategory", "classifyTaskCategory recognizes security/auth work", () => {
  if (classifyTaskCategory("Fix a permission check in the auth middleware") !== "security") {
    throw new Error("TaskCategory: expected 'security' for an auth/permission-related objective");
  }
});

registerTest("TaskCategory", "classifyTaskCategory falls back to general for anything else", () => {
  if (classifyTaskCategory("Write a script that reverses a string") !== "general") {
    throw new Error("TaskCategory: expected 'general' as the fallback for an unrelated objective");
  }
});

registerTest("TaskCategory", "classifyTaskCategory is case-insensitive", () => {
  if (classifyTaskCategory("ADD A DATABASE MIGRATION") !== "database") {
    throw new Error("TaskCategory: expected case-insensitive matching");
  }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test 2>&1 | grep -E "TaskCategory|FAILED"`
Expected: FAIL — `Cannot find module '../src/executive/task-category.js'`.

- [ ] **Step 3: Write the implementation**

```ts
// src/executive/task-category.ts

// A plain keyword classifier, not an LLM call — deliberately: this needs
// to run before coding starts (to shape the system prompt) and after (to
// tag the resulting reward events) with the exact same answer both times,
// and adding a network call/cost/latency to classify a handful of words
// isn't worth it. See the design spec's "Data model" section for why these
// four categories specifically, and why "general" is a real category (not
// an error case) rather than null.
const CATEGORY_KEYWORDS: Record<string, string[]> = {
  database: ["migration", "schema", "database", "postgres", "sql", "table"],
  frontend: ["ui", "dashboard", "frontend", "css", "html", "panel", "button"],
  security: ["auth", "security", "permission", "capability", "credential", "token"],
};

export function classifyTaskCategory(objective: string): string {
  const lower = objective.toLowerCase();
  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (keywords.some((kw) => lower.includes(kw))) {
      return category;
    }
  }
  return "general";
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx tsc --noEmit && npm test 2>&1 | grep -E "TaskCategory|FAILED|TOTALS"`
Expected: all 5 new `TaskCategory` tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/executive/task-category.ts tests/index.test.ts
git commit -m "feat: add classifyTaskCategory pure classifier for reward tagging"
```

---

### Task 3: `reward-events-repo.ts` — write path + read aggregations

**Files:**
- Create: `src/kernel/state/reward-events-repo.ts`
- Test: `tests/index.test.ts` (degrade-cleanly, no live DB)

**Interfaces:**
- Consumes: `getPool()` from `./db.js` (existing pattern every other repo uses).
- Produces:
  - `export type RewardSource = "task_review" | "terminal_outcome";`
  - `export async function recordRewardEvent(buildRequestId: number, source: RewardSource, modelUsed: string | null, category: string, rewardValue: number): Promise<void>`
  - `export async function getModelPreferenceOrder(candidates: string[]): Promise<string[]>`
  - `export async function getCategoryScore(category: string): Promise<{ score: number; count: number } | null>`
  - `export async function getOverallScore(source?: RewardSource): Promise<{ score: number; count: number } | null>`

- [ ] **Step 1: Write the failing tests**

Add to `tests/index.test.ts` (new `import * as rewardEventsRepo from "../src/kernel/state/reward-events-repo.js";` near the other `import * as ...Repo` lines):

```ts
registerTest("RewardEvents", "recordRewardEvent degrades cleanly when Postgres isn't reachable (never throws)", async () => {
  await rewardEventsRepo.recordRewardEvent(999999, "task_review", "some-model", "general", 1);
  // No assertion beyond "didn't throw" — this is a fire-and-forget write path.
});

registerTest("RewardEvents", "getModelPreferenceOrder degrades to the input order unchanged when Postgres isn't reachable", async () => {
  const input = ["model-a", "model-b"];
  const result = await rewardEventsRepo.getModelPreferenceOrder(input);
  if (JSON.stringify(result) !== JSON.stringify(input)) {
    throw new Error(`RewardEvents: expected the input order unchanged with no DB, got: ${JSON.stringify(result)}`);
  }
});

registerTest("RewardEvents", "getCategoryScore degrades cleanly (null, not 0) when Postgres isn't reachable", async () => {
  const result = await rewardEventsRepo.getCategoryScore("database");
  if (result !== null) {
    throw new Error(`RewardEvents: expected null with no DB, got: ${JSON.stringify(result)}`);
  }
});

registerTest("RewardEvents", "getOverallScore degrades cleanly (null, not 0) when Postgres isn't reachable", async () => {
  const result = await rewardEventsRepo.getOverallScore();
  if (result !== null) {
    throw new Error(`RewardEvents: expected null with no DB, got: ${JSON.stringify(result)}`);
  }
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test 2>&1 | grep -E "RewardEvents|FAILED"`
Expected: FAIL — `Cannot find module '../src/kernel/state/reward-events-repo.js'`.

- [ ] **Step 3: Write the implementation**

```ts
// src/kernel/state/reward-events-repo.ts
import { getPool } from "./db.js";
import { ObservationPlatform } from "../observation.js";

const observation = ObservationPlatform.getInstance();

export type RewardSource = "task_review" | "terminal_outcome";

// The one write path. Fire-and-forget from every caller's perspective —
// see the design spec's Error handling section: a failure to record a
// reward event must never block or fail a coding session.
export async function recordRewardEvent(
  buildRequestId: number,
  source: RewardSource,
  modelUsed: string | null,
  category: string,
  rewardValue: number
): Promise<void> {
  try {
    const db = getPool();
    await db.query(
      `INSERT INTO reward_events (build_request_id, source, model_used, category, reward_value) VALUES ($1, $2, $3, $4, $5)`,
      [buildRequestId, source, modelUsed, category, rewardValue]
    );
  } catch (err: any) {
    observation.logTelemetry("warn", "RewardEvents", `recordRewardEvent(${buildRequestId}, ${source}) failed: ${err.message}`);
  }
}

// Reorders `candidates` by descending average reward_value over each
// model's most recent 50 events. A model with zero events gets a neutral
// score of exactly 0 — combined with Array.prototype.sort's stability,
// that means unscored models keep their original relative order, so this
// never disturbs today's fallback order until there's real data to
// justify it. Degrades to `candidates` unchanged on any failure.
export async function getModelPreferenceOrder(candidates: string[]): Promise<string[]> {
  try {
    const db = getPool();
    const scores = new Map<string, number>();
    for (const model of candidates) {
      const { rows } = await db.query(
        `SELECT reward_value FROM reward_events WHERE model_used = $1 ORDER BY created_at DESC LIMIT 50`,
        [model]
      );
      const avg = rows.length > 0 ? rows.reduce((sum: number, r: any) => sum + r.reward_value, 0) / rows.length : 0;
      scores.set(model, avg);
    }
    return [...candidates].sort((a, b) => (scores.get(b) ?? 0) - (scores.get(a) ?? 0));
  } catch (err: any) {
    observation.logTelemetry("warn", "RewardEvents", `getModelPreferenceOrder(${JSON.stringify(candidates)}) failed: ${err.message}`);
    return candidates;
  }
}

export async function getCategoryScore(category: string): Promise<{ score: number; count: number } | null> {
  try {
    const db = getPool();
    const { rows } = await db.query(
      `SELECT AVG(reward_value)::float AS score, COUNT(*)::int AS count FROM reward_events WHERE category = $1`,
      [category]
    );
    if (!rows[0] || rows[0].count === 0) return null;
    return { score: rows[0].score, count: rows[0].count };
  } catch (err: any) {
    observation.logTelemetry("warn", "RewardEvents", `getCategoryScore(${category}) failed: ${err.message}`);
    return null;
  }
}

export async function getOverallScore(source?: RewardSource): Promise<{ score: number; count: number } | null> {
  try {
    const db = getPool();
    const { rows } = source
      ? await db.query(`SELECT AVG(reward_value)::float AS score, COUNT(*)::int AS count FROM reward_events WHERE source = $1`, [source])
      : await db.query(`SELECT AVG(reward_value)::float AS score, COUNT(*)::int AS count FROM reward_events`);
    if (!rows[0] || rows[0].count === 0) return null;
    return { score: rows[0].score, count: rows[0].count };
  } catch (err: any) {
    observation.logTelemetry("warn", "RewardEvents", `getOverallScore(${source ?? "<all>"}) failed: ${err.message}`);
    return null;
  }
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx tsc --noEmit && npm test 2>&1 | grep -E "RewardEvents|FAILED|TOTALS"`
Expected: all 4 new `RewardEvents` tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/kernel/state/reward-events-repo.ts tests/index.test.ts
git commit -m "feat: add reward-events-repo with write path and 3 read aggregations"
```

---

### Task 4: `groq-agent-client.ts` — `modelOrder` param + `modelUsed` in the result

**Files:**
- Modify: `src/runtime/groq-agent-client.ts`
- Test: `tests/index.test.ts` (extend existing `GroqAgentClient` tests)

**Interfaces:**
- Consumes: nothing new.
- Produces: `AgentChatResult` gains `modelUsed: string | null`; `callGroqAgentChat(groq, messages, tools, modelOrder?: string[])`.

- [ ] **Step 1: Write the failing test**

Add to `tests/index.test.ts`, immediately after the existing `parseGroqAgentResponse extracts totalTokens when usage is present` test:

```ts
registerTest("GroqAgentClient", "parseGroqAgentResponse extracts modelUsed from the response's own model field", () => {
  const result = parseGroqAgentResponse({
    choices: [{ message: { content: "hello", tool_calls: [] } }],
    model: "llama-3.3-70b-versatile",
  });
  if (result.modelUsed !== "llama-3.3-70b-versatile") {
    throw new Error(`GroqAgentClient: expected modelUsed "llama-3.3-70b-versatile", got: ${JSON.stringify(result)}`);
  }
});

registerTest("GroqAgentClient", "parseGroqAgentResponse's modelUsed is null when the response has no model field", () => {
  const result = parseGroqAgentResponse({ choices: [{ message: { content: "hello", tool_calls: [] } }] });
  if (result.modelUsed !== null) {
    throw new Error(`GroqAgentClient: expected modelUsed null with no model field, got: ${JSON.stringify(result)}`);
  }
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test 2>&1 | grep -E "modelUsed|FAILED"`
Expected: FAIL — `result.modelUsed` is `undefined`, both assertions fail.

- [ ] **Step 3: Implement**

In `src/runtime/groq-agent-client.ts`, widen the interface and `parseGroqAgentResponse`:

```ts
export interface AgentChatResult {
  content: string | null;
  toolCalls: AgentToolCall[] | null;
  totalTokens: number | null;
  // Which model in the fallback chain actually answered — read from the
  // Groq response's own `model` field. Lets a caller record which model
  // did the work without threading its own bookkeeping through every
  // call site. null only if the response itself omitted the field.
  modelUsed: string | null;
}
```

In `parseGroqAgentResponse`, add to the returned object:

```ts
    modelUsed: typeof data?.model === "string" ? data.model : null,
```

Then widen `callGroqAgentChat`'s signature and use the new param:

```ts
export async function callGroqAgentChat(
  groq: Groq,
  messages: AgentMessage[],
  tools: AgentTool[],
  modelOrder?: string[]
): Promise<AgentChatResult> {
  const models = modelOrder && modelOrder.length > 0 ? modelOrder : DEFAULT_MODELS;
  // ... existing body unchanged below this point, except:
  const response = await generateWithFallback(
    groq,
    { messages: messages as any, tools: groqTools as any, tool_choice: "auto" },
    models
  );
  return parseGroqAgentResponse(response);
}
```

(Replace the existing `const models = process.env.JARVIS_CODING_AGENT_MODEL ? [...] : DEFAULT_MODELS;` line and its call to `generateWithFallback` with the above — `modelOrder`, when supplied, takes priority over `DEFAULT_MODELS` but an explicit `JARVIS_CODING_AGENT_MODEL` env override should still win over both, since that's an explicit operator choice. Combine as: `const models = process.env.JARVIS_CODING_AGENT_MODEL ? [process.env.JARVIS_CODING_AGENT_MODEL] : (modelOrder && modelOrder.length > 0 ? modelOrder : DEFAULT_MODELS);`)

- [ ] **Step 4: Run to verify they pass**

Run: `npx tsc --noEmit && npm test 2>&1 | grep -E "GroqAgentClient|FAILED|TOTALS"`
Expected: all `GroqAgentClient` tests (old and new) PASS.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/groq-agent-client.ts tests/index.test.ts
git commit -m "feat: thread modelOrder through callGroqAgentChat, surface modelUsed"
```

---

### Task 5: `build-requests-repo.ts` — persist `coding_model_used`/`task_category`, add `getLatestPendingRewardGate`

**Files:**
- Modify: `src/kernel/state/build-requests-repo.ts`
- Test: `tests/index.test.ts`

**Interfaces:**
- Produces: `recordCodeDraft(id, codeSummary, files, modelUsed, category)` (widened — 2 new required params); `export async function getLatestPendingRewardGate(username: string): Promise<BuildRequestRow | null>`.

- [ ] **Step 1: Write the failing test**

Add to `tests/index.test.ts`, right after the existing `record-command-outcome`/build-request degrade tests (search for `"BuildRequests"` category tests to place it near its siblings):

```ts
registerTest("BuildRequests", "getLatestPendingRewardGate degrades cleanly when Postgres isn't reachable", async () => {
  const result = await buildRequestsRepo.getLatestPendingRewardGate("test_user");
  if (result !== null) {
    throw new Error(`BuildRequests: expected null with no DB, got: ${JSON.stringify(result)}`);
  }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test 2>&1 | grep -E "getLatestPendingRewardGate|FAILED"`
Expected: FAIL — `buildRequestsRepo.getLatestPendingRewardGate is not a function`.

- [ ] **Step 3: Implement**

In `src/kernel/state/build-requests-repo.ts`, widen `recordCodeDraft` with two new **optional, defaulted** parameters — not required ones. This is deliberate: the existing 3-arg call site in `autonomous_executive.ts` (`recordCodeDraft(confirmed.id, draft.summary, draft.files)`) isn't updated until Task 7, and this codebase's own global constraint (every task leaves `tsc`/`npm test` passing) means that call site can't be left broken for two whole tasks. Defaulting keeps it compiling unchanged in the meantime; Task 7 then passes the real values, which simply override the defaults.

```ts
export async function recordCodeDraft(
  id: number,
  codeSummary: string,
  files: DraftedFile[],
  modelUsed: string | null = null,
  category: string = "general"
): Promise<BuildRequestRow | null> {
  try {
    const db = getPool();
    const { rows } = await db.query(
      `UPDATE build_requests SET code_summary = $1, proposed_files = $2, status = 'awaiting_code_approval', coding_model_used = $3, task_category = $4, updated_at = now()
       WHERE id = $5 AND status = 'coding' RETURNING *`,
      [codeSummary, JSON.stringify(files), modelUsed, category, id]
    );
    return rows[0] || null;
  } catch (err: any) {
    observation.logTelemetry("warn", "BuildRequests", `recordCodeDraft(${id}) failed: ${err.message}`);
    return null;
  }
}
```

Add `coding_model_used: string | null;` and `task_category: string | null;` to the `BuildRequestRow` interface (alongside the existing `qa_summary`/`error_detail` fields).

Add the new lookup function, right after `getLatestAwaitingConsult`:

```ts
// A build request sitting in 'direction_confirmed' for more than an
// instant only happens via confirmDirection's reward gate pausing before
// startCoding — see the design spec's confirmation-gate section for why
// this reuses status timing instead of a new column, and the invariant
// (at most one awaiting/in-flight build request per user) it depends on.
export async function getLatestPendingRewardGate(username: string): Promise<BuildRequestRow | null> {
  try {
    const db = getPool();
    const { rows } = await db.query(
      `SELECT * FROM build_requests WHERE requested_by = $1 AND status = 'direction_confirmed' ORDER BY created_at DESC LIMIT 1`,
      [username]
    );
    return rows[0] || null;
  } catch (err: any) {
    observation.logTelemetry("warn", "BuildRequests", `getLatestPendingRewardGate("${username}") failed: ${err.message}`);
    return null;
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx tsc --noEmit && npm test 2>&1 | grep -E "getLatestPendingRewardGate|BuildRequests|FAILED|TOTALS"`
Expected: clean typecheck (the existing 3-arg `recordCodeDraft` call in `autonomous_executive.ts` still compiles — the two new params default) and the new `getLatestPendingRewardGate` test PASSes, with no regressions elsewhere.

- [ ] **Step 5: Commit**

```bash
git add src/kernel/state/build-requests-repo.ts tests/index.test.ts
git commit -m "feat: persist coding_model_used/task_category, add getLatestPendingRewardGate"
```

---

### Task 6: `coding-agent.ts` — category/model-order resolution, caution injection, reward recording

**Files:**
- Modify: `src/executive/coding-agent.ts`
- Test: `tests/index.test.ts` (existing `Departments`/coding-agent degrade tests must keep passing; no new live-network test is added here since this task's new code paths all require a real Groq/Postgres round trip — covered instead by Task 10's DB-integration test and this session's own live-verification step after merge)

**Interfaces:**
- Consumes: `classifyTaskCategory` (Task 2), `rewardEventsRepo.getModelPreferenceOrder`/`recordRewardEvent` (Task 3), `callGroqAgentChat(..., modelOrder?)` (Task 4).
- Produces: `CodingAgentResult`'s success variant gains `modelUsed: string | null` and `category: string`.

- [ ] **Step 1: Widen `CodingAgentResult` and add imports**

At the top of `src/executive/coding-agent.ts`, add:

```ts
import * as rewardEventsRepo from "../kernel/state/reward-events-repo.js";
import { classifyTaskCategory } from "./task-category.js";
```

Change the type declaration:

```ts
export type CodingAgentResult =
  | { ok: true; summary: string; files: DraftedFile[]; modelUsed: string | null; category: string }
  | { ok: false; error: string };
```

- [ ] **Step 2: Resolve category and model order at the top of `runCodingAgent`**

Immediately after the existing `if (!groq) { return {...} }` guard at the top of `runCodingAgent` (before `builderClient.createWorkspace`), add:

```ts
  const category = classifyTaskCategory(objective);
  const modelOrder = await rewardEventsRepo.getModelPreferenceOrder([
    "llama-3.3-70b-versatile",
    "llama-3.1-8b-instant",
  ]);
```

(These two candidate models mirror `groq-agent-client.ts`'s own `DEFAULT_MODELS` — if that list is ever changed there, update it here too; a follow-up could export `DEFAULT_MODELS` from `groq-agent-client.ts` instead of duplicating it, but that's a small later cleanup, not required for this task.)

- [ ] **Step 3: Thread `category`/caution + `modelOrder`/`modelUsed` through the per-task loop**

Just above the existing `for (const task of plan)` loop, add a session-scoped model tracker:

```ts
  let sessionModelUsed: string | null = null;
```

In the per-task system prompt construction (the `messages: AgentMessage[]` array literal inside the `for (const task of plan)` loop), add the caution sentence to the system message's `content` string. Change:

```ts
            `You have exactly one tool for doing work — run_shell_command — plus finish_task to end this task once it's ` +
            `fully implemented. Read files with cat, edit with heredocs or sed, run tests with the project's test command, ` +
            `check types, and use git to inspect your changes. Don't worry about committing — that happens automatically ` +
            `once your work passes review.`,
```

to:

```ts
            `You have exactly one tool for doing work — run_shell_command — plus finish_task to end this task once it's ` +
            `fully implemented. Read files with cat, edit with heredocs or sed, run tests with the project's test command, ` +
            `check types, and use git to inspect your changes. Don't worry about committing — that happens automatically ` +
            `once your work passes review.${categoryCaution}`,
```

...and compute `categoryCaution` once, right before the `for (const task of plan)` loop (a template-string constant, empty unless there's enough negative data):

```ts
  const categoryScore = await rewardEventsRepo.getCategoryScore(category);
  const categoryCaution =
    categoryScore && categoryScore.count >= 3 && categoryScore.score < -0.3
      ? ` Note: past sessions touching ${category} work have had a rough track record (${categoryScore.count} prior attempts) — be extra careful here.`
      : "";
```

Change the `callGroqAgentChat` call inside the per-task loop from `await callGroqAgentChat(groq, messages, [RUN_SHELL_TOOL, FINISH_TASK_TOOL]);` to `await callGroqAgentChat(groq, messages, [RUN_SHELL_TOOL, FINISH_TASK_TOOL], modelOrder);`. Immediately after that line (where `response.totalTokens` is already checked), add:

```ts
          if (response.modelUsed && !sessionModelUsed) {
            sessionModelUsed = response.modelUsed;
          }
```

Immediately after the existing `const verdict = await departments.reviewTaskDiff(task.title, task.description, taskFiles, groq);` line, add the reward recording (fire-and-forget, matching the repo's own internal try/catch — no `await`... actually **do** await it, since it's cheap and keeps ordering simple; it can never throw per Task 3's implementation):

```ts
      await rewardEventsRepo.recordRewardEvent(buildRequestId, "task_review", sessionModelUsed, category, verdict.approved ? 1 : -1);
```

- [ ] **Step 4: Return `modelUsed`/`category` from both `ok: true` return sites**

Change the return at the end of the per-task loop (currently `return { ok: true, summary, files };` around line 397) to:

```ts
    return { ok: true, summary, files, modelUsed: sessionModelUsed, category };
```

Change the fallback-to-flat-loop call (currently `return runFlatCodingLoop(buildRequestId, objective, researchSummary, directionNotes, baseSha, groq, planResult.tokensUsed);`) to pass `category` and `modelOrder` through:

```ts
    return runFlatCodingLoop(buildRequestId, objective, researchSummary, directionNotes, baseSha, groq, category, modelOrder, planResult.tokensUsed);
```

- [ ] **Step 5: Thread the same through `runFlatCodingLoop`**

Widen its signature (insert `category: string, modelOrder: string[]` before the existing defaulted `initialTokensUsed = 0` param):

```ts
async function runFlatCodingLoop(
  buildRequestId: number,
  objective: string,
  researchSummary: string,
  directionNotes: string,
  baseSha: string,
  groq: Groq,
  category: string,
  modelOrder: string[],
  initialTokensUsed = 0
): Promise<CodingAgentResult> {
```

Add the same category-caution computation (reuse the exact snippet from Step 3) right before its `messages` array is built, and append `${categoryCaution}` to its system prompt's closing sentence the same way. Add a local `let sessionModelUsed: string | null = null;` alongside its existing `let tokensUsed = ...`. Change its `callGroqAgentChat(groq, messages, [RUN_SHELL_TOOL, FINISH_CODING_TOOL]);` call to pass `modelOrder`, and capture `response.modelUsed` into `sessionModelUsed` the same way as Step 3. Update its own `return { ok: true, summary, files };` (around line 643) to `return { ok: true, summary, files, modelUsed: sessionModelUsed, category };`.

- [ ] **Step 6: Type-check and run the full suite**

Run: `npx tsc --noEmit`
Expected: clean. (`recordCodeDraft`'s two new params default in Task 5, so no call site anywhere breaks yet — if `tsc` reports any error, it means a missed `ok: true` return site or a missed `runFlatCodingLoop` call site in this file; fix it here before moving on.)

Run: `npm test 2>&1 | grep -E "FAILED|TOTALS"`
Expected: same pass count as before this task (this task adds no new tests of its own — its new code paths need a real Groq/Postgres round trip, verified live post-merge) — confirm no *regressions* in existing `Departments`/coding-agent-adjacent tests.

- [ ] **Step 7: Commit**

```bash
git add src/executive/coding-agent.ts
git commit -m "feat: resolve model preference/category, inject caution, record task_review rewards"
```

---

### Task 7: `autonomous_executive.ts` — extract `startCoding`, add the confirmation gate

**Files:**
- Modify: `src/executive/autonomous_executive.ts`
- Test: manual/live-verification only for this task (the gate's actual behavior needs a real reward-events history to trigger — covered by this session's post-merge live-verification step, same as prior features this session)

**Interfaces:**
- Consumes: `rewardEventsRepo.getOverallScore` (Task 3), `buildRequestsRepo.getLatestPendingRewardGate` (Task 5), the widened `recordCodeDraft` (Task 5), the widened `CodingAgentResult` (Task 6).

- [ ] **Step 1: Extract `startCoding`**

In `src/executive/autonomous_executive.ts`, find `confirmDirection`'s body from `await buildRequestsRepo.markCoding(confirmed.id);` through the end of the function (the block that calls `runCodingAgent`, then `recordCodeDraft`, then the obsidian note write and any trailing notification). Cut that whole block into a new private method:

```ts
  private async startCoding(confirmed: buildRequestsRepo.BuildRequestRow, directionNotes: string, username: string): Promise<{ ok: boolean; message: string }> {
    await buildRequestsRepo.markCoding(confirmed.id);

    let baseBranch = "main";
    const owner = process.env.SELF_REPO_OWNER;
    const repoName = process.env.SELF_REPO_NAME;
    if (owner && repoName) {
      try {
        const repoInfo = await github.getRepo(owner, repoName);
        baseBranch = repoInfo.default_branch;
      } catch {
        // Fall back to "main" — matches this codebase's degrade-cleanly convention.
      }
    }

    const draft = await codingAgent.runCodingAgent(
      confirmed.id,
      confirmed.objective,
      confirmed.research_summary || "",
      directionNotes,
      baseBranch,
      this.groq
    );

    if (!draft.ok) {
      await buildRequestsRepo.markCodeDraftError(confirmed.id, draft.error);
      scheduler.pushNotification(
        username,
        `I wasn't able to draft code for build request #${confirmed.id}, sir: ${draft.error}`,
        "warning"
      );
      return { ok: false, message: `Direction confirmed, but drafting the code failed: ${draft.error}` };
    }

    const recorded = await buildRequestsRepo.recordCodeDraft(confirmed.id, draft.summary, draft.files, draft.modelUsed, draft.category);
    if (!recorded) {
      await builderClient.destroyWorkspace(confirmed.id).catch(() => {});
      await buildRequestsRepo.markCodeDraftError(confirmed.id, "Failed to persist the drafted code.");
      return { ok: false, message: "Direction confirmed and code drafted, but I couldn't save it — please try again." };
    }
    obsidian.writeOrUpdateCodingNote(confirmed.id, confirmed.objective, {
      directionNotes,
      codeSummary: draft.summary,
      files: draft.files.map(f => f.path),
      status: recorded.status,
    }).catch((err: any) => {
      this.observation.logTelemetry("warn", "Interaction", `Failed to write coding vault note: ${err.message}`);
    });

    scheduler.pushNotification(
      username,
      `I've drafted the code for build request #${confirmed.id}, sir: ${draft.summary}. It's waiting for your approval in the dashboard before I open a pull request.`,
      "info"
    );

    return {
      ok: true,
      message: `Direction confirmed. I've drafted ${draft.files.length} file(s) — build request #${confirmed.id} is now waiting for your approval before I open a pull request.`,
    };
  }
```

This is the exact current tail of `confirmDirection` (lines 411-429 of `autonomous_executive.ts` as of this plan being written) — the whole block from `await buildRequestsRepo.markCoding(confirmed.id);` through this final `return` moves into `startCoding` verbatim; nothing in it changes except its new home.

- [ ] **Step 2: Rewrite `confirmDirection` to call the gate then `startCoding`**

```ts
  public async confirmDirection(username: string, directionNotes: string): Promise<{ ok: boolean; message: string }> {
    // A build request sitting in 'direction_confirmed' means a prior call
    // to this same function already paused here for the reward gate below
    // — this call is the user's explicit "go ahead anyway."
    const pendingRewardGate = await buildRequestsRepo.getLatestPendingRewardGate(username);
    if (pendingRewardGate) {
      return this.startCoding(pendingRewardGate, pendingRewardGate.direction_notes || directionNotes, username);
    }

    const buildRequest = await buildRequestsRepo.getLatestAwaitingConsult(username);
    if (!buildRequest) {
      return { ok: false, message: "There's no build request of mine currently awaiting your direction to confirm." };
    }

    const confirmed = await buildRequestsRepo.recordDirectionConfirmed(buildRequest.id, directionNotes);
    if (!confirmed) {
      return { ok: false, message: "Couldn't confirm direction — that build request may have already moved on." };
    }

    const rewardCheck = await rewardEventsRepo.getOverallScore("terminal_outcome");
    if (rewardCheck && rewardCheck.count >= 3 && rewardCheck.score < -0.5) {
      return {
        ok: true,
        message:
          `Before I start coding, sir — my recent track record here has been rough (average score ${rewardCheck.score.toFixed(2)} ` +
          `over the last ${rewardCheck.count} attempts). Want me to proceed anyway, or would you like to reconsider the plan first?`,
      };
    }

    return this.startCoding(confirmed, directionNotes, username);
  }
```

Add `import * as rewardEventsRepo from "../kernel/state/reward-events-repo.js";` to the top of the file if not already present.

- [ ] **Step 3: Type-check and run the full suite**

Run: `npx tsc --noEmit`
Expected: clean.

Run: `npm test 2>&1 | grep -E "FAILED|TOTALS"`
Expected: same total as before, no regressions (this refactor is behaviorally identical to today's flow when there's no reward data yet, which is exactly what every existing test exercises).

- [ ] **Step 4: Commit**

```bash
git add src/executive/autonomous_executive.ts
git commit -m "feat: extract startCoding, add reward-based confirmation gate to confirmDirection"
```

---

### Task 8: Terminal-outcome recording at approve-code/reject-code

**Files:**
- Modify: `src/interaction/routes/build-requests-routes.ts`
- Test: manual/live-verification (this path needs a real GitHub PR + QA round trip; covered by db-integration + post-merge live verification, same as Task 6/7)

**Interfaces:**
- Consumes: `rewardEventsRepo.recordRewardEvent` (Task 3).

- [ ] **Step 1: Record on the QA-complete path**

In the `approve-code` route, immediately after the existing `await buildRequestsRepo.recordQaReview(updated.id, qaSummary);` line, add:

```ts
        await rewardEventsRepo.recordRewardEvent(updated.id, "terminal_outcome", updated.coding_model_used, updated.task_category || "general", 2);
```

- [ ] **Step 2: Record on the rejected-at-code path**

In the `reject-code` route, immediately after `const updated = await buildRequestsRepo.rejectCode(id);` and its existing `if (!updated) return ...` guard, add (before `await builderClient.destroyWorkspace(...)`):

```ts
    await rewardEventsRepo.recordRewardEvent(updated.id, "terminal_outcome", updated.coding_model_used, updated.task_category || "general", -2);
```

- [ ] **Step 3: Add the import**

Add `import * as rewardEventsRepo from "../../kernel/state/reward-events-repo.js";` to the top of `src/interaction/routes/build-requests-routes.ts`.

- [ ] **Step 4: Type-check and run the full suite**

Run: `npx tsc --noEmit && npm test 2>&1 | grep -E "FAILED|TOTALS"`
Expected: clean, same total as before (no new unit-testable behavior here — this is wiring covered by live verification).

- [ ] **Step 5: Commit**

```bash
git add src/interaction/routes/build-requests-routes.ts
git commit -m "feat: record terminal_outcome reward events on approve-code/reject-code"
```

---

### Task 9: Dashboard route + panel

**Files:**
- Create: `src/interaction/routes/reward-routes.ts`
- Modify: `src/kernel/security.ts`
- Modify: `src/server.ts`
- Modify: `src/interaction/static/index.html`
- Test: `tests/index.test.ts` (permission-gating test, matching the established pattern for every other route this session added)

**Interfaces:**
- Produces: `GET /api/reward/summary` → `{ overall: {score,count}|null, byModel: Record<string,{score,count}>, byCategory: Record<string,{score,count}> }`.

- [ ] **Step 1: Add the capability**

In `src/kernel/security.ts`, add `"reward.read",` to `ALL_CAPABILITIES` (after `"system.sandbox_execute",`), with a one-line comment: `// Read-only: the reward ledger's own summary (dashboard), no write action.`

- [ ] **Step 2: Add `getModelScore` to `reward-events-repo.ts`**

`getCategoryScore` (Task 3) only queries the `category` column, not `model_used` — the per-model dashboard breakdown needs its own read function. Add to `src/kernel/state/reward-events-repo.ts`, right after `getCategoryScore`:

```ts
export async function getModelScore(model: string): Promise<{ score: number; count: number } | null> {
  try {
    const db = getPool();
    const { rows } = await db.query(
      `SELECT AVG(reward_value)::float AS score, COUNT(*)::int AS count FROM reward_events WHERE model_used = $1`,
      [model]
    );
    if (!rows[0] || rows[0].count === 0) return null;
    return { score: rows[0].score, count: rows[0].count };
  } catch (err: any) {
    observation.logTelemetry("warn", "RewardEvents", `getModelScore(${model}) failed: ${err.message}`);
    return null;
  }
}
```

- [ ] **Step 3: Write the route**

```ts
// src/interaction/routes/reward-routes.ts
import { Router } from "express";
import { validateApiKey } from "../../kernel/auth-middleware.js";
import { requireCapability } from "../../kernel/security.js";
import * as rewardEventsRepo from "../../kernel/state/reward-events-repo.js";

export const rewardRouter = Router();

const KNOWN_MODELS = ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"];
const KNOWN_CATEGORIES = ["database", "frontend", "security", "general"];

// Read-only introspection into the coding agent's reward ledger — see
// docs/superpowers/specs/2026-07-27-reward-punishment-coding-agent-design.md.
// Numbers only, no history list — matches the "just report it honestly"
// scope this dashboard panel was built for, not a full analytics view.
rewardRouter.get("/api/reward/summary", validateApiKey, requireCapability("reward.read"), async (req, res) => {
  try {
    const overall = await rewardEventsRepo.getOverallScore();
    const byModel: Record<string, { score: number; count: number } | null> = {};
    for (const model of KNOWN_MODELS) {
      byModel[model] = await rewardEventsRepo.getModelScore(model);
    }
    const byCategory: Record<string, { score: number; count: number } | null> = {};
    for (const category of KNOWN_CATEGORIES) {
      byCategory[category] = await rewardEventsRepo.getCategoryScore(category);
    }
    res.json({ overall, byModel, byCategory });
  } catch (err: any) {
    res.json({ overall: null, byModel: {}, byCategory: {}, error: err.message });
  }
});
```

- [ ] **Step 4: Mount the router**

In `src/server.ts`, add `import { rewardRouter } from "./interaction/routes/reward-routes.js";` alongside the other route imports, and `app.use(rewardRouter);` alongside the other `app.use(...)` mounts (e.g. right after `app.use(evolutionRouter);`), with a one-line comment matching the existing style: `// Reward-ledger summary endpoint — see src/interaction/routes/reward-routes.ts.`

This route has no dedicated unit test of its own — exercising it for real needs a live server and a live Postgres, and its only real logic (the three read aggregations it calls) is already covered by Task 3's degrade-cleanly tests and Task 10's DB-integration test. It's verified the same way every other read-only dashboard route this session added was verified: manually, post-deploy, in Task 11's live-verification step.

- [ ] **Step 5: Add the dashboard panel**

In `src/interaction/static/index.html`, add a new `holo-panel` section in the Operations tab, immediately after the existing "Self-improvement" panel (same visual pattern — see that panel's markup for the exact class names to copy):

```html
<div class="holo-panel rounded-2xl p-5 w-full">
    <div class="flex justify-between items-start mb-4">
        <div>
            <h3 class="font-display font-semibold text-sm text-white">Reward & learning</h3>
            <p class="text-[11px] text-secondary mt-1 max-w-lg">How the coding agent's own past outcomes are shaping which model it tries first and how carefully it proceeds — not a claim about the underlying LLM being retrained, just a record of real results.</p>
        </div>
        <span id="reward-overall-badge" class="px-2 py-0.5 rounded-full bg-white/5 border border-white/10 text-[11px] text-secondary whitespace-nowrap">No data yet</span>
    </div>
    <div class="grid grid-cols-2 gap-4">
        <div>
            <span class="text-[11px] text-secondary uppercase tracking-wider block mb-2">By model</span>
            <div id="reward-by-model-list" class="space-y-1"><div class="text-secondary text-center w-full py-2 text-xs opacity-60">No data yet.</div></div>
        </div>
        <div>
            <span class="text-[11px] text-secondary uppercase tracking-wider block mb-2">By category</span>
            <div id="reward-by-category-list" class="space-y-1"><div class="text-secondary text-center w-full py-2 text-xs opacity-60">No data yet.</div></div>
        </div>
    </div>
</div>
```

Add the loader function, right after `loadEvolutionStatus` (same file/section as the other Operations-tab loaders):

```js
async function loadRewardSummary() {
    if (!CURRENT_API_KEY) return;
    try {
        const res = await authFetch('/api/reward/summary', { headers: { 'X-API-Key': CURRENT_API_KEY } });
        if (!res.ok) return;
        const data = await res.json();
        document.getElementById('reward-overall-badge').textContent = data.overall
            ? `Score ${data.overall.score.toFixed(2)} (${data.overall.count})`
            : 'No data yet';
        const renderRows = (obj) => Object.entries(obj)
            .filter(([, v]) => v)
            .map(([k, v]) => `<div class="flex justify-between text-[11px]"><span class="text-secondary">${escapeHtml(k)}</span><span class="text-white font-mono">${v.score.toFixed(2)} (${v.count})</span></div>`)
            .join('') || `<div class="text-secondary text-center w-full py-2 text-xs opacity-60">No data yet.</div>`;
        document.getElementById('reward-by-model-list').innerHTML = renderRows(data.byModel || {});
        document.getElementById('reward-by-category-list').innerHTML = renderRows(data.byCategory || {});
    } catch {}
}
```

Wire it into the init block, alongside the other Operations-tab loaders:

```js
        loadRewardSummary();
        // ...
        setInterval(loadRewardSummary, 60000);
```

- [ ] **Step 6: Type-check, syntax-check the HTML, run the full suite**

Run:
```bash
npx tsc --noEmit
node -e '
const fs = require("fs");
const html = fs.readFileSync("src/interaction/static/index.html", "utf8");
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
let ok = true;
scripts.forEach((s, i) => { try { new Function(s); } catch (e) { ok = false; console.log(`Block ${i} ERROR:`, e.message); } });
console.log(ok ? "ALL OK" : "FAILED");
'
npm test 2>&1 | grep -E "FAILED|TOTALS"
```
Expected: tsc clean, `ALL OK`, same test total as before.

- [ ] **Step 7: Commit**

```bash
git add src/interaction/routes/reward-routes.ts src/kernel/state/reward-events-repo.ts src/kernel/security.ts src/server.ts src/interaction/static/index.html
git commit -m "feat: add reward.read capability, GET /api/reward/summary, and a dashboard panel"
```

---

### Task 10: DB-integration test for real aggregation/reordering math

**Files:**
- Modify: `tests/db-integration.test.ts`

**Interfaces:**
- Consumes: `rewardEventsRepo.recordRewardEvent`/`getModelPreferenceOrder`/`getCategoryScore`/`getOverallScore` (Task 3, 9).

- [ ] **Step 1: Write the test**

Add `import * as rewardEventsRepo from "../src/kernel/state/reward-events-repo.js";` to the top imports, and add a cleanup line to `cleanupTestData()` matching the existing pattern:

```ts
  await db.query(`DELETE FROM reward_events WHERE build_request_id = $1`, [999999901]).catch(() => {});
```

Add the test itself, after the existing `mcp-servers-repo` test:

```ts
registerTest("reward-events-repo: real aggregation and model reordering work against real rows", async () => {
  const buildRequestId = 999999901;
  // A minimal real build_requests row to satisfy reward_events' FK.
  const db = getPool();
  await db.query(
    `INSERT INTO build_requests (id, objective, requested_by, status) VALUES ($1, 'test objective', 'admin', 'qa_complete')
     ON CONFLICT (id) DO NOTHING`,
    [buildRequestId]
  );

  await rewardEventsRepo.recordRewardEvent(buildRequestId, "task_review", "model-a", "database", 1);
  await rewardEventsRepo.recordRewardEvent(buildRequestId, "task_review", "model-a", "database", -1);
  await rewardEventsRepo.recordRewardEvent(buildRequestId, "terminal_outcome", "model-b", "frontend", 2);
  await rewardEventsRepo.recordRewardEvent(buildRequestId, "terminal_outcome", "model-b", "frontend", 2);

  const modelOrder = await rewardEventsRepo.getModelPreferenceOrder(["model-a", "model-b"]);
  if (modelOrder[0] !== "model-b") {
    throw new Error(`reward-events-repo: expected model-b (avg +2) ordered before model-a (avg 0), got: ${JSON.stringify(modelOrder)}`);
  }

  const dbCategory = await rewardEventsRepo.getCategoryScore("database");
  if (!dbCategory || dbCategory.count !== 2 || dbCategory.score !== 0) {
    throw new Error(`reward-events-repo: expected database category {score: 0, count: 2}, got: ${JSON.stringify(dbCategory)}`);
  }

  const frontendCategory = await rewardEventsRepo.getCategoryScore("frontend");
  if (!frontendCategory || frontendCategory.count !== 2 || frontendCategory.score !== 2) {
    throw new Error(`reward-events-repo: expected frontend category {score: 2, count: 2}, got: ${JSON.stringify(frontendCategory)}`);
  }

  const overallTerminal = await rewardEventsRepo.getOverallScore("terminal_outcome");
  if (!overallTerminal || overallTerminal.count < 2) {
    throw new Error(`reward-events-repo: expected at least 2 terminal_outcome events, got: ${JSON.stringify(overallTerminal)}`);
  }
});
```

Also add `await db.query(\`DELETE FROM build_requests WHERE id = $1\`, [999999901]).catch(() => {});` to `cleanupTestData()`, after the `reward_events` cleanup line (FK ordering — delete the child rows first, though `ON DELETE CASCADE` on `reward_events.build_request_id` means deleting the build_requests row alone would suffice; keep both for clarity/defense-in-depth matching this file's existing style of independent best-effort deletes).

- [ ] **Step 2: Run against a real disposable Postgres**

```bash
docker run -d --name reward-test-pg -e POSTGRES_PASSWORD=testpass -e POSTGRES_DB=jarvis_test -p 55441:5432 postgres:16
sleep 4
POSTGRES_HOST=localhost POSTGRES_PORT=55441 POSTGRES_USER=postgres POSTGRES_PASSWORD=testpass POSTGRES_DB=jarvis_test DB_INTEGRATION_TEST_CONFIRM=i-accept-data-loss-in-this-database npx tsx tests/db-integration.test.ts
docker rm -f reward-test-pg
```

Expected: the new test PASSes alongside all existing db-integration tests (should now be 8/8 total: the existing 6 plus this one — note the plan's own count may drift from whatever the codebase's actual current total is by the time this runs; the requirement is "all pass, zero failures," not a specific number).

- [ ] **Step 3: Commit**

```bash
git add tests/db-integration.test.ts
git commit -m "test: add real-Postgres aggregation/reordering coverage for reward-events-repo"
```

---

### Task 11: Full verification and ship

**Files:** none (verification + the standard end-of-feature workflow this session already uses)

- [ ] **Step 1: Full local verification**

```bash
npx tsc --noEmit
npm test 2>&1 | tail -10
```
Expected: clean typecheck, all tests passing (baseline was 162 before this feature — expect roughly 162 + 5 (TaskCategory) + 4 (RewardEvents) + 2 (GroqAgentClient modelUsed) + 1 (getLatestPendingRewardGate) ≈ 174, but treat the exact number as informational, not a hard gate — the hard gate is zero failures).

- [ ] **Step 2: Push, open a draft PR, wait for CI + CodeRabbit**

Follow this session's own established workflow exactly: push the branch, `gh pr create`, poll `gh pr checks`/`gh pr view --json reviews` until both resolve, fix any real CodeRabbit findings (verify each against current code before applying, same discipline used all session), re-verify, then `gh pr merge --squash --delete-branch` (expect and handle the known `'main' is already used by worktree` error on the branch-delete step exactly as done throughout this session).

- [ ] **Step 3: Deploy and live-verify**

`git -C /mnt/jarvis_home/llm pull --ff-only origin main`, then `docker compose up -d --force-recreate api` (this feature touches no `jarvis-builder` code, so that service doesn't need rebuilding). Confirm migration `006_reward_events` applies cleanly in the live logs, confirm `reward.read` gets auto-granted to admin in the startup log (matching the pattern every prior new capability this session showed), then trigger a real build request end-to-end (objective → confirm direction → code → approve) via `docker exec jarvis-os-api node -e '...'` calls against the live API, and confirm real rows land in `reward_events` and `GET /api/reward/summary` reflects them.
