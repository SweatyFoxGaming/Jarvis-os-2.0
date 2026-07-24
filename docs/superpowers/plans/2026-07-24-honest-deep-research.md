# Honest, Time-Boxed Deep Research Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Jarvis a genuinely honest research mechanism — a real time estimate before any commitment, and, once the user approves a duration, real paced multi-round research (real web searches, real cited sources, real wall-clock time) checkpointed visibly into the vault as it happens. Never present an instant single pass as equivalent to hours of committed research.

**Architecture:** A new `research_jobs` Postgres table + repo (`src/kernel/state/research-jobs-repo.ts`), a new executive module (`src/executive/deep-research.ts`) with `estimateResearchTime` and `runDeepResearchRound`, a scheduler job (`startDeepResearchJob`) that advances every running job by exactly one round per tick, and four new chat tools (`estimate_research_time`, `start_deep_research`, `check_research_progress`, `stop_research_job`). This is a genuinely separate mode from `departments.ts`'s existing `runResearch` (which stays exactly as-is, still used for build-request research) — one completes in seconds as part of a larger flow, the other runs for hours as its own standing job.

**Tech Stack:** TypeScript, `groq-sdk` (`openai/gpt-oss-20b` for structured planning/estimation calls, `llama-3.3-70b-versatile` for plain-text prose synthesis — same model split `departments.ts`'s `runResearch`/`draftCodeChanges` already use), Postgres, the existing `obsidian.ts`/`websearch.ts` providers.

## Global Constraints

- `llama-3.3-70b-versatile` must NEVER be used with `response_format: json_schema` — Groq's API rejects that combination outright (live-verified, see PR #76). Any structured-output call in this plan uses `openai/gpt-oss-20b` (small/cheap structured calls) or `openai/gpt-oss-120b` (larger generation). Plain, non-structured chat completions may use `llama-3.3-70b-versatile` freely (this is what already works for prose synthesis elsewhere in this codebase).
- Real web search only, via the existing `webSearch.webSearch()` (`src/capabilities/providers/websearch.ts`) — never fabricated sources.
- Each scheduler tick advances a running job by exactly **one round**, roughly every 10-15 minutes of real wall-clock time — never a batch of rounds in one tick, and never a fake instantaneous "full" result.
- `estimate_research_time` makes no commitment by itself — a `research_jobs` row is only ever created by `start_deep_research`, and only after the user has explicitly approved a duration in conversation. Nothing in this plan infers or auto-starts a research job.
- Findings must be grounded only in what was actually retrieved — every synthesis prompt in this plan explicitly instructs the model not to invent anything beyond the real sources/content it was given, matching `runDeepResearchRound`'s "the honesty boundary" in the design spec.
- Stopping a job (`stop_research_job`) must never discard what was already found — the vault note and its completed rounds are left intact.
- `npm test` (`tsx tests/index.test.ts`) and `tsc --noEmit` must stay green after every task.

---

### Task 1: `research_jobs` table and `research-jobs-repo.ts`

**Files:**
- Modify: `src/kernel/state/db.ts` (add table DDL to `createSchema()`, right after the existing `vault_links` index creation)
- Create: `src/kernel/state/research-jobs-repo.ts`
- Test: `tests/index.test.ts`

**Interfaces:**
- Consumes: `getPool` from `./db.js` (existing).
- Produces: `ResearchJobStatus`, `ResearchJobRow`, and these exported functions — used by Task 2's `deep-research.ts`, Task 3's `scheduler.ts`, and Task 4's `tools.ts`:
  - `createResearchJob(topic: string, targetDurationHours: number, vaultNotePath: string, requestedBy: string): Promise<ResearchJobRow>`
  - `getResearchJob(id: number): Promise<ResearchJobRow | null>`
  - `listRunningResearchJobs(): Promise<ResearchJobRow[]>`
  - `recordRoundCompleted(id: number): Promise<void>`
  - `markCompleted(id: number): Promise<void>`
  - `markStopped(id: number): Promise<ResearchJobRow | null>`
  - `markError(id: number): Promise<void>`

- [ ] **Step 1: Add the `research_jobs` table to `db.ts`**

In `src/kernel/state/db.ts`, immediately after this existing line (find it with `grep -n "vault_links_to_idx" src/kernel/state/db.ts`):

```typescript
  await db.query(`CREATE INDEX IF NOT EXISTS vault_links_to_idx ON vault_links(to_path_raw);`);
```

add:

```typescript

  // Backs the honestly-timed deep-research mechanism (deep-research.ts,
  // scheduler.ts's startDeepResearchJob). status: 'running' | 'completed' |
  // 'stopped' | 'error'. vault_note_path is the note this job's findings
  // are appended to round by round — always set at creation time, never
  // computed later, since start_deep_research creates the note in the same
  // call that inserts this row.
  await db.query(`
    CREATE TABLE IF NOT EXISTS research_jobs (
      id SERIAL PRIMARY KEY,
      topic TEXT NOT NULL,
      target_duration_hours DOUBLE PRECISION NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      vault_note_path TEXT NOT NULL,
      rounds_completed INTEGER NOT NULL DEFAULT 0,
      requested_by TEXT NOT NULL,
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_round_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS research_jobs_status_idx ON research_jobs(status);`);
```

- [ ] **Step 2: Create `research-jobs-repo.ts`**

Create `src/kernel/state/research-jobs-repo.ts`:

```typescript
import { getPool } from "./db.js";

export type ResearchJobStatus = "running" | "completed" | "stopped" | "error";

export interface ResearchJobRow {
  id: number;
  topic: string;
  target_duration_hours: number;
  status: ResearchJobStatus;
  vault_note_path: string;
  rounds_completed: number;
  requested_by: string;
  started_at: Date;
  last_round_at: Date | null;
  completed_at: Date | null;
}

// A genuine write with no sensible fallback value — allowed to reject,
// same reasoning build-requests-repo.ts's createBuildRequest already uses.
export async function createResearchJob(
  topic: string,
  targetDurationHours: number,
  vaultNotePath: string,
  requestedBy: string
): Promise<ResearchJobRow> {
  const db = getPool();
  const { rows } = await db.query(
    `INSERT INTO research_jobs (topic, target_duration_hours, vault_note_path, requested_by)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [topic, targetDurationHours, vaultNotePath, requestedBy]
  );
  return rows[0];
}

export async function getResearchJob(id: number): Promise<ResearchJobRow | null> {
  try {
    const db = getPool();
    const { rows } = await db.query(`SELECT * FROM research_jobs WHERE id = $1`, [id]);
    return rows[0] || null;
  } catch {
    return null;
  }
}

// Read side, degrades to an empty array — this backs the scheduler tick
// (startDeepResearchJob), which must never crash the whole scheduler over a
// transient DB hiccup; a tick that sees nothing running just does nothing.
export async function listRunningResearchJobs(): Promise<ResearchJobRow[]> {
  try {
    const db = getPool();
    const { rows } = await db.query(`SELECT * FROM research_jobs WHERE status = 'running' ORDER BY started_at ASC`);
    return rows;
  } catch {
    return [];
  }
}

export async function recordRoundCompleted(id: number): Promise<void> {
  try {
    const db = getPool();
    await db.query(
      `UPDATE research_jobs SET rounds_completed = rounds_completed + 1, last_round_at = now() WHERE id = $1 AND status = 'running'`,
      [id]
    );
  } catch {
    // Best-effort — matches build-requests-repo.ts's markPrError-style writes.
  }
}

export async function markCompleted(id: number): Promise<void> {
  try {
    const db = getPool();
    await db.query(
      `UPDATE research_jobs SET status = 'completed', completed_at = now() WHERE id = $1 AND status = 'running'`,
      [id]
    );
  } catch {
    // Best-effort.
  }
}

// Only stoppable while running — an already-completed/stopped/errored job
// has nothing left to stop. Returns the row so the caller (the
// stop_research_job tool) can report how many rounds were actually
// completed before stopping, and null when there was nothing running to
// stop (already terminal, or no such job).
export async function markStopped(id: number): Promise<ResearchJobRow | null> {
  try {
    const db = getPool();
    const { rows } = await db.query(
      `UPDATE research_jobs SET status = 'stopped', completed_at = now() WHERE id = $1 AND status = 'running' RETURNING *`,
      [id]
    );
    return rows[0] || null;
  } catch {
    return null;
  }
}

export async function markError(id: number): Promise<void> {
  try {
    const db = getPool();
    await db.query(
      `UPDATE research_jobs SET status = 'error', completed_at = now() WHERE id = $1 AND status = 'running'`,
      [id]
    );
  } catch {
    // Best-effort.
  }
}
```

- [ ] **Step 3: Write degrade-safety tests**

In `tests/index.test.ts`, add this import alongside the existing `vault-repo.js` import (find it via `grep -n 'from "../src/kernel/state/vault-repo.js"' tests/index.test.ts`):

```typescript
import { createResearchJob, getResearchJob, listRunningResearchJobs, markStopped } from "../src/kernel/state/research-jobs-repo.js";
```

Add these tests right after the existing `"Vault"` category tests (find the last one via `grep -n 'registerTest("Vault"' tests/index.test.ts`, insert after the `getBacklinks` test's closing `});`):

```typescript
// ---------- Research Jobs Tests (degrade-safety, no live Postgres) ----------

registerTest("ResearchJobs", "createResearchJob degrades cleanly when Postgres isn't reachable", async () => {
  try {
    await createResearchJob("quantum physics", 10, "Research/quantum-physics.md", "admin");
    throw new Error("ResearchJobs: expected createResearchJob to reject without a live Postgres connection");
  } catch (err: any) {
    if (err.message?.includes("expected createResearchJob to reject")) throw err;
    // Any other thrown error (connection refused/DNS failure) is expected —
    // createResearchJob is a genuine write with no sensible fallback value.
  }
});

registerTest("ResearchJobs", "getResearchJob degrades cleanly when Postgres isn't reachable", async () => {
  const result = await getResearchJob(1);
  if (result !== null) {
    throw new Error(`ResearchJobs: expected null with no DB, got: ${JSON.stringify(result)}`);
  }
});

registerTest("ResearchJobs", "listRunningResearchJobs degrades cleanly when Postgres isn't reachable", async () => {
  const result = await listRunningResearchJobs();
  if (!Array.isArray(result) || result.length !== 0) {
    throw new Error(`ResearchJobs: expected an empty array with no DB, got: ${JSON.stringify(result)}`);
  }
});

registerTest("ResearchJobs", "markStopped degrades cleanly when Postgres isn't reachable", async () => {
  const result = await markStopped(1);
  if (result !== null) {
    throw new Error(`ResearchJobs: expected null with no DB, got: ${JSON.stringify(result)}`);
  }
});
```

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: all `ResearchJobs` tests pass; total pass count is 4 higher than before this task; no other regressions.

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/kernel/state/db.ts src/kernel/state/research-jobs-repo.ts tests/index.test.ts
git commit -m "feat: add research_jobs table and repo for time-boxed deep research"
```

---

### Task 2: `deep-research.ts` — honest time estimation and per-round research

**Files:**
- Modify: `src/kernel/security.ts` (add `"research.manage"` to `ALL_CAPABILITIES`)
- Create: `src/executive/deep-research.ts`
- Test: `tests/index.test.ts`

**Interfaces:**
- Consumes: `Groq` (from `groq-sdk`), `toGroqSchema` (`../runtime/groq-client.js`), `obsidian.readNote`/`obsidian.appendToNote` (`../capabilities/providers/obsidian.js`), `webSearch.webSearch` (`../capabilities/providers/websearch.js`), `researchJobsRepo.recordRoundCompleted` (Task 1), `ResearchJobRow` (Task 1).
- Produces: `export interface TimeEstimate { estimatedRounds: number; minHours: number; maxHours: number; reasoning: string }`, `export async function estimateResearchTime(topic: string, groq: Groq | null): Promise<TimeEstimate>`, `export async function runDeepResearchRound(job: ResearchJobRow, groq: Groq | null, isFinalRound: boolean): Promise<void>` — Task 3's scheduler and Task 4's tools both call these directly.

- [ ] **Step 1: Add the new capability**

In `src/kernel/security.ts`, in the `ALL_CAPABILITIES` array (find it via `grep -n '"vault.write"' src/kernel/security.ts`), add a new entry right after `"vault.write",`:

```typescript
  "vault.write",
  "research.manage",
```

- [ ] **Step 2: Create `deep-research.ts`**

Create `src/executive/deep-research.ts`:

```typescript
import { Type } from "@google/genai";
import Groq from "groq-sdk";
import { toGroqSchema } from "../runtime/groq-client.js";
import { ObservationPlatform } from "../kernel/observation.js";
import * as obsidian from "../capabilities/providers/obsidian.js";
import * as webSearch from "../capabilities/providers/websearch.js";
import * as researchJobsRepo from "../kernel/state/research-jobs-repo.js";
import type { ResearchJobRow } from "../kernel/state/research-jobs-repo.js";

const observation = ObservationPlatform.getInstance();

/**
 * Genuinely separate from departments.ts's runResearch: that function is a
 * single few-second pass used as one step inside a build request, fine for
 * "does this library exist." This module is for open-ended, topic-general,
 * multi-round research that runs for hours as its own standing job — the
 * two are structurally different processes, not the same one at different
 * settings.
 */

export interface TimeEstimate {
  estimatedRounds: number;
  minHours: number;
  maxHours: number;
  reasoning: string;
}

const TIME_ESTIMATE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    estimatedRounds: { type: Type.NUMBER, description: "Roughly how many 10-15 minute research rounds this topic genuinely needs to cover meaningfully" },
    minHours: { type: Type.NUMBER, description: "A genuine lower-bound estimate in hours" },
    maxHours: { type: Type.NUMBER, description: "A genuine upper-bound estimate in hours" },
    reasoning: { type: Type.STRING, description: "Why this range — the topic's actual breadth/depth, made visible, not just a bare number" },
  },
  required: ["estimatedRounds", "minHours", "maxHours", "reasoning"],
};

/**
 * Never claims something substantial is instantaneous. Reasons about the
 * topic's real breadth and gives an honest range grounded in a real unit of
 * work (~10-15 minutes of real search-and-read time per round) — this tool
 * makes no commitment by itself; only start_deep_research does, and only
 * after the user has explicitly approved a duration in conversation.
 */
export async function estimateResearchTime(topic: string, groq: Groq | null): Promise<TimeEstimate> {
  if (!groq) {
    return {
      estimatedRounds: 0,
      minHours: 0,
      maxHours: 0,
      reasoning: "No capable model is available right now, so I can't honestly estimate this — I'd need Groq reachable to reason about the topic's breadth.",
    };
  }
  try {
    const response = await groq.chat.completions.create({
      model: "openai/gpt-oss-20b",
      messages: [{
        role: "user",
        content:
          `Estimate how much real research this topic needs to cover meaningfully: "${topic}". ` +
          "Reason about the topic's actual breadth and depth — a narrow specific question needs far less than a broad " +
          "field. Each research round is roughly 10-15 minutes of real search-and-read time. Give a genuine range, " +
          "never a falsely precise single number, and never claim something substantial is instantaneous.",
      }],
      response_format: {
        type: "json_schema",
        json_schema: { name: "research_time_estimate", schema: toGroqSchema(TIME_ESTIMATE_SCHEMA), strict: true },
      },
    });
    const parsed = JSON.parse(response.choices[0]?.message?.content || "{}");
    return {
      estimatedRounds: typeof parsed.estimatedRounds === "number" ? parsed.estimatedRounds : 0,
      minHours: typeof parsed.minHours === "number" ? parsed.minHours : 0,
      maxHours: typeof parsed.maxHours === "number" ? parsed.maxHours : 0,
      reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "",
    };
  } catch (err: any) {
    observation.logTelemetry("warn", "DeepResearch", `Time estimation failed: ${err.message}`);
    return {
      estimatedRounds: 0,
      minHours: 0,
      maxHours: 0,
      reasoning: `Estimation failed (${err.message}) — I can't honestly give you a number right now.`,
    };
  }
}

const NEXT_FACET_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    facet: { type: Type.STRING, description: "One specific, genuinely unexplored facet of the topic to research next" },
    searchQuery: { type: Type.STRING, description: "A concrete, real web search query for this facet" },
  },
  required: ["facet", "searchQuery"],
};

/**
 * Runs exactly ONE round for one job — the scheduler tick (startDeepResearchJob)
 * calls this once per running job per tick, never a batch of rounds at once.
 * A normal round: ask what unexplored facet to cover next (grounded in what
 * earlier rounds already found, read back from the vault note itself so
 * rounds don't repeat ground already covered), run a real web search for it,
 * synthesize notes grounded only in what was actually retrieved, and append
 * a timestamped section to the vault note. The final round (once wall-clock
 * time since started_at reaches target_duration_hours) instead synthesizes
 * everything found across every prior round into one closing section.
 */
export async function runDeepResearchRound(job: ResearchJobRow, groq: Groq | null, isFinalRound: boolean): Promise<void> {
  if (!groq) {
    observation.logTelemetry("warn", "DeepResearch", `Skipping round for job #${job.id} — no Groq client available.`);
    return;
  }

  let existingContent = "";
  try {
    existingContent = await obsidian.readNote(job.vault_note_path);
  } catch (err: any) {
    observation.logTelemetry("warn", "DeepResearch", `Could not read existing note for job #${job.id}: ${err.message}`);
  }

  if (isFinalRound) {
    try {
      const synthesis = await groq.chat.completions.create({
        model: "llama-3.3-70b-versatile",
        messages: [{
          role: "user",
          content:
            `Write a final, comprehensive synthesis of everything found across all research rounds below, for the topic ` +
            `"${job.topic}". Ground it ONLY in what's actually written in these rounds — do not invent findings beyond them.\n\n` +
            existingContent,
        }],
      });
      const summary = synthesis.choices[0]?.message?.content || "No synthesis could be generated from the rounds recorded above.";
      await obsidian.appendToNote(
        job.vault_note_path,
        `\n## Synthesis — ${new Date().toISOString()}\n\n${summary}\n`,
        { createIfMissing: true }
      );
    } catch (err: any) {
      observation.logTelemetry("warn", "DeepResearch", `Final synthesis failed for job #${job.id}: ${err.message}`);
      throw err; // let the scheduler's catch mark the job 'error' rather than silently 'completed' with no synthesis
    }
    return;
  }

  let facet = job.topic;
  let searchQuery = job.topic;
  try {
    const planResponse = await groq.chat.completions.create({
      model: "openai/gpt-oss-20b",
      messages: [{
        role: "user",
        content:
          `You are doing real, paced, multi-round research on "${job.topic}" (round ${job.rounds_completed + 1}). ` +
          "Below is everything covered in earlier rounds. Pick ONE specific, genuinely unexplored facet to cover next " +
          "— never repeat ground already covered.\n\n" +
          `Already covered:\n${existingContent.slice(0, 4000) || "(nothing yet — this is the first round)"}`,
      }],
      response_format: {
        type: "json_schema",
        json_schema: { name: "next_research_facet", schema: toGroqSchema(NEXT_FACET_SCHEMA), strict: true },
      },
    });
    const parsed = JSON.parse(planResponse.choices[0]?.message?.content || "{}");
    facet = typeof parsed.facet === "string" && parsed.facet.trim() ? parsed.facet.trim() : job.topic;
    searchQuery = typeof parsed.searchQuery === "string" && parsed.searchQuery.trim() ? parsed.searchQuery.trim() : facet;
  } catch (err: any) {
    observation.logTelemetry("warn", "DeepResearch", `Facet planning failed for job #${job.id}: ${err.message}. Falling back to the raw topic.`);
  }

  let sources: Awaited<ReturnType<typeof webSearch.webSearch>> = [];
  try {
    sources = await webSearch.webSearch(searchQuery);
  } catch (err: any) {
    observation.logTelemetry("warn", "DeepResearch", `Web search failed for job #${job.id}: ${err.message}`);
  }

  let notes = "No sources were found for this facet.";
  if (sources.length > 0) {
    const sourcesText = sources.map(s => `- ${s.title} (${s.url})${s.description ? `: ${s.description}` : ""}`).join("\n");
    try {
      const synthesis = await groq.chat.completions.create({
        model: "llama-3.3-70b-versatile",
        messages: [{
          role: "user",
          content:
            `Write concise research notes on "${facet}" (part of researching "${job.topic}"), grounded ONLY in these real ` +
            "sources — do not add anything beyond what they actually say:\n\n" + sourcesText,
        }],
      });
      notes = synthesis.choices[0]?.message?.content || sourcesText;
    } catch (err: any) {
      observation.logTelemetry("warn", "DeepResearch", `Round synthesis failed for job #${job.id}: ${err.message}. Using raw source list.`);
      notes = sourcesText;
    }
  }

  const roundNumber = job.rounds_completed + 1;
  const sourcesList = sources.length > 0
    ? sources.map(s => `- [${s.title}](${s.url})`).join("\n")
    : "(none found)";
  const section =
    `\n## Round ${roundNumber} — ${new Date().toISOString()}\n\n` +
    `**Focus:** ${facet}\n\n` +
    `**Sources found:**\n${sourcesList}\n\n` +
    `**Notes:** ${notes}\n`;

  await obsidian.appendToNote(job.vault_note_path, section, { createIfMissing: true });
  await researchJobsRepo.recordRoundCompleted(job.id);
}
```

- [ ] **Step 3: Test the honest degrade path**

In `tests/index.test.ts`, add this import next to the other executive-module imports (find via `grep -n 'from "../src/executive/departments.js"' tests/index.test.ts`):

```typescript
import { estimateResearchTime } from "../src/executive/deep-research.js";
```

Add this test right after the `ResearchJobs` category tests from Task 1:

```typescript
// ---------- Deep Research Tests ----------

registerTest("DeepResearch", "estimateResearchTime gives an honest 'no model available' answer instead of a fake instant estimate", async () => {
  const result = await estimateResearchTime("quantum physics", null);
  if (!result.reasoning.toLowerCase().includes("no capable model")) {
    throw new Error(`DeepResearch: expected an honest no-model message, got: "${result.reasoning}"`);
  }
  if (result.estimatedRounds !== 0 || result.minHours !== 0 || result.maxHours !== 0) {
    throw new Error("DeepResearch: expected zeroed-out numbers alongside the honest no-model message, not a fabricated estimate");
  }
});
```

This is the one piece of this plan's honesty requirement that's cheaply testable without a live model or network: confirming Jarvis never fabricates a confident-looking number when it genuinely has no way to reason about the topic.

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: the new `DeepResearch` test passes; total pass count is 1 higher than after Task 1.

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/kernel/security.ts src/executive/deep-research.ts tests/index.test.ts
git commit -m "feat: add deep-research.ts — honest time estimation and per-round research"
```

---

### Task 3: `startDeepResearchJob` scheduler wiring

**Files:**
- Modify: `src/kernel/scheduler.ts`
- Modify: `src/server.ts` (boot sequence)

**Interfaces:**
- Consumes: `deepResearch.runDeepResearchRound` (Task 2), `researchJobsRepo.listRunningResearchJobs`/`markCompleted`/`markError` (Task 1), `pushNotification` (already in `scheduler.ts`).
- Produces: `export function startDeepResearchJob(groq: Groq | null, intervalMs = 12 * 60 * 1000): NodeJS.Timeout` — called once from `server.ts`'s boot sequence; no other task depends on it.

- [ ] **Step 1: Add imports to `scheduler.ts`**

At the top of `src/kernel/scheduler.ts`, add these two imports next to the existing `obsidian`/`vaultRepo` imports:

```typescript
import * as deepResearch from "../executive/deep-research.js";
import * as researchJobsRepo from "./state/research-jobs-repo.js";
```

- [ ] **Step 2: Add `startDeepResearchJob`**

At the end of `src/kernel/scheduler.ts` (after `startVaultSyncJob`'s closing brace), add:

```typescript

/**
 * Advances every currently-running deep-research job by exactly one round
 * per tick — never a batch of rounds at once, since the entire point of
 * this mechanism is real, paced wall-clock time, not a fake instantaneous
 * "full" result dressed up as hours of committed work. Once a job's
 * elapsed wall-clock time since started_at reaches its committed
 * target_duration_hours, that job's tick runs the final synthesis round
 * instead of a normal one, then marks it completed and notifies the user —
 * same "something happens without a chat message" pattern as the briefing
 * and self-reflection jobs.
 */
export function startDeepResearchJob(groq: Groq | null, intervalMs = 12 * 60 * 1000): NodeJS.Timeout {
  return registerJob("deep-research", intervalMs, async () => {
    if (!groq) return;
    const jobs = await researchJobsRepo.listRunningResearchJobs();
    for (const job of jobs) {
      try {
        const elapsedHours = (Date.now() - new Date(job.started_at).getTime()) / (60 * 60 * 1000);
        const isFinalRound = elapsedHours >= job.target_duration_hours;
        await deepResearch.runDeepResearchRound(job, groq, isFinalRound);
        if (isFinalRound) {
          await researchJobsRepo.markCompleted(job.id);
          pushNotification(
            job.requested_by,
            `Finished the deep research on "${job.topic}", sir — ${job.rounds_completed + 1} round(s) over ~${job.target_duration_hours} hour(s). Full findings are in your vault at ${job.vault_note_path}.`,
            "success"
          );
        }
      } catch (err: any) {
        observation.logTelemetry("warn", "DeepResearch", `Round failed for job #${job.id}: ${err.message}`);
        await researchJobsRepo.markError(job.id);
      }
    }
  });
}
```

- [ ] **Step 3: Wire it into `server.ts`'s boot sequence**

In `src/server.ts`, find `scheduler.startVaultSyncJob();` (via `grep -n "startVaultSyncJob" src/server.ts`) and add this line immediately after it:

```typescript
  scheduler.startDeepResearchJob(groq);
```

- [ ] **Step 4: Run the full test suite and typecheck**

Run: `npm test`
Expected: same pass count as after Task 2 (this task adds no new automated tests — the recurring job itself is verified manually per this plan's Global Constraints and the design spec's Testing section, same as every other recurring job in this codebase).

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/kernel/scheduler.ts src/server.ts
git commit -m "feat: wire startDeepResearchJob into the scheduler and boot sequence"
```

---

### Task 4: Chat tools — `estimate_research_time`, `start_deep_research`, `check_research_progress`, `stop_research_job`

**Files:**
- Modify: `src/capabilities/tools.ts`

**Interfaces:**
- Consumes: `briefing.getConfiguredGroq()` (existing — same pattern `get_briefing` already uses to reach a live Groq client from inside `executeTool` without threading it through the function signature), `obsidian.slugify`/`obsidian.createNote` (existing), `deepResearch.estimateResearchTime` (Task 2), `researchJobsRepo.createResearchJob`/`getResearchJob`/`markStopped` (Task 1).
- Produces: nothing further downstream — this is the final task in this plan; these tools are directly callable from chat once merged.

- [ ] **Step 1: Add imports**

`src/capabilities/tools.ts` already imports `briefing` (`import * as briefing from "../world/briefing.js";` — confirm with `grep -n 'from "../world/briefing.js"' src/capabilities/tools.ts`; it's used by the existing `get_briefing` case). Do NOT add a second import for it — reuse the existing one.

Add these two new imports next to the existing `vaultRepo`/`obsidian` imports:

```typescript
import * as deepResearch from "../executive/deep-research.js";
import * as researchJobsRepo from "../kernel/state/research-jobs-repo.js";
```

- [ ] **Step 2: Add `PERMISSION_BY_TOOL` entries**

In the `PERMISSION_BY_TOOL` map (find via `grep -n "write_vault_note: \"vault.write\"" src/capabilities/tools.ts`), add right after that line:

```typescript
  start_deep_research: "research.manage",
  check_research_progress: "research.manage",
  stop_research_job: "research.manage",
```

`estimate_research_time` is deliberately absent from this map — it's informational-only with no state change, so it goes in `UNGATED_TOOLS` instead (Step 5).

- [ ] **Step 3: Add the four tool declarations**

In `TOOL_DECLARATIONS` (the array), add these four entries right after the existing `write_vault_note` declaration (find its closing `},` via `grep -n '"write_vault_note"' src/capabilities/tools.ts`):

```typescript
  {
    name: "estimate_research_time",
    description:
      "Give an honest, reasoned time estimate for how long real research on a topic would take — never claim " +
      "something substantial is instantaneous. Use this whenever the user asks how long research on something would " +
      "take, BEFORE any commitment to actually do it. This makes no commitment by itself; call start_deep_research " +
      "only after the user explicitly approves a duration.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        topic: { type: Type.STRING, description: "The topic to estimate research time for" },
      },
      required: ["topic"],
    },
  },
  {
    name: "start_deep_research",
    description:
      "Begin a real, paced, multi-round research job on a topic — ONLY call this after the user has explicitly " +
      "approved a specific duration (e.g. after estimate_research_time gave a range and the user said to go ahead " +
      "with a number of hours). This does NOT produce an instant result — real findings accumulate over real wall-clock " +
      "time in the user's vault as rounds complete. Never call this speculatively or infer a duration the user didn't state.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        topic: { type: Type.STRING, description: "The topic to research" },
        targetDurationHours: { type: Type.NUMBER, description: "The duration in hours the user explicitly approved" },
      },
      required: ["topic", "targetDurationHours"],
    },
  },
  {
    name: "check_research_progress",
    description: "Check the current status of a running deep-research job — how many rounds have completed, and whether it's still running.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        jobId: { type: Type.NUMBER, description: "The research job's numeric id" },
      },
      required: ["jobId"],
    },
  },
  {
    name: "stop_research_job",
    description: "Cancel a running deep-research job early. Whatever was found in earlier rounds stays in the vault — nothing is discarded.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        jobId: { type: Type.NUMBER, description: "The research job's numeric id" },
      },
      required: ["jobId"],
    },
  },
```

- [ ] **Step 4: Add the four `executeTool` cases**

In the `executeTool` switch statement (find the `case "write_vault_note":` via `grep -n 'case "write_vault_note"' src/capabilities/tools.ts`), add these four cases right after it:

```typescript
      case "estimate_research_time": {
        const estimate = await deepResearch.estimateResearchTime(args.topic, briefing.getConfiguredGroq());
        output = estimate;
        break;
      }
      case "start_deep_research": {
        const targetDurationHours = Number(args.targetDurationHours);
        if (!Number.isFinite(targetDurationHours) || targetDurationHours <= 0) {
          return { name, ok: false, error: "targetDurationHours must be a positive number." };
        }
        if (!process.env.OBSIDIAN_VAULT_DIR) {
          return { name, ok: false, error: "Deep research requires a configured Obsidian vault (OBSIDIAN_VAULT_DIR) to write findings to — it isn't set up yet." };
        }
        const notePath = `Research/${obsidian.slugify(args.topic)}`;
        const job = await researchJobsRepo.createResearchJob(args.topic, targetDurationHours, notePath, username);
        await obsidian.createNote(
          notePath,
          `# ${args.topic}\n\nResearch job started — committed to ~${targetDurationHours} hour(s). Real findings will appear below as rounds complete, roughly one every 10-15 minutes.\n`,
          { type: "deep-research", research_job_id: job.id, target_duration_hours: targetDurationHours, created: new Date().toISOString() }
        );
        output = { jobId: job.id, notePath, message: `Started — committed to ~${targetDurationHours} hour(s). Findings will accumulate in "${notePath}" in your vault as real rounds complete.` };
        break;
      }
      case "check_research_progress": {
        const job = await researchJobsRepo.getResearchJob(Number(args.jobId));
        if (!job) {
          return { name, ok: false, error: `No research job found with id ${args.jobId}.` };
        }
        output = {
          topic: job.topic,
          status: job.status,
          roundsCompleted: job.rounds_completed,
          targetDurationHours: job.target_duration_hours,
          startedAt: job.started_at,
          lastRoundAt: job.last_round_at,
          vaultNotePath: job.vault_note_path,
        };
        break;
      }
      case "stop_research_job": {
        const stopped = await researchJobsRepo.markStopped(Number(args.jobId));
        if (!stopped) {
          return { name, ok: false, error: `No running research job found with id ${args.jobId} — it may already be completed, stopped, or errored.` };
        }
        output = { stopped: true, roundsCompleted: stopped.rounds_completed, vaultNotePath: stopped.vault_note_path };
        break;
      }
```

- [ ] **Step 5: Add `estimate_research_time` to `UNGATED_TOOLS`**

Find `const UNGATED_TOOLS = new Set(["display_content"]);` (via `grep -n "UNGATED_TOOLS = new Set" src/capabilities/tools.ts`) and change it to:

```typescript
  const UNGATED_TOOLS = new Set(["display_content", "estimate_research_time"]);
```

This step is not optional — without it, `estimate_research_time` would be rejected as `Unknown tool` by `executeTool`'s own guard (any tool name absent from both `PERMISSION_BY_TOOL` and `UNGATED_TOOLS` is treated as unknown), even though it's declared in `TOOL_DECLARATIONS`.

- [ ] **Step 6: Add a `TOOL_TRIGGER_WORDS` entry for `estimate_research_time` only**

In `TOOL_TRIGGER_WORDS` (find via `grep -n "write_vault_note: \[" src/capabilities/tools.ts`), add right after that line:

```typescript
  estimate_research_time: ["how long would it take to research", "how long will it take to research", "how long to research", "estimate research time"],
```

Do **not** add entries for `start_deep_research`, `check_research_progress`, or `stop_research_job` — same reasoning the existing comment above `TOOL_TRIGGER_WORDS` already gives for `confirm_build_direction`: starting/stopping a multi-hour commitment should only ever happen as a deliberate model-driven follow-up inside a real conversation (after the user has actually approved a duration or referenced a specific job), never routed to directly by a keyword match.

- [ ] **Step 7: Run the full test suite and typecheck**

Run: `npm test`
Expected: same pass count as after Task 3 (this task adds no new automated tests of its own — `estimateResearchTime`'s honest-degrade path is already covered by Task 2's test; the tool-routing/permission wiring here is the same pattern every other tool in this file already uses untested at this layer, and the live multi-round flow is verified manually in Step 8).

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 8: Manually verify against a real running instance**

With the stack running, `OBSIDIAN_VAULT_DIR` configured, and `GROQ_API_KEY`/`BRAVE_API_KEY` set, send a real chat message: *"How long would it take to research quantum physics?"* — confirm Jarvis gives a genuine range with visible reasoning, not an instant "done" answer. Then say something like *"Okay, take 1 hour"* (use a short duration for testing) and confirm Jarvis calls `start_deep_research` and confirms it's started. Watch `docker logs jarvis-os-api` over the following ~12-15 minutes for a `"deep-research"` scheduler tick, and confirm the vault note at the reported path gains a real `## Round 1` section with real sources. After the committed duration elapses, confirm a final `## Synthesis` section is appended, the job's status becomes `completed` in `research_jobs` (`docker exec jarvis-postgres psql -U ... -c "SELECT id, topic, status, rounds_completed FROM research_jobs;"`), and a push notification arrives.

- [ ] **Step 9: Commit**

```bash
git add src/capabilities/tools.ts
git commit -m "feat: add estimate_research_time/start_deep_research/check_research_progress/stop_research_job tools"
```

---

## Final Verification

- `npm test` — full suite green, no regressions from before this plan.
- `npx tsc --noEmit` — no errors.
- Task 4 Step 8's full manual flow (estimate → approve a short duration → real rounds appear in the vault on schedule → final synthesis → completion notification) passes against a real running stack.
