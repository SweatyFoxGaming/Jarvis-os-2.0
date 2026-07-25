# Structured Coding Loop (Plan → Execute → Review) — Design Spec

**Status:** approved by user via brainstorming dialogue (2026-07-25)

**Builds on:** `feat/agentic-coding-department-loop` (PR #86, draft, not yet merged) — this feature is a follow-on to that branch, since it directly modifies `src/executive/coding-agent.ts` which that PR introduces. The implementation branch for this spec should be based on PR #86's branch, not `origin/main`, and will need rebasing once #86 merges.

## Problem

Jarvis's coding agent (`src/executive/coding-agent.ts`, from PR #86) is a single flat loop: one system prompt, one continuous NVIDIA conversation, up to 40 turns of `run_shell_command`, then `finish_coding`. There is no internal planning step, no task decomposition, and no self-review before the agent hands its work to the human approval gate. This means the agent can go down wrong paths, miss steps, or declare itself "done" prematurely, with nothing catching it until either the mechanical final-verification gate (`npm ci && npm test && npx tsc --noEmit`, which only checks that things run, not that the approach was sound) or the human's own read of the diff.

The goal is to bring the same discipline Claude Code's own workflow uses — plan first, execute task-by-task with isolated context per task, review before moving on — into Jarvis's own coding agent, adapted to the fact that Jarvis has one model working alone in one sandbox, not a controller dispatching real parallel subagents.

## Non-goals

- No change to the two existing human checkpoints (direction confirmation, then approve/reject at `awaiting_code_approval`). This feature adds no new checkpoint — it operates entirely between those two, using only what's already been gathered (`research_summary`, `direction_notes`).
- No change to `approve-code`'s existing final-verification gate (fresh `npm ci`/`npm test`/`npx tsc --noEmit`) — that stays exactly as PR #86 built it. This feature adds an earlier, LLM-judged quality gate; it doesn't replace the later mechanical one.
- No change to `reviewCodeDiff` (`departments.ts:261`) or its existing post-PR QA behavior — a new sibling function is added instead of modifying it.
- No literal parallelism — task execution stays sequential (one sandbox, one worktree, tasks likely depend on each other in order).

## Architecture

```
createWorkspace + capture baseSha            (unchanged from PR #86)
        │
        ▼
   PLAN PHASE ──fails after 1 retry──► fall back to today's flat loop
        │ succeeds                        (kept intact, unchanged, as a
        ▼                                  safety net — see Fallback below)
   for each task in the plan, in order:
        │
        ├─► fresh NVIDIA context for this task
        │     (plan + prior tasks' one-line summaries + this task's brief)
        ├─► run_shell_command / finish_task loop (bounded turns)
        ├─► capture taskBaseSha at task start; extract this task's diff
        │     (files changed since taskBaseSha, not since session start)
        ├─► reviewTaskDiff (new, Groq-based, structured verdict)
        │       ├─ approved → mark task done, move to next task
        │       └─ not approved → feed findings back into the SAME task's
        │          context (it already has the relevant history), retry.
        │          Up to 2 additional fix rounds (3 attempts total). Still
        │          failing after that → mark task failed, mark the whole
        │          build request 'error' (markCodeDraftError), destroy
        │          workspace, stop.
        ▼
   all tasks done → extract cumulative diff (today's extractChangedFiles,
   against the original baseSha, unchanged) → {ok:true, summary, files}
   exactly as PR #86 already returns today
```

## Plan generation

One NVIDIA call, reusing the existing tool-calling infrastructure (`nvidia-client.ts` needs no changes — no new "JSON mode" required). The model is given a single tool and required to call it exactly once:

```ts
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
```

System prompt: same inputs as today's flat loop (objective, research summary, confirmed direction) plus instructions to decompose into small, ordered, self-contained tasks.

**Bounds:** `MAX_PLAN_TASKS = 10` — rejects (triggers a retry) a plan with zero tasks or more than 10.

**Failure handling:** if the model doesn't call `propose_plan`, calls it with unparseable arguments, or produces an invalid task list (0 or >10 tasks) — one retry with an explicit corrective nudge appended to the conversation. If that also fails: fall back to running the *entire objective* through today's existing flat-loop code path (kept as a private function, e.g. `runFlatCodingLoop`, extracted from PR #86's current `runCodingAgent` body essentially unchanged) rather than failing the build request outright. This preserves PR #86's exact current behavior as a safety net — planning is meant to *improve* reliability, not become a new single point of failure for every build.

## Task execution

**Fresh context per task:** each task gets its own `NvidiaMessage[]` (not the whole session's history). System prompt for task *N*:
- Objective, research summary, confirmed direction (same as today)
- The full plan (task list), so the model knows what's already done and what's still coming
- A one-line summary of each already-completed task (not full transcripts)
- This task's own title + description as the immediate focus

**Tools:** `run_shell_command` (unchanged from today) plus `finish_task` (new — signals *this task* is done, distinct from the whole-session `finish_coding` used only in the flat-loop fallback path):

```ts
const FINISH_TASK_TOOL: NvidiaTool = {
  type: "function",
  function: {
    name: "finish_task",
    description: "Call this once this specific task is fully implemented and ready for review.",
    parameters: {
      type: "object",
      properties: { summary: { type: "string", description: "A concise summary of what this task changed." } },
      required: ["summary"],
      additionalProperties: false,
    },
  },
};
```

**Task-scoped diff extraction:** capture `taskBaseSha` via `git rev-parse HEAD` (same pattern PR #86 already uses for the session-level `baseSha`) immediately before each task's loop starts. The task's diff for review is computed against `taskBaseSha`, not the original session `baseSha` — keeping review genuinely task-scoped. The existing `extractChangedFiles` helper is reused for this (it already takes a SHA parameter), called once per task against `taskBaseSha`, and once more at the very end against the original `baseSha` for the final cumulative result.

**Turn budget:** `MAX_TASK_TURNS = 30` per task, covering the initial attempt plus both fix-retry rounds combined (simpler to reason about than separate budgets per attempt). Hitting this cap without a `finish_task` call is treated the same as a failed review that's exhausted its retries: mark the task `failed`, mark the build request `error`, destroy the workspace, stop.

**Status transitions:** a task row moves `pending` → `in_progress` the moment its context is created and its loop starts (before the first `run_shell_command`/`finish_task` call), then to `done`, `needs_fixes`, or `failed` per the fix-loop below.

## Review + fix-loop

**New function**, `departments.ts`:

```ts
export async function reviewTaskDiff(
  taskTitle: string,
  taskDescription: string,
  files: DraftedFile[],
  groq: Groq | null
): Promise<{ approved: boolean; findings: string }>
```

Same provider (Groq) and independent-judge spirit as the existing `reviewCodeDiff`, but returns a structured verdict via `response_format`/`toGroqSchema` (the same pattern already used for `DEPARTMENT_DECOMPOSITION_SCHEMA`/`RESEARCH_LOOKUPS_SCHEMA` in this same file), not prose — because this verdict has to drive a programmatic retry/continue decision, not just be shown to a human. Degrades the same way `reviewCodeDiff` does when `groq` is null: `{approved: true, findings: "No capable model was available to review this task — proceeding without review."}` (fails open rather than blocking every build when Groq is unavailable, consistent with this codebase's existing degrade-cleanly philosophy for optional quality gates).

Reviews the task-scoped diff against *that task's own* title/description — not the whole build request's objective — matching "task-scoped gate, not a merge review."

**Fix-loop:**
1. Task's loop runs, calls `finish_task`.
2. Extract task-scoped diff (`extractChangedFiles(id, taskBaseSha)`) → `reviewTaskDiff`.
3. `approved: true` → update the task row to `done` with its summary, move to next task.
4. `approved: false` → append `findings` as a new user message into the *same* task's existing context (it already has the relevant history — no need for a fresh context on retry), nudge it to fix and call `finish_task` again. Update task row to `needs_fixes`.
5. Up to 2 additional fix-and-retry rounds after the initial attempt (3 total implementation attempts per task: 1 initial + 2 fix retries). Still not approved after the 3rd: mark task `failed`, call `markCodeDraftError` on the build request, destroy the workspace (`.catch(() => {})`, matching PR #86's existing teardown convention), return `{ok: false, error: ...}`.

## Data model + dashboard

New table, mirroring `transcript_events`'s shape and precedent (`db.ts`, plain `CREATE TABLE IF NOT EXISTS` inside `createSchema()`):

```sql
CREATE TABLE IF NOT EXISTS coding_plan_tasks (
  id SERIAL PRIMARY KEY,
  build_request_id INTEGER NOT NULL REFERENCES build_requests(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | in_progress | needs_fixes | done | failed
  summary TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_coding_plan_tasks_build_request ON coding_plan_tasks(build_request_id, seq);
```

New repo module `src/kernel/state/coding-plan-tasks-repo.ts`, degrade-cleanly (try/catch, null/[]/void on failure), mirroring `transcript-events-repo.ts`:
- `createPlan(buildRequestId, tasks: {title, description}[]): Promise<void>` — bulk-inserts all rows as `pending` in one call, right after the plan phase succeeds.
- `updateTaskStatus(id, status, summary?): Promise<void>` — called at each status transition.
- `listPlanTasks(buildRequestId): Promise<PlanTaskRow[]>` — for the dashboard route.

New route (mirrors the existing transcript route exactly — same auth/grant pattern):
```
GET /api/system/build-requests/:id/plan
```

Dashboard: a "View plan" button + panel alongside the existing "View activity" transcript panel on each build-request card, rendering the task list with status badges (pending/in-progress/needs-fixes/done/failed), same visual conventions as the existing transcript panel (`escapeHtml`, `holo-chip` styling).

## Fallback + error handling summary

| Failure point | Behavior |
|---|---|
| Planning fails twice | Fall back to the unchanged flat loop for the whole objective (today's PR #86 behavior, unmodified) |
| A task hits `MAX_TASK_TURNS` without `finish_task` | Same as exhausting fix-loop retries: task `failed`, build request `error`, workspace destroyed |
| A task's review still fails after 2 fix attempts | Task `failed`, build request `error`, workspace destroyed |
| `reviewTaskDiff` has no Groq client | Fails open (`approved: true`) — doesn't block every build when Groq is unavailable |

## Global constraints (carried forward from PR #86, still binding)

- No new `BuildRequestStatus` values — the `'error'` status already exists and is reused for every failure path here.
- Still exactly two human checkpoints — no new checkpoint added by this feature.
- No secrets/GitHub credentials reach the sandbox — unchanged; this feature doesn't touch workspace creation or secret handling.
- Each execution context (plan phase, and each task) still gets exactly one *work* tool (`run_shell_command`) — `propose_plan` and `finish_task` are signal/output tools, matching `finish_coding`'s existing precedent, not additional work tools.
- NVIDIA NIM stays isolated to the coding loop (plan phase + task execution); Groq stays isolated to review (`reviewTaskDiff`, `reviewCodeDiff`) — no new cross-provider contamination.
- `npm test`/`tsc --noEmit` must stay green throughout.

## Testing

Following this codebase's established convention (no unit tests for Docker/NVIDIA-dependent orchestration; genuinely pure logic gets normal tests):
- `coding-plan-tasks-repo.ts` gets degrade-cleanly unit tests, mirroring `transcript-events-repo.ts`'s 2 tests.
- `reviewTaskDiff`'s no-Groq-client degrade path gets a unit test, mirroring `reviewCodeDiff`'s existing one.
- The plan-generation/task-execution orchestration itself (the rewritten `runCodingAgent` body) gets no automated tests — same as PR #86's `coding-agent.ts` today. Verified live, against a real running instance, same precedent as PR #86's own Final Verification section.

## Open items for live verification (not automatable, same as PR #86)

1. Does the NVIDIA model reliably call `propose_plan` and `finish_task` as required, or does it need stronger prompting/retries in practice beyond what's designed here?
2. Real cost/latency impact of per-task fresh contexts + per-task Groq review calls — this meaningfully increases the number of LLM calls per build request compared to PR #86's single flat loop.
3. Whether `MAX_PLAN_TASKS = 10` and `MAX_TASK_TURNS = 30` are well-calibrated bounds in practice.
