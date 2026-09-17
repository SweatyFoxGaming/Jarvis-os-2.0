# Structured Coding Loop (Plan → Execute → Review) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the coding agent's single flat 40-turn loop with a plan-first, per-task-execution, per-task-reviewed loop — plan once, then run each task in a fresh conversation context, review each task's diff independently before moving on, with a bounded auto-fix retry and a safety-net fallback to today's flat loop if planning itself fails.

**Architecture:** `coding-agent.ts`'s `runCodingAgent` gains a plan phase (one forced tool call producing an ordered task list, persisted to a new table) ahead of execution. Task execution becomes a loop over that list: each task gets its own NVIDIA conversation (plan + prior task summaries carried forward, not full history), its own task-scoped diff extraction, and an independent Groq-based structured review with up to 2 bounded fix-and-retry rounds. All existing external behavior — `CodingAgentResult`'s shape, the two human checkpoints, the final mechanical verification gate in `approve-code` — stays unchanged.

**Tech Stack:** TypeScript, NVIDIA NIM (via the existing `nvidia-client.ts`, no changes needed there), Groq (via `groq-sdk`, following this codebase's existing `toGroqSchema`/`response_format` structured-output pattern), Postgres (plain `CREATE TABLE IF NOT EXISTS`, no migration system).

## Global Constraints

- No new `BuildRequestStatus` values — the existing `'error'` status (already used by `markCodeDraftError`) covers every failure path here. `src/kernel/state/build-requests-repo.ts` is not touched by this plan at all.
- No new human checkpoint — this feature operates entirely between the existing direction-confirmation and approve/reject checkpoints, using only `research_summary`/`direction_notes` already gathered before coding starts.
- No secrets or GitHub credentials reach the sandbox at any point — unchanged from PR #86; this plan adds no new `execInWorkspace` env/secret passing.
- Each NVIDIA execution context (the plan phase, and each task) gets exactly one *work* tool, `run_shell_command` — `propose_plan` and `finish_task` are signal/output tools, matching `finish_coding`'s existing precedent in the flat-loop fallback, not additional work tools.
- NVIDIA NIM stays isolated to the coding loop (plan phase + task execution, unchanged provider from PR #86); Groq stays isolated to review (`reviewTaskDiff`, and the pre-existing `reviewCodeDiff`) — no cross-provider mixing inside either.
- `reviewCodeDiff` (`departments.ts:261`) is not modified — a new sibling function, `reviewTaskDiff`, is added instead.
- `npm test` / `tsc --noEmit` must stay green after every task.
- No unit tests for Docker/NVIDIA-dependent orchestration (the plan phase, task execution loop) — matches this codebase's established precedent for `coding-agent.ts`/`jarvis-builder`. Genuinely pure/DB-layer logic (the new repo module, `reviewTaskDiff`'s no-client degrade path) gets normal unit tests.

---

### Task 1: `coding_plan_tasks` table and repo

**Files:**
- Modify: `src/kernel/state/db.ts` (add `coding_plan_tasks` table to `createSchema()`)
- Create: `src/kernel/state/coding-plan-tasks-repo.ts`
- Test: `tests/index.test.ts` (degrade-cleanly tests, matching `transcript-events-repo.ts`'s precedent)

**Interfaces:**
- Consumes: `getPool()` from `./db.js` (existing).
- Produces: `PlannedTaskInput` (`{seq: number; title: string; description: string}`), `PlanTaskRow` (`{id, build_request_id, seq, title, description, status, summary, created_at, updated_at}`), `createPlan(buildRequestId: number, tasks: PlannedTaskInput[]): Promise<void>`, `updateTaskStatus(buildRequestId: number, seq: number, status: string, summary?: string): Promise<void>`, `listPlanTasks(buildRequestId: number): Promise<PlanTaskRow[]>`, all exported from `src/kernel/state/coding-plan-tasks-repo.ts`. Task 3 calls `createPlan`/`updateTaskStatus` from inside the coding loop; Task 4's new route calls `listPlanTasks`.

- [ ] **Step 1: Add the `coding_plan_tasks` table to `db.ts`'s schema**

Find the existing `transcript_events` table block in `src/kernel/state/db.ts` (it ends with its index, right before a comment about `push_subscriptions`):

```ts
  await db.query(`CREATE INDEX IF NOT EXISTS transcript_events_build_request_idx ON transcript_events(build_request_id, seq);`);

  // Browser Push API subscriptions — one row per device/browser that's
```

Insert the new table block between the index line and the `push_subscriptions` comment, so it reads:

```ts
  await db.query(`CREATE INDEX IF NOT EXISTS transcript_events_build_request_idx ON transcript_events(build_request_id, seq);`);

  // The task breakdown the coding loop proposes before executing anything —
  // the "View Plan" panel's data source. One row per task, status updated
  // in place as the loop progresses (pending -> in_progress -> done, or
  // needs_fixes/failed on a bad review). Cascades on build_requests delete
  // for the same reason transcript_events does.
  await db.query(`
    CREATE TABLE IF NOT EXISTS coding_plan_tasks (
      id SERIAL PRIMARY KEY,
      build_request_id INTEGER NOT NULL REFERENCES build_requests(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      summary TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS coding_plan_tasks_build_request_idx ON coding_plan_tasks(build_request_id, seq);`);

  // Browser Push API subscriptions — one row per device/browser that's
```

- [ ] **Step 2: Write `src/kernel/state/coding-plan-tasks-repo.ts`**

```ts
import { getPool } from "./db.js";

export interface PlanTaskRow {
  id: number;
  build_request_id: number;
  seq: number;
  title: string;
  description: string;
  status: string;
  summary: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface PlannedTaskInput {
  seq: number;
  title: string;
  description: string;
}

// Best-effort like every write in build-requests-repo.ts / transcript-events-repo.ts
// — a missed plan-status write must never abort the coding session itself.
export async function createPlan(buildRequestId: number, tasks: PlannedTaskInput[]): Promise<void> {
  try {
    const db = getPool();
    for (const task of tasks) {
      await db.query(
        `INSERT INTO coding_plan_tasks (build_request_id, seq, title, description) VALUES ($1, $2, $3, $4)`,
        [buildRequestId, task.seq, task.title, task.description]
      );
    }
  } catch {
    // Best-effort — see comment above.
  }
}

export async function updateTaskStatus(
  buildRequestId: number,
  seq: number,
  status: string,
  summary?: string
): Promise<void> {
  try {
    const db = getPool();
    await db.query(
      `UPDATE coding_plan_tasks SET status = $1, summary = COALESCE($2, summary), updated_at = now() WHERE build_request_id = $3 AND seq = $4`,
      [status, summary ?? null, buildRequestId, seq]
    );
  } catch {
    // Best-effort.
  }
}

export async function listPlanTasks(buildRequestId: number): Promise<PlanTaskRow[]> {
  try {
    const db = getPool();
    const { rows } = await db.query(
      `SELECT * FROM coding_plan_tasks WHERE build_request_id = $1 ORDER BY seq ASC`,
      [buildRequestId]
    );
    return rows;
  } catch {
    return [];
  }
}
```

- [ ] **Step 3: Add unit tests**

In `tests/index.test.ts`, add this import alongside the existing `transcript-events-repo.js` import:

```ts
import { createPlan, listPlanTasks } from "../src/kernel/state/coding-plan-tasks-repo.js";
```

Then add, right after the existing `// ---------- TranscriptEvents Tests ----------` block:

```ts
// ---------- CodingPlanTasks Tests ----------

registerTest("CodingPlanTasks", "createPlan degrades cleanly when Postgres isn't reachable", async () => {
  await createPlan(999999, [{ seq: 1, title: "t", description: "d" }]);
  // No throw is the assertion — matches this file's existing degrade-cleanly tests.
});

registerTest("CodingPlanTasks", "listPlanTasks degrades cleanly when Postgres isn't reachable", async () => {
  const tasks = await listPlanTasks(999999);
  if (!Array.isArray(tasks) || tasks.length !== 0) {
    throw new Error(`CodingPlanTasks: expected an empty array with no DB, got: ${JSON.stringify(tasks)}`);
  }
});
```

- [ ] **Step 4: Typecheck**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 5: Run the tests**

Run: `npm test`
Expected: 114/114 passing (112 baseline on this branch + 2 new CodingPlanTasks tests).

- [ ] **Step 6: Commit**

```bash
git add src/kernel/state/db.ts src/kernel/state/coding-plan-tasks-repo.ts tests/index.test.ts
git commit -m "feat: add the coding_plan_tasks table and repo"
```

---

### Task 2: `reviewTaskDiff` — structured per-task review

**Files:**
- Modify: `src/executive/departments.ts` (add `reviewTaskDiff` alongside the existing `reviewCodeDiff`)
- Test: `tests/index.test.ts` (degrade-cleanly test, mirroring `reviewCodeDiff`'s existing one)

**Interfaces:**
- Consumes: `DraftedFile` (existing, `src/kernel/state/build-requests-repo.ts`), `Groq` type (existing `groq-sdk` import already in this file), `toGroqSchema` (existing, `../runtime/groq-client.js`).
- Produces: `reviewTaskDiff(taskTitle: string, taskDescription: string, files: DraftedFile[], groq: Groq | null): Promise<{approved: boolean; findings: string}>`, exported from `src/executive/departments.ts`. Task 3 calls this once per task, per fix attempt.

- [ ] **Step 1: Add `reviewTaskDiff` to `departments.ts`**

Add this at the end of `src/executive/departments.ts`, after the existing `reviewCodeDiff` function (do not modify `reviewCodeDiff` itself):

```ts
const TASK_REVIEW_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    approved: { type: Type.BOOLEAN },
    findings: { type: Type.STRING },
  },
  required: ["approved", "findings"],
};

// A task-scoped gate, not a merge review — judges one task's diff against
// that task's own title/description, not the whole build request's
// objective. Returns a structured verdict (not prose, unlike reviewCodeDiff)
// because this drives a programmatic retry/continue decision inside
// coding-agent.ts's fix loop. Fails open (approved: true) both when no Groq
// client is available and when the review call itself throws — an optional
// quality gate degrading closed would turn a transient Groq hiccup into a
// permanently-blocked build, worse than proceeding without the extra check.
export async function reviewTaskDiff(
  taskTitle: string,
  taskDescription: string,
  files: DraftedFile[],
  groq: Groq | null
): Promise<{ approved: boolean; findings: string }> {
  if (!groq) {
    return { approved: true, findings: "No capable model was available to review this task — proceeding without review." };
  }
  try {
    const filesText = files.map((f) => `--- ${f.path} ---\n${f.content}`).join("\n\n");
    const response = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{
        role: "user",
        content:
          "Review this task's drafted code change against what the task was supposed to accomplish. Approve only if it " +
          "genuinely satisfies the task with no real bugs, missing error handling, or security issues. Be concise in findings.\n\n" +
          `Task: ${taskTitle} — ${taskDescription}\n\nFiles:\n${filesText}`,
      }],
      response_format: {
        type: "json_schema",
        json_schema: { name: "task_review", schema: toGroqSchema(TASK_REVIEW_SCHEMA), strict: true },
      },
    });
    const parsed = JSON.parse(response.choices[0]?.message?.content || "{}");
    return {
      approved: parsed.approved === true,
      findings: typeof parsed.findings === "string" ? parsed.findings : "",
    };
  } catch (err: any) {
    observation.logTelemetry("warn", "Departments", `reviewTaskDiff failed: ${err.message}`);
    return { approved: true, findings: `Automated review failed (${err.message}) — proceeding without review.` };
  }
}
```

- [ ] **Step 2: Add a unit test**

In `tests/index.test.ts`, add right after the existing `reviewCodeDiff degrades cleanly with no AI client` test:

```ts
registerTest("Departments", "reviewTaskDiff degrades cleanly with no AI client", async () => {
  const result = await departments.reviewTaskDiff("test task", "test description", [{ path: "a.ts", content: "x" }], null);
  if (result.approved !== true || !result.findings.includes("No capable model was available")) {
    throw new Error(`Departments: expected the no-AI degrade verdict, got: ${JSON.stringify(result)}`);
  }
});
```

- [ ] **Step 3: Typecheck**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: 115/115 passing (114 from Task 1 + 1 new).

- [ ] **Step 5: Commit**

```bash
git add src/executive/departments.ts tests/index.test.ts
git commit -m "feat: add reviewTaskDiff, a structured per-task review gate"
```

---

### Task 3: Rewrite `coding-agent.ts` — plan phase, per-task execution, fix loop

**Files:**
- Modify: `src/executive/coding-agent.ts` (full rewrite of `runCodingAgent`'s body; today's flat loop is extracted into a private fallback function, not deleted)

**Interfaces:**
- Consumes: `createPlan`, `updateTaskStatus` from Task 1's `coding-plan-tasks-repo.js`. Consumes `reviewTaskDiff` from Task 2's `departments.js` — this means `coding-agent.ts` gains a new import, `import * as departments from "./departments.js";` (relative to `src/executive/`, same directory), and a new `Groq` parameter threading in from the caller (see below). `extractChangedFiles` (already in this file, unchanged) is reused for both per-task and final diff extraction.
- Produces: `runCodingAgent`'s exported signature changes from `(buildRequestId, objective, researchSummary, directionNotes, baseBranch, nvidiaApiKey)` to `(buildRequestId, objective, researchSummary, directionNotes, baseBranch, nvidiaApiKey, groq)` — one new trailing parameter, `groq: Groq | null`, threaded through to `reviewTaskDiff`. `CodingAgentResult`'s shape (`{ok:true; summary; files} | {ok:false; error}`) is unchanged — Task 4 (autonomous_executive.ts's caller, already wired from PR #86) needs exactly one edit: pass `this.groq` as the new 7th argument.

- [ ] **Step 1: Rewrite `src/executive/coding-agent.ts`**

Replace the entire file with:

```ts
import { ObservationPlatform } from "../kernel/observation.js";
import * as builderClient from "../kernel/builder-client.js";
import { recordTranscriptEvent } from "../kernel/state/transcript-events-repo.js";
import * as codingPlanTasksRepo from "../kernel/state/coding-plan-tasks-repo.js";
import type { PlannedTaskInput } from "../kernel/state/coding-plan-tasks-repo.js";
import { callNvidiaChat, NvidiaMessage, NvidiaTool } from "../runtime/nvidia-client.js";
import * as departments from "./departments.js";
import type { DraftedFile } from "../kernel/state/build-requests-repo.js";
import Groq from "groq-sdk";

const observation = ObservationPlatform.getInstance();

// Defense-in-depth alongside jarvis-builder's own 1-hour reaper (Plan 1) —
// bounds a model that never calls finish_coding/finish_task, surfaced as an
// honest error rather than silently truncated (design spec, "The agentic
// loop"). MAX_TURNS bounds the flat-loop fallback (the whole objective in
// one pass); MAX_TASK_TURNS bounds one task across all its fix attempts
// combined, not per attempt — simpler to reason about than a separate
// budget per retry.
const MAX_TURNS = 40;
const MAX_TASK_TURNS = 30;
const MAX_TASK_FIX_ATTEMPTS = 2;
const MAX_PLAN_TASKS = 10;

const RUN_SHELL_TOOL: NvidiaTool = {
  type: "function",
  function: {
    name: "run_shell_command",
    description:
      "Run a shell command in the sandboxed workspace (cwd is the repository root) and get back stdout, stderr, and the exit code.",
    parameters: {
      type: "object",
      properties: { command: { type: "string", description: "The shell command to run." } },
      required: ["command"],
      additionalProperties: false,
    },
  },
};

const FINISH_CODING_TOOL: NvidiaTool = {
  type: "function",
  function: {
    name: "finish_coding",
    description:
      "Call this once the objective is fully implemented, tested, and ready for human review. Ends the coding session.",
    parameters: {
      type: "object",
      properties: { summary: { type: "string", description: "A concise summary of what was changed and why." } },
      required: ["summary"],
      additionalProperties: false,
    },
  },
};

const FINISH_TASK_TOOL: NvidiaTool = {
  type: "function",
  function: {
    name: "finish_task",
    description: "Call this once this specific task is fully implemented and ready for review. Ends this task's turn.",
    parameters: {
      type: "object",
      properties: { summary: { type: "string", description: "A concise summary of what this task changed." } },
      required: ["summary"],
      additionalProperties: false,
    },
  },
};

const PROPOSE_PLAN_TOOL: NvidiaTool = {
  type: "function",
  function: {
    name: "propose_plan",
    description: "Break the objective into an ordered list of small, self-contained tasks.",
    parameters: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string", description: "Short task title." },
              description: { type: "string", description: "What this task does and why." },
            },
            required: ["title", "description"],
            additionalProperties: false,
          },
        },
      },
      required: ["tasks"],
      additionalProperties: false,
    },
  },
};

export type CodingAgentResult = { ok: true; summary: string; files: DraftedFile[] } | { ok: false; error: string };

export async function runCodingAgent(
  buildRequestId: number,
  objective: string,
  researchSummary: string,
  directionNotes: string,
  baseBranch: string,
  nvidiaApiKey: string | null,
  groq: Groq | null
): Promise<CodingAgentResult> {
  if (!nvidiaApiKey) {
    return { ok: false, error: "No NVIDIA_API_KEY is configured — the agentic coding loop is unavailable." };
  }

  try {
    await builderClient.createWorkspace(buildRequestId, baseBranch);
  } catch (err: any) {
    return { ok: false, error: `Failed to create the sandboxed workspace: ${err.message}` };
  }

  const baseShaResult = await builderClient.execInWorkspace(buildRequestId, "git rev-parse HEAD");
  if (baseShaResult.exitCode !== 0) {
    await builderClient.destroyWorkspace(buildRequestId).catch(() => {});
    return { ok: false, error: `Failed to resolve the workspace's starting commit: ${baseShaResult.stderr}` };
  }
  const baseSha = baseShaResult.stdout.trim();

  const plan = await proposePlan(nvidiaApiKey, objective, researchSummary, directionNotes);

  if (plan === null) {
    // Planning couldn't produce a usable task list after a retry — fall
    // back to running the whole objective through the flat loop rather
    // than failing the build request outright. Planning is meant to
    // improve reliability, not become a new single point of failure.
    return runFlatCodingLoop(buildRequestId, objective, researchSummary, directionNotes, baseSha, nvidiaApiKey);
  }

  await codingPlanTasksRepo.createPlan(buildRequestId, plan);

  let seq = 0;
  const completedSummaries: string[] = [];

  try {
    for (const task of plan) {
      await codingPlanTasksRepo.updateTaskStatus(buildRequestId, task.seq, "in_progress");

      const taskBaseShaResult = await builderClient.execInWorkspace(buildRequestId, "git rev-parse HEAD");
      if (taskBaseShaResult.exitCode !== 0) {
        await codingPlanTasksRepo.updateTaskStatus(buildRequestId, task.seq, "failed");
        await builderClient.destroyWorkspace(buildRequestId).catch(() => {});
        return { ok: false, error: `Failed to resolve the starting commit for task "${task.title}": ${taskBaseShaResult.stderr}` };
      }
      const taskBaseSha = taskBaseShaResult.stdout.trim();

      const planText = plan.map((t) => `${t.seq}. ${t.title} — ${t.description}`).join("\n");
      const completedText = completedSummaries.length > 0 ? completedSummaries.join("\n") : "(none yet)";

      const messages: NvidiaMessage[] = [
        {
          role: "system",
          content:
            `You are Jarvis's coding agent, working alone in an isolated sandboxed git worktree at the repository root. ` +
            `Objective: ${objective}\n\nResearch summary:\n${researchSummary || "(none)"}\n\nConfirmed direction:\n${directionNotes}\n\n` +
            `Full plan:\n${planText}\n\nAlready completed:\n${completedText}\n\n` +
            `Your current task: ${task.title} — ${task.description}\n\n` +
            `You have exactly one tool for doing work — run_shell_command — plus finish_task to end this task once it's ` +
            `fully implemented. Read files with cat, edit with heredocs or sed, run tests with the project's test command, ` +
            `check types, use git to inspect and commit your work.`,
        },
      ];

      let taskTurns = 0;
      let taskApproved = false;
      let taskSummary = "";

      for (let fixAttempt = 0; fixAttempt <= MAX_TASK_FIX_ATTEMPTS && !taskApproved; fixAttempt++) {
        let finishedSummary: string | null = null;

        while (finishedSummary === null) {
          if (taskTurns >= MAX_TASK_TURNS) break;
          taskTurns++;

          const response = await callNvidiaChat(nvidiaApiKey, messages, [RUN_SHELL_TOOL, FINISH_TASK_TOOL]);

          if (!response.toolCalls || response.toolCalls.length === 0) {
            messages.push({ role: "assistant", content: response.content });
            messages.push({
              role: "user",
              content: "Use run_shell_command to keep working, or finish_task if this task is complete.",
            });
            continue;
          }

          messages.push({ role: "assistant", content: response.content, tool_calls: response.toolCalls });

          for (const call of response.toolCalls) {
            if (call.function.name === "finish_task") {
              let summary = `Task "${task.title}" finished.`;
              try {
                const parsed = JSON.parse(call.function.arguments);
                if (typeof parsed.summary === "string" && parsed.summary.trim()) summary = parsed.summary;
              } catch {
                // Malformed arguments — fall back to the default summary.
              }
              finishedSummary = summary;
              messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ ok: true }) });
              continue;
            }

            if (call.function.name === "run_shell_command") {
              let command = "";
              try {
                const parsed = JSON.parse(call.function.arguments);
                command = typeof parsed.command === "string" ? parsed.command : "";
              } catch {
                messages.push({
                  role: "tool",
                  tool_call_id: call.id,
                  content: JSON.stringify({ error: "Malformed arguments — command must be valid JSON with a string 'command' field." }),
                });
                continue;
              }
              if (!command) {
                messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ error: "command was empty." }) });
                continue;
              }

              const result = await builderClient
                .execInWorkspace(buildRequestId, command)
                .catch((err: any) => ({ stdout: "", stderr: err.message || String(err), exitCode: -1 }));

              seq++;
              await recordTranscriptEvent(buildRequestId, seq, command, result.stdout, result.stderr, result.exitCode);

              messages.push({
                role: "tool",
                tool_call_id: call.id,
                content: JSON.stringify({
                  stdout: result.stdout.slice(0, 8000),
                  stderr: result.stderr.slice(0, 4000),
                  exitCode: result.exitCode,
                }),
              });
              continue;
            }

            messages.push({
              role: "tool",
              tool_call_id: call.id,
              content: JSON.stringify({ error: `Unknown tool: ${call.function.name}` }),
            });
          }
        }

        if (finishedSummary === null) {
          // Hit the turn cap without a finish_task call — same failure
          // class as exhausting fix attempts, handled below the loop.
          break;
        }

        const { files: taskFiles, skipped: taskSkipped } = await extractChangedFiles(buildRequestId, taskBaseSha);
        const verdict = await departments.reviewTaskDiff(task.title, task.description, taskFiles, groq);

        if (verdict.approved) {
          taskApproved = true;
          taskSummary =
            taskSkipped.length > 0
              ? `${finishedSummary}\n\n(Note: ${taskSkipped.length} changed path(s) could not be read back: ${taskSkipped.join(", ")})`
              : finishedSummary;
          await codingPlanTasksRepo.updateTaskStatus(buildRequestId, task.seq, "done", taskSummary);
        } else if (fixAttempt < MAX_TASK_FIX_ATTEMPTS) {
          await codingPlanTasksRepo.updateTaskStatus(buildRequestId, task.seq, "needs_fixes");
          messages.push({
            role: "user",
            content: `The review found issues with this task — please fix them and call finish_task again once resolved:\n\n${verdict.findings}`,
          });
        }
      }

      if (!taskApproved) {
        await codingPlanTasksRepo.updateTaskStatus(buildRequestId, task.seq, "failed");
        await builderClient.destroyWorkspace(buildRequestId).catch(() => {});
        return { ok: false, error: `Task "${task.title}" did not pass review after ${MAX_TASK_FIX_ATTEMPTS + 1} attempt(s).` };
      }

      completedSummaries.push(`- ${task.title}: ${taskSummary}`);
    }

    const { files, skipped } = await extractChangedFiles(buildRequestId, baseSha);
    if (files.length === 0) {
      await builderClient.destroyWorkspace(buildRequestId).catch(() => {});
      return { ok: false, error: "The coding session finished but left no changed files to propose." };
    }
    const summary =
      `${objective}\n\nCompleted tasks:\n${completedSummaries.join("\n")}` +
      (skipped.length > 0 ? `\n\n(Note: ${skipped.length} changed path(s) could not be read back: ${skipped.join(", ")})` : "");
    return { ok: true, summary, files };
  } catch (err: any) {
    observation.logTelemetry("warn", "Executive", `Coding agent loop failed for build request #${buildRequestId}: ${err.message}`);
    await builderClient.destroyWorkspace(buildRequestId).catch(() => {});
    return { ok: false, error: `The coding session failed: ${err.message}` };
  }
}

// One forced tool call asking the model to decompose the objective before
// any code gets written. Retries once with a corrective nudge on a missing
// or malformed call; returns null (triggering the flat-loop fallback in
// runCodingAgent) rather than failing the whole build request if planning
// itself can't produce a usable list.
async function proposePlan(
  nvidiaApiKey: string,
  objective: string,
  researchSummary: string,
  directionNotes: string
): Promise<PlannedTaskInput[] | null> {
  const messages: NvidiaMessage[] = [
    {
      role: "system",
      content:
        `You are Jarvis's coding agent. Before writing any code, break the following objective down into an ordered ` +
        `list of small, self-contained tasks (at most ${MAX_PLAN_TASKS}). Call propose_plan exactly once with the full list.\n\n` +
        `Objective: ${objective}\n\nResearch summary:\n${researchSummary || "(none)"}\n\nConfirmed direction:\n${directionNotes}`,
    },
  ];

  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await callNvidiaChat(nvidiaApiKey, messages, [PROPOSE_PLAN_TOOL]);
    const call = response.toolCalls?.find((c) => c.function.name === "propose_plan");

    if (call) {
      try {
        const parsed = JSON.parse(call.function.arguments);
        const rawTasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
        const tasks: PlannedTaskInput[] = rawTasks
          .filter(
            (t: any) =>
              typeof t.title === "string" && t.title.trim() && typeof t.description === "string" && t.description.trim()
          )
          .map((t: any, i: number) => ({ seq: i + 1, title: t.title, description: t.description }));

        if (tasks.length > 0 && tasks.length <= MAX_PLAN_TASKS) {
          return tasks;
        }
      } catch {
        // Malformed arguments — fall through to the retry nudge below.
      }
    }

    messages.push({ role: "assistant", content: response.content, tool_calls: response.toolCalls || undefined });
    messages.push({
      role: "user",
      content: `That didn't produce a usable plan. Call propose_plan exactly once with a "tasks" array of 1-${MAX_PLAN_TASKS} items, each with a "title" and "description".`,
    });
  }

  return null;
}

// The pre-Plan-3 behavior, unchanged: one continuous conversation covering
// the whole objective in a single pass, no task decomposition, no
// per-task review. Kept as a safety net for when the planning phase itself
// can't produce a usable task list, so planning failures degrade to
// "today's known-working behavior" rather than failing the build request.
async function runFlatCodingLoop(
  buildRequestId: number,
  objective: string,
  researchSummary: string,
  directionNotes: string,
  baseSha: string,
  nvidiaApiKey: string
): Promise<CodingAgentResult> {
  const messages: NvidiaMessage[] = [
    {
      role: "system",
      content:
        `You are Jarvis's coding agent, working alone in an isolated sandboxed git worktree at the repository root. ` +
        `Objective: ${objective}\n\nResearch summary:\n${researchSummary || "(none)"}\n\nConfirmed direction:\n${directionNotes}\n\n` +
        `You have exactly one tool for doing work — run_shell_command — plus finish_coding to end the session. ` +
        `Read files with cat, edit with heredocs or sed, run tests with the project's test command, check types, use git to ` +
        `inspect and commit your work. Call finish_coding once the objective is fully implemented and verified.`,
    },
  ];

  let seq = 0;

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const response = await callNvidiaChat(nvidiaApiKey, messages, [RUN_SHELL_TOOL, FINISH_CODING_TOOL]);

      if (!response.toolCalls || response.toolCalls.length === 0) {
        messages.push({ role: "assistant", content: response.content });
        messages.push({
          role: "user",
          content: "Use run_shell_command to keep working, or finish_coding if the objective is complete.",
        });
        continue;
      }

      messages.push({ role: "assistant", content: response.content, tool_calls: response.toolCalls });

      let finishedSummary: string | null = null;

      for (const call of response.toolCalls) {
        if (call.function.name === "finish_coding") {
          let summary = "Coding session finished.";
          try {
            const parsed = JSON.parse(call.function.arguments);
            if (typeof parsed.summary === "string" && parsed.summary.trim()) summary = parsed.summary;
          } catch {
            // Malformed arguments — fall back to the default summary rather than failing the whole session.
          }
          finishedSummary = summary;
          messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ ok: true }) });
          continue;
        }

        if (call.function.name === "run_shell_command") {
          let command = "";
          try {
            const parsed = JSON.parse(call.function.arguments);
            command = typeof parsed.command === "string" ? parsed.command : "";
          } catch {
            messages.push({
              role: "tool",
              tool_call_id: call.id,
              content: JSON.stringify({ error: "Malformed arguments — command must be valid JSON with a string 'command' field." }),
            });
            continue;
          }
          if (!command) {
            messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ error: "command was empty." }) });
            continue;
          }

          const result = await builderClient
            .execInWorkspace(buildRequestId, command)
            .catch((err: any) => ({ stdout: "", stderr: err.message || String(err), exitCode: -1 }));

          seq++;
          await recordTranscriptEvent(buildRequestId, seq, command, result.stdout, result.stderr, result.exitCode);

          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: JSON.stringify({
              stdout: result.stdout.slice(0, 8000),
              stderr: result.stderr.slice(0, 4000),
              exitCode: result.exitCode,
            }),
          });
          continue;
        }

        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ error: `Unknown tool: ${call.function.name}` }) });
      }

      if (finishedSummary !== null) {
        const { files, skipped } = await extractChangedFiles(buildRequestId, baseSha);
        if (files.length === 0) {
          await builderClient.destroyWorkspace(buildRequestId).catch(() => {});
          return { ok: false, error: "The coding session finished but left no changed files to propose." };
        }
        const summary =
          skipped.length > 0
            ? `${finishedSummary}\n\n(Note: ${skipped.length} changed path(s) could not be read back and are not included in this proposal — likely deletions or unusual filenames: ${skipped.join(", ")})`
            : finishedSummary;
        return { ok: true, summary, files };
      }
    }

    await builderClient.destroyWorkspace(buildRequestId).catch(() => {});
    return { ok: false, error: `The coding session hit its ${MAX_TURNS}-turn limit without calling finish_coding.` };
  } catch (err: any) {
    observation.logTelemetry("warn", "Executive", `Coding agent loop failed for build request #${buildRequestId}: ${err.message}`);
    await builderClient.destroyWorkspace(buildRequestId).catch(() => {});
    return { ok: false, error: `The coding session failed: ${err.message}` };
  }
}

// Reads back whatever the agent actually left on disk (committed or not) by
// diffing the working tree against the commit the sandbox started from — the
// worktree, not any model-recalled text, is the source of truth for what
// gets proposed at the approval checkpoint. Paths the diff names but `cat`
// can't read back (deletions, git's C-quoted non-ASCII filenames, binaries)
// are returned separately as `skipped` rather than silently dropped or
// thrown over: deletions are a normal part of a coding session, so failing
// the whole session over one would be worse than proposing the rest — but
// the human at the approval gate still has to be told something was left
// out. The caller passes either a task-scoped SHA (captured right before
// that task's loop starts) or the session's original baseSha for the final
// cumulative extraction — a plain commit SHA resolved from inside the
// sandbox itself, immune to any ref-mapping quirk between the sandbox's
// clone and the host repo. `git add -A` stages new files first so untracked
// additions show up in the diff, not just modifications to already-tracked
// files.
async function extractChangedFiles(
  buildRequestId: number,
  baseSha: string
): Promise<{ files: DraftedFile[]; skipped: string[] }> {
  const addResult = await builderClient.execInWorkspace(buildRequestId, "git add -A");
  if (addResult.exitCode !== 0) {
    throw new Error(`git add -A failed: ${addResult.stderr}`);
  }

  const diffResult = await builderClient.execInWorkspace(buildRequestId, `git diff --name-only ${baseSha}`);
  if (diffResult.exitCode !== 0) {
    throw new Error(`git diff failed: ${diffResult.stderr}`);
  }
  const paths = diffResult.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const files: DraftedFile[] = [];
  const skipped: string[] = [];
  for (const path of paths) {
    const catResult = await builderClient.execInWorkspace(buildRequestId, `cat "${path}"`);
    if (catResult.exitCode === 0) {
      files.push({ path, content: catResult.stdout });
    } else {
      skipped.push(path);
    }
  }
  return { files, skipped };
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 3: Run the tests**

Run: `npm test`
Expected: 115/115 passing (unchanged from Task 2 — this file has no automated tests of its own, matching this codebase's Docker/NVIDIA-orchestration precedent).

- [ ] **Step 4: Commit**

```bash
git add src/executive/coding-agent.ts
git commit -m "feat: plan-first, per-task-reviewed coding loop with a flat-loop fallback"
```

---

### Task 4: Wire the new `groq` parameter into the caller, add plan visibility

**Files:**
- Modify: `src/executive/autonomous_executive.ts` (pass `this.groq` as `runCodingAgent`'s new 7th argument)
- Modify: `src/server.ts` (add `GET /api/system/build-requests/:id/plan`)
- Modify: `src/interaction/static/index.html` (add the plan panel + "View plan" button)

**Interfaces:**
- Consumes: `listPlanTasks` from Task 1's `coding-plan-tasks-repo.js`. Consumes `runCodingAgent`'s new signature from Task 3.

- [ ] **Step 1: Pass `groq` into `runCodingAgent`**

In `src/executive/autonomous_executive.ts`, find the `codingAgent.runCodingAgent(...)` call inside `confirmDirection` (added by PR #86):

```ts
    const draft = await codingAgent.runCodingAgent(
      confirmed.id,
      confirmed.objective,
      confirmed.research_summary || "",
      directionNotes,
      baseBranch,
      this.nvidiaApiKey
    );
```

Replace with (one new trailing argument, `this.groq` — the class already has this field from before PR #86):

```ts
    const draft = await codingAgent.runCodingAgent(
      confirmed.id,
      confirmed.objective,
      confirmed.research_summary || "",
      directionNotes,
      baseBranch,
      this.nvidiaApiKey,
      this.groq
    );
```

- [ ] **Step 2: Add the plan route**

In `src/server.ts`, add this import alongside the existing `transcriptEventsRepo` import:

```ts
import * as codingPlanTasksRepo from "./kernel/state/coding-plan-tasks-repo.js";
```

Find the existing transcript route:

```ts
app.get("/api/system/build-requests/:id/transcript", validateApiKey, async (req: any, res: any) => {
  if (!permissions.hasGrant(req.username, "github.pulls.create")) {
    return res.status(403).json({ error: 'Missing capability grant "github.pulls.create"' });
  }
  try {
    res.json({ events: await transcriptEventsRepo.listTranscriptEvents(Number(req.params.id)) });
  } catch (err: any) {
    res.json({ events: [], error: err.message });
  }
});
```

Add directly after it:

```ts
app.get("/api/system/build-requests/:id/plan", validateApiKey, async (req: any, res: any) => {
  if (!permissions.hasGrant(req.username, "github.pulls.create")) {
    return res.status(403).json({ error: 'Missing capability grant "github.pulls.create"' });
  }
  try {
    res.json({ tasks: await codingPlanTasksRepo.listPlanTasks(Number(req.params.id)) });
  } catch (err: any) {
    res.json({ tasks: [], error: err.message });
  }
});
```

- [ ] **Step 3: Add the plan panel to `index.html`**

Find the transcript panel (right after the build-requests panel):

```html
                <div id="build-request-transcript-panel" class="holo-panel rounded-2xl p-5 w-full hidden">
                    <div class="flex justify-between items-center mb-4">
                        <h3 class="font-display font-semibold text-sm text-white">Activity — <span id="build-request-transcript-title"></span></h3>
                        <button onclick="closeBuildRequestTranscript()" class="px-2 py-0.5 rounded-full bg-white/5 border border-white/10 text-[11px] text-secondary hover:text-white">Close</button>
                    </div>
                    <div id="build-request-transcript-body" class="space-y-2 max-h-[480px] overflow-y-auto font-mono text-[11px]"></div>
                </div>
```

Add a second, initially-hidden panel right after it (still inside the same parent):

```html
                <div id="build-request-transcript-panel" class="holo-panel rounded-2xl p-5 w-full hidden">
                    <div class="flex justify-between items-center mb-4">
                        <h3 class="font-display font-semibold text-sm text-white">Activity — <span id="build-request-transcript-title"></span></h3>
                        <button onclick="closeBuildRequestTranscript()" class="px-2 py-0.5 rounded-full bg-white/5 border border-white/10 text-[11px] text-secondary hover:text-white">Close</button>
                    </div>
                    <div id="build-request-transcript-body" class="space-y-2 max-h-[480px] overflow-y-auto font-mono text-[11px]"></div>
                </div>
                <div id="build-request-plan-panel" class="holo-panel rounded-2xl p-5 w-full hidden">
                    <div class="flex justify-between items-center mb-4">
                        <h3 class="font-display font-semibold text-sm text-white">Plan — <span id="build-request-plan-title"></span></h3>
                        <button onclick="closeBuildRequestPlan()" class="px-2 py-0.5 rounded-full bg-white/5 border border-white/10 text-[11px] text-secondary hover:text-white">Close</button>
                    </div>
                    <div id="build-request-plan-body" class="space-y-2 max-h-[480px] overflow-y-auto font-mono text-[11px]"></div>
                </div>
```

- [ ] **Step 4: Add the "View plan" button and its fetch/render/close functions**

Find the "View activity" button inside `loadBuildRequests`'s card template:

```html
                        <button onclick="viewBuildRequestActivity(${r.id})" class="text-[10px] text-primary underline block mt-1.5">View activity &rarr;</button>
```

Add a second button directly after it, in the same template literal:

```html
                        <button onclick="viewBuildRequestActivity(${r.id})" class="text-[10px] text-primary underline block mt-1.5">View activity &rarr;</button>
                        <button onclick="viewBuildRequestPlan(${r.id})" class="text-[10px] text-primary underline block mt-0.5">View plan &rarr;</button>
```

Find `closeBuildRequestTranscript`:

```js
    function closeBuildRequestTranscript() {
        document.getElementById('build-request-transcript-panel').classList.add('hidden');
    }
```

Add directly after it (a status-style lookup, the fetch/render function mirroring `viewBuildRequestActivity`'s structure, and its close function):

```js
    function closeBuildRequestTranscript() {
        document.getElementById('build-request-transcript-panel').classList.add('hidden');
    }

    const PLAN_TASK_STATUS_STYLE = {
        pending: 'border-white/10 text-secondary bg-white/5',
        in_progress: 'border-primary/25 text-primary bg-primary/5',
        needs_fixes: 'border-warning/25 text-warning bg-warning/5',
        done: 'border-success/25 text-success bg-success/5',
        failed: 'border-danger/25 text-danger bg-danger/5',
    };

    async function viewBuildRequestPlan(id) {
        if (!CURRENT_API_KEY) return;
        const panel = document.getElementById('build-request-plan-panel');
        const title = document.getElementById('build-request-plan-title');
        const body = document.getElementById('build-request-plan-body');
        const cached = BUILD_REQUESTS_CACHE.find(r => r.id === id);
        title.textContent = cached ? `#${id} — ${cached.objective}` : `#${id}`;
        body.innerHTML = `<div class="text-secondary text-xs opacity-60">Loading...</div>`;
        panel.classList.remove('hidden');
        panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        try {
            const headers = { 'X-API-Key': CURRENT_API_KEY };
            const res = await authFetch(`/api/system/build-requests/${id}/plan`, { headers });
            const data = await res.json();
            const tasks = data.tasks || [];
            if (tasks.length === 0) {
                body.innerHTML = `<div class="text-secondary text-xs opacity-60">No plan recorded yet.</div>`;
                return;
            }
            body.innerHTML = tasks.map(t => {
                const style = PLAN_TASK_STATUS_STYLE[t.status] || PLAN_TASK_STATUS_STYLE.pending;
                return `
                    <div class="holo-chip border ${style.split(' ')[0]} rounded-lg p-2.5">
                        <div class="flex items-center justify-between mb-1">
                            <span class="text-white">${t.seq}. ${escapeHtml(t.title)}</span>
                            <span class="px-1.5 py-0.5 rounded border text-[9px] font-bold uppercase tracking-widest ${style}">${escapeHtml(t.status)}</span>
                        </div>
                        <p class="text-text/70">${escapeHtml(t.description)}</p>
                        ${t.summary ? `<p class="text-secondary mt-1">${escapeHtml(t.summary)}</p>` : ''}
                    </div>
                `;
            }).join('');
        } catch {
            body.innerHTML = `<div class="text-danger text-xs">Failed to load plan.</div>`;
        }
    }

    function closeBuildRequestPlan() {
        document.getElementById('build-request-plan-panel').classList.add('hidden');
    }
```

- [ ] **Step 5: Typecheck**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 6: Run the tests**

Run: `npm test`
Expected: 115/115 passing (unchanged — this task touches no test-covered logic).

- [ ] **Step 7: Commit**

```bash
git add src/executive/autonomous_executive.ts src/server.ts src/interaction/static/index.html
git commit -m "feat: wire groq into the coding loop, add the plan visibility route and dashboard panel"
```

---

## Final Verification (manual, against a real running instance — not automatable)

Same situation as PR #86: the plan phase, task execution, and review loop all depend entirely on live external systems (a real Docker daemon via `jarvis-builder`, a real NVIDIA API key, real Groq calls) that no subagent in this workflow has access to. After all 4 tasks are reviewed and merged to this branch:

1. Trigger a real build request through to `direction_confirmed` and confirm: `propose_plan` gets called and produces a sane task list, `coding_plan_tasks` rows are created (check `GET /api/system/build-requests/:id/plan`), each task runs in what's genuinely a fresh conversation (verify via the transcript panel that command sequences per task look coherent, not confused by unrelated earlier-task history), and `reviewTaskDiff` verdicts are actually gating (deliberately confirm a task that fails review gets a real fix-retry, not just moving on).
2. Confirm the plan-phase fallback actually works: this is hard to trigger deliberately with a well-behaved model, but watch logs for the `Cognition`-tagged fallback path if it occurs during other testing, and confirm the build request still completes successfully via `runFlatCodingLoop` rather than erroring.
3. Confirm the final cumulative `extractChangedFiles` call still produces the same correct result as PR #86's single-task version (real PR opens from the real on-disk diff, `awaiting_code_approval`'s file-list panel still renders correctly).
4. Watch real cost/latency: this plan meaningfully increases the number of LLM calls per build request (a plan call, plus a fresh context + a Groq review per task, versus one flat loop) — note whether `MAX_PLAN_TASKS`/`MAX_TASK_TURNS` need retuning in practice.
5. Confirm workspace teardown still happens exactly once on every new exit path this plan adds (task-turn-cap failure, task-review-exhausted failure, plan-phase's own workspace-untouched-so-no-double-destroy-needed path).
