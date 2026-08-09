# Per-User Rapport & Tone Modeling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-user, LLM-grounded rapport signal that observes real communication patterns across conversations and adjusts Jarvis's tone within (never against) the user's own personality-dial settings — mirroring `src/self/identity.ts`'s existing self-reflection pattern exactly, applied to the user's side of the conversation instead of Jarvis's own.

**Architecture:** A new repo (`rapport-repo.ts`, Postgres-backed, degrade-cleanly) stores short LLM-extracted tone descriptors per user, one per real chat turn. A new module (`rapport.ts`) has a write side (`extractRapportSignal`, fire-and-forget, same trigger point as `reflectAndLearn`/`identity.extractSelfReflection`) and a read side (`buildRapportContext`, synthesizes recent signals into a prompt fragment, same trigger point as `buildIdentityContext`/`buildPersonalityPromptFragment`). A new tool (`get_rapport_summary`) exposes the same synthesis conversationally.

**Tech Stack:** TypeScript, Postgres (existing migration/repo pattern), the raw `Groq` SDK client with structured output (`toGroqSchema`/`response_format`), mirroring `identity.ts`'s exact existing call shape on this branch.

## Global Constraints

- Every new file follows the exact conventions already established in this codebase's repos (repo-level try/catch, degrade-cleanly — see any existing repo in `src/kernel/state/`) and in `src/self/identity.ts` (write-side fire-and-forget extraction, read-side synthesis returning `""` on empty/error, never fabricated).
- Rapport extraction must never fabricate a signal — if the LLM call fails, or returns nothing genuine, nothing is recorded, exactly matching `extractSelfReflection`'s existing "empty category/content means nothing did, and nothing is stored" convention.
- `buildRapportContext`'s synthesized guidance adjusts tone *within* the user's personality-dial settings, never against them — this is a prompt-construction-level rule (natural-language guidance, not a runtime-enforced constraint), stated explicitly in the function's own doc comment so it doesn't drift in a future edit.
- Use Groq model `"openai/gpt-oss-20b"` for the extraction call — matches `extractSelfReflection`'s exact existing model choice for the same kind of single-turn structured extraction on this branch.
- `get_rapport_summary` has no capability gate — add it to `UNGATED_TOOLS` (`src/capabilities/tools.ts`) alongside the existing `display_content`/`list_constraints` entries, matching `reflect_on_self`'s precedent that a user can always ask about their own conversational history with Jarvis.

---

## Task 1: `rapport-repo.ts` — storage

**Files:**
- Create: `src/kernel/state/migrations/008_rapport_signals.ts`
- Create: `src/kernel/state/rapport-repo.ts`
- Test: `tests/index.test.ts`

**Interfaces:**
- Consumes: `getPool` (`./db.js`), `ObservationPlatform` (existing).
- Produces:
  - `export interface RapportSignal { id: number; username: string; toneDescriptor: string; formalityObserved: number | null; createdAt: Date; }`
  - `export async function recordRapportSignal(username: string, toneDescriptor: string, formalityObserved: number | null): Promise<void>` — fire-and-forget from every caller's perspective, never throws.
  - `export async function getRecentRapportSignals(username: string, limit = 8): Promise<RapportSignal[]>` — returns `[]` (not an error) when Postgres is unreachable.

- [ ] **Step 1: Read `007_personality_settings.ts` and one existing repo in full first**

Match this codebase's real, current migration-authoring convention and repo degrade-cleanly pattern exactly — read `src/kernel/state/migrations/007_personality_settings.ts` and an existing simple repo (e.g. `src/kernel/state/identity-repo.ts` or any other in that directory) before writing anything, don't assume the shape below is exactly right without confirming against the real files.

- [ ] **Step 2: Write the migration**

```typescript
// src/kernel/state/migrations/008_rapport_signals.ts
import type { Migration } from "./runner.js";

// Backs per-user rapport/tone modeling (see
// docs/superpowers/specs/2026-08-08-rapport-tone-modeling-design.md) — one
// row per real chat turn, a short LLM-extracted tone descriptor of the
// USER's message (not Jarvis's reply). Read back by rapport.ts to
// synthesize a short "how this user has been coming across lately"
// fragment into the system prompt, adjusting tone within (never against)
// the user's own personality-dial settings.
const migration: Migration = {
  id: "008_rapport_signals",
  description:
    "Create rapport_signals (one row per per-user LLM-extracted tone observation) so Jarvis can adapt tone to each user's real recent communication pattern.",
  up: async (client) => {
    await client.query(`
      CREATE TABLE rapport_signals (
        id SERIAL PRIMARY KEY,
        username TEXT NOT NULL,
        tone_descriptor TEXT NOT NULL,
        formality_observed INTEGER,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await client.query(`CREATE INDEX rapport_signals_username_created_idx ON rapport_signals(username, created_at DESC);`);
  },
};

export default migration;
```

Register it in `src/kernel/state/migrations/index.ts` following the exact same append-only pattern `007_personality_settings` used (read that file's current registration line first, match it exactly).

- [ ] **Step 3: Write the failing tests**

Match `tests/index.test.ts`'s real `registerTest(category, name, fn)` convention (grep for an existing recent repo-test category as your direct template, e.g. the personality-settings tests added earlier on this branch).

```typescript
// category: "RapportSignals"
registerTest("RapportSignals", "recordRapportSignal degrades cleanly when Postgres isn't reachable", async () => {
  const { recordRapportSignal } = await import("../src/kernel/state/rapport-repo.js");
  await recordRapportSignal("test_user", "terse, businesslike", 80); // must not throw
});

registerTest("RapportSignals", "getRecentRapportSignals degrades cleanly when Postgres isn't reachable", async () => {
  const { getRecentRapportSignals } = await import("../src/kernel/state/rapport-repo.js");
  const result = await getRecentRapportSignals("test_user");
  if (!Array.isArray(result) || result.length !== 0) {
    throw new Error(`expected an empty array when Postgres is unreachable, got ${JSON.stringify(result)}`);
  }
});
```

- [ ] **Step 4: Run tests to verify they fail, then implement**

```typescript
// src/kernel/state/rapport-repo.ts
import { getPool } from "./db.js";
import { ObservationPlatform } from "../observation.js";

const observation = ObservationPlatform.getInstance();

export interface RapportSignal {
  id: number;
  username: string;
  toneDescriptor: string;
  formalityObserved: number | null;
  createdAt: Date;
}

// One write path, fire-and-forget from every caller's perspective — a
// failure to record a rapport signal must never block or fail the chat
// reply that generated it.
export async function recordRapportSignal(username: string, toneDescriptor: string, formalityObserved: number | null): Promise<void> {
  try {
    const db = getPool();
    await db.query(
      `INSERT INTO rapport_signals (username, tone_descriptor, formality_observed) VALUES ($1, $2, $3)`,
      [username, toneDescriptor, formalityObserved]
    );
  } catch (err: any) {
    observation.logTelemetry("warn", "RapportSignals", `recordRapportSignal(${username}) failed: ${err.message}`);
  }
}

// Most recent signals for this user, newest first. Returns [] (not an
// error) when Postgres is unreachable — the caller (buildRapportContext)
// treats an empty result identically to "no signal history yet," not a
// failure state.
export async function getRecentRapportSignals(username: string, limit = 8): Promise<RapportSignal[]> {
  try {
    const db = getPool();
    const { rows } = await db.query(
      `SELECT id, username, tone_descriptor AS "toneDescriptor", formality_observed AS "formalityObserved", created_at AS "createdAt"
       FROM rapport_signals WHERE username = $1 ORDER BY created_at DESC LIMIT $2`,
      [username, limit]
    );
    return rows;
  } catch (err: any) {
    observation.logTelemetry("warn", "RapportSignals", `getRecentRapportSignals(${username}) failed: ${err.message}`);
    return [];
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Export `POSTGRES_HOST=localhost POSTGRES_USER=jarvis_user POSTGRES_DB=jarvis INTERNAL_API_KEY=<real value from .env> OAUTH_TOKEN_ENCRYPTION_KEY=<real value from .env>` first. Run `npx tsc --noEmit && npm test`.

- [ ] **Step 6: Commit**

```bash
git add src/kernel/state/migrations/008_rapport_signals.ts src/kernel/state/migrations/index.ts src/kernel/state/rapport-repo.ts tests/index.test.ts
git commit -m "feat: add per-user rapport signal storage"
```

---

## Task 2: `src/self/rapport.ts` — extraction and synthesis

**Files:**
- Create: `src/self/rapport.ts`
- Test: `tests/index.test.ts`

**Interfaces:**
- Consumes: `recordRapportSignal`/`getRecentRapportSignals` (Task 1), `Groq` (`groq-sdk`), `toGroqSchema` (`src/runtime/groq-client.js`), `Type` (`@google/genai`), `ObservationPlatform`.
- Produces:
  - `export async function extractRapportSignal(username: string, groq: Groq | null, userMessage: string): Promise<void>` — write side, fire-and-forget.
  - `export async function buildRapportContext(username: string, limit = 8): Promise<string>` — read side, returns `""` when there's no signal history yet or on any error.

- [ ] **Step 1: Read `src/self/identity.ts` in full first**

`extractSelfReflection` and `buildIdentityContext` are the exact patterns this task mirrors — read them completely before writing anything, so the schema shape, model choice, and error handling match precisely rather than being reinvented.

- [ ] **Step 2: Write the failing tests**

```typescript
// category: "Rapport"
registerTest("Rapport", "extractRapportSignal records a real signal on a successful extraction", async () => {
  const { extractRapportSignal } = await import("../src/self/rapport.js");

  const fakeGroq = {
    chat: {
      completions: {
        create: async () => ({
          choices: [{ message: { content: JSON.stringify({ toneDescriptor: "terse, focused, all-business", formalityObserved: 75 }) } }],
        }),
      },
    },
  } as any;

  await extractRapportSignal("rapport_test_user", fakeGroq, "just fix the bug, no need to explain");
  // With no live Postgres in this test process, the DB write degrades to a
  // no-op — this test's real assertion is that extractRapportSignal does
  // not throw when given a fake client and a well-formed response. See
  // Task 1's own degrade-cleanly tests for the DB-layer behavior.
});

registerTest("Rapport", "extractRapportSignal is a silent no-op when the Groq call fails", async () => {
  const { extractRapportSignal } = await import("../src/self/rapport.js");
  const throwingGroq = {
    chat: { completions: { create: async () => { throw new Error("simulated Groq failure"); } } },
  } as any;
  await extractRapportSignal("rapport_test_user", throwingGroq, "hello"); // must not throw
});

registerTest("Rapport", "extractRapportSignal is a silent no-op when groq is null", async () => {
  const { extractRapportSignal } = await import("../src/self/rapport.js");
  await extractRapportSignal("rapport_test_user", null, "hello"); // must not throw
});

registerTest("Rapport", "buildRapportContext returns an empty string when there is no signal history", async () => {
  const { buildRapportContext } = await import("../src/self/rapport.js");
  const result = await buildRapportContext("a_user_with_definitely_no_history_" + Date.now());
  if (result !== "") throw new Error(`expected empty string with no history, got: "${result}"`);
});
```

- [ ] **Step 3: Implement**

```typescript
// src/self/rapport.ts
import { Type } from "@google/genai";
import Groq from "groq-sdk";
import { toGroqSchema } from "../runtime/groq-client.js";
import { ObservationPlatform } from "../kernel/observation.js";
import * as rapportRepo from "../kernel/state/rapport-repo.js";

const observation = ObservationPlatform.getInstance();

const RAPPORT_SIGNAL_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    toneDescriptor: { type: Type.STRING, description: "A short, honest description (5-12 words) of the tone/mood of the USER's message below — e.g. \"terse, focused, all-business\" or \"playful, exploratory, casual\". Base this only on what's actually in the message; do not invent emotional content that isn't there." },
    formalityObserved: { type: Type.INTEGER, description: "0-100 estimate of how formal the user's message reads, 0 = very casual/informal, 100 = very formal/professional" },
  },
  required: ["toneDescriptor", "formalityObserved"],
};

/**
 * Write side — fire-and-forget, same trigger point and pattern as
 * identity.ts's extractSelfReflection, applied to the USER's message
 * instead of Jarvis's own reply. A real Groq call reads what the user
 * actually wrote; nothing is stored if the call fails or returns nothing
 * usable — never a fabricated/guessed signal.
 */
export async function extractRapportSignal(username: string, groq: Groq | null, userMessage: string): Promise<void> {
  if (!groq) return;
  try {
    const response = await groq.chat.completions.create({
      model: "openai/gpt-oss-20b",
      messages: [{
        role: "user",
        content:
          "Analyze the tone of the following USER message (not any assistant reply) and describe it honestly and " +
          "briefly. This is a real, ordinary message from a person talking to their AI assistant — most messages are " +
          "simply neutral and task-focused, and that's a completely valid, common answer; only describe something " +
          "more specific (frustrated, excited, playful, terse) if it's genuinely present in the wording.\n\n" +
          `User message: ${userMessage.slice(0, 1000)}`,
      }],
      response_format: {
        type: "json_schema",
        json_schema: { name: "rapport_signal", schema: toGroqSchema(RAPPORT_SIGNAL_SCHEMA), strict: true },
      },
    });

    const parsed = JSON.parse(response.choices[0]?.message?.content || "{}");
    const toneDescriptor = typeof parsed.toneDescriptor === "string" ? parsed.toneDescriptor.trim() : "";
    const formalityObserved = typeof parsed.formalityObserved === "number" ? Math.max(0, Math.min(100, Math.round(parsed.formalityObserved))) : null;

    if (toneDescriptor) {
      await rapportRepo.recordRapportSignal(username, toneDescriptor, formalityObserved);
      observation.logTelemetry("info", "Rapport", `Recorded rapport signal for "${username}": "${toneDescriptor}"`);
    }
  } catch (err: any) {
    observation.logTelemetry("warn", "Rapport", `Rapport signal extraction failed: ${err.message || err}`);
  }
}

/**
 * Read side — pulled into the chat system instruction alongside the
 * personality dials. Synthesizes real recent tone observations into a
 * short natural-language fragment. Explicitly adjusts WITHIN the user's
 * own dial settings, never against them — this is a framing instruction
 * baked into the returned text itself, not a runtime-enforced rule, so
 * keep this framing intact if this function is ever edited.
 */
export async function buildRapportContext(username: string, limit = 8): Promise<string> {
  const recent = await rapportRepo.getRecentRapportSignals(username, limit);
  if (recent.length === 0) return "";
  const descriptors = recent.map(s => s.toneDescriptor).join("; ");
  return `\n\nHow this user has been coming across in your recent conversations: ${descriptors}. Let this inform your tone naturally, within your existing formality/humor/verbosity settings — this is context for calibration, not an instruction to change register entirely.`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Export the standard env vars. Run `npx tsc --noEmit && npm test`.

- [ ] **Step 5: Commit**

```bash
git add src/self/rapport.ts tests/index.test.ts
git commit -m "feat: add rapport signal extraction and prompt synthesis"
```

---

## Task 3: Wire into `src/server.ts`

**Files:**
- Modify: `src/server.ts`

**Interfaces:**
- Consumes: `extractRapportSignal`, `buildRapportContext` (Task 2).

- [ ] **Step 1: Read the exact current post-turn firing point and prompt-assembly point**

Read `src/server.ts` around lines 986/992 (`reflectAndLearn(groq, message, fullReply)`/`identity.extractSelfReflection(req.username, groq, message, fullReply)`) — re-verify exact current lines, this is where the new `extractRapportSignal` call gets added, same pattern, same fire-and-forget `.catch(() => {})`. Separately, read around line 486-516 where `personalityContext` is assembled via `identity.buildPersonalityPromptFragment(...)` and spliced into `baseSystemInstruction` — this is where `buildRapportContext`'s output gets appended.

- [ ] **Step 2: Add the post-turn extraction call**

Immediately alongside the existing `reflectAndLearn(...)`/`identity.extractSelfReflection(...)` fire-and-forget calls, add:

```typescript
rapport.extractRapportSignal(req.username, groq, message).catch(() => {});
```

with the corresponding import (`import * as rapport from "./self/rapport.js";` near the other local imports).

- [ ] **Step 3: Add the prompt-assembly read**

At the point `personalityContext` is computed (line ~486) and spliced into `baseSystemInstruction` (line ~516), add a parallel `rapportContext`:

```typescript
const rapportContext = await rapport.buildRapportContext(req.username);
```

and include it in the existing concatenation: `... + memoryContext + styleContext + identityContext + personalityContext + rapportContext + buildRequestContext;` — rapport goes right after the personality dials, before the build-request context, since it's the most ephemeral/recency-weighted signal among the identity/personality group.

- [ ] **Step 4: Typecheck, run tests**

Export the standard env vars. Run `npx tsc --noEmit && npm test`.

- [ ] **Step 5: Manual verification if a real dev server + real GROQ_API_KEY are available**

Send two real chat messages with clearly different tones (e.g. one terse "just do X", one exploratory "hey, curious what you think about..."), then check `rapport_signals` in Postgres (or the server's telemetry log) to confirm real, distinct signals were recorded. If no real key is available in this sandbox, document that plainly and rely on the automated tests.

- [ ] **Step 6: Commit**

```bash
git add src/server.ts
git commit -m "feat: wire rapport signal extraction and synthesis into /api/chat"
```

---

## Task 4: `get_rapport_summary` tool

**Files:**
- Modify: `src/capabilities/tools.ts`
- Test: `tests/index.test.ts`

**Interfaces:**
- Consumes: `buildRapportContext` (Task 2).
- Produces: a new tool `get_rapport_summary`, no parameters, no capability gate (add to `UNGATED_TOOLS` alongside `display_content`/`list_constraints`), returning `{ summary: string }` where an empty string means "no rapport history yet," which the tool description should frame honestly rather than implying a fabricated first impression.

- [ ] **Step 1: Read the `list_constraints` tool's exact shape as your template**

It's the most recent precedent for a zero-parameter, ungated, read-only tool in this same file (`src/capabilities/tools.ts:449, 483-488, 704, 750`) — match its exact structure (definition, `UNGATED_TOOLS` entry, dispatch case, trigger-hints entry at line ~750 if this file uses that map for every tool).

- [ ] **Step 2: Write the failing test**

```typescript
// category: matches wherever list_constraints's own test lives in this file — check that convention
registerTest("Tools", "get_rapport_summary is ungated and returns a real summary shape", async () => {
  // Match this file's existing tool-dispatch test convention (grep for how
  // list_constraints's dispatch is tested) — invoke the tool's handler
  // directly and assert it returns { summary: string } without requiring
  // any capability grant.
});
```

- [ ] **Step 3: Implement**

Add the tool definition:

```typescript
{
  name: "get_rapport_summary",
  description: "Get an honest summary of how this user has been coming across in recent conversations — their real, observed communication tone and formality, not a fabricated first impression. Use this when the user asks how they've seemed lately, whether Jarvis has noticed anything about their mood, or similar self-reflective questions about the relationship.",
  parameters: {
    type: Type.OBJECT,
    properties: {},
  },
},
```

Add `"get_rapport_summary"` to `UNGATED_TOOLS` (line ~488). Add the dispatch case (near line 704):

```typescript
case "get_rapport_summary":
  output = { summary: await rapport.buildRapportContext(username) };
  break;
```

Add `import * as rapport from "../self/rapport.js";` (confirm the correct relative path for this file's actual location under `src/capabilities/`).

- [ ] **Step 4: Typecheck, run tests, commit**

Export the standard env vars. Run `npx tsc --noEmit && npm test`.

```bash
git add src/capabilities/tools.ts tests/index.test.ts
git commit -m "feat: add get_rapport_summary tool for honest self-reflective queries"
```

---

## Final check

- [ ] Run `npx tsc --noEmit && npm test` end to end.
- [ ] Confirm `buildRapportContext` genuinely returns `""` (not a fabricated line) when a user has zero recorded signals — this is the single most important behavioral guarantee in this plan, re-verify it explicitly.
- [ ] Confirm the personality dials (`system_settings`, `settings-routes.ts`, `system-settings-repo.ts`) are completely untouched by this plan's diff.
- [ ] Manually read `buildRapportContext`'s output for a few different sets of recorded tone descriptors and judge whether the synthesized guidance reads as genuine, useful calibration — not templated, not preachy, not overriding the user's explicit dial settings.
