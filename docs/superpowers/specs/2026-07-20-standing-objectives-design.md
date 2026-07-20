# Standing objectives (roadmap Phase 2)

## Goal

Jarvis's memory today is memory of *conversations* — a goal like "help me
train for a marathon by October" is forgotten the moment the conversation
ends unless the user brings it up again. This closes that gap: a standing
objective that persists across sessions and gets proactively checked in on
via the existing hourly briefing job, without needing a new UI surface or
scheduling subsystem. Approved via brainstorming (see conversation for the
full Q&A this spec is built from).

## Scope decisions made during brainstorming

- **Creation**: a chat tool Gemini calls (`set_objective`), not a dashboard
  panel — no new UI surface.
- **Check-in timing**: folded into the existing hourly briefing job
  (`src/execution/scheduler.ts`'s `startBriefingJob`), not a new
  per-objective schedule.
- **Completion**: explicit only, via a chat tool
  (`update_objective_status`) — no auto-expiry past a target date. An
  objective with a passed target date simply keeps surfacing in check-ins
  until the user says it's done or to drop it.
- **Visibility**: a `list_objectives` tool, since there's no dashboard to
  glance at otherwise.
- **Gating**: capability-gated like every other tool that writes lasting
  state (GitHub, email, calendar) — `display_content` is the one
  intentional exception, and it's ungated specifically because it has zero
  lasting effect, which doesn't apply here.

## Data model

New table, created the same way every other table in `src/data/db.ts` is
(a `CREATE TABLE IF NOT EXISTS` in `createSchema()`):

```sql
CREATE TABLE IF NOT EXISTS objectives (
  id SERIAL PRIMARY KEY,
  username TEXT NOT NULL,
  description TEXT NOT NULL,
  target_date DATE,
  status TEXT NOT NULL DEFAULT 'active', -- 'active' | 'completed' | 'abandoned'
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_checked_at TIMESTAMPTZ
);
```

`last_checked_at` is the durability mechanism for "don't re-notify about
the same goal every single hour" — deliberately a DB column, not the
in-memory `seenBriefingItemIds` Set `startBriefingJob` already uses for
email/GitHub novelty tracking. That in-memory set resets to empty on every
container restart, which is fine for email/GitHub (an unread email is
still unread after a restart, so it correctly gets treated as "new" again
briefly, then re-settles) — but would be wrong for objectives, where a
restart shouldn't immediately re-surface every active goal. `last_checked_at`
survives restarts because Postgres does.

## Components

**`src/execution/objectives.ts`** (new, mirrors `briefing.ts`'s shape):
- `createObjective(username, description, targetDate?): Promise<{id: number}>`
- `listActiveObjectives(username): Promise<ObjectiveRow[]>` — `status = 'active'`, ordered by `target_date NULLS LAST, created_at`.
- `updateObjectiveStatus(username, id, status: 'completed' | 'abandoned'): Promise<boolean>` — returns whether a row was actually updated (false if the id doesn't belong to that username, so one user can never touch another's objective by guessing an id).
- `collectDueObjectives(username): Promise<ObjectiveRow[]>` — active objectives where `last_checked_at IS NULL OR last_checked_at < now() - interval '3 days'`, OR `target_date` is within the next 3 days regardless of `last_checked_at` (a looming deadline should surface even if it was mentioned recently). This is the function the briefing job's signal collection calls — see below.
- `markCheckedIn(ids: number[]): Promise<void>` — sets `last_checked_at = now()` for the given ids. Called by the scheduler job after a briefing that included them actually goes out, not by `collectDueObjectives` itself (collection stays read-only, matching `briefing.ts`'s own "best-effort, read-only" collection philosophy).

**`src/data/db.ts`**: add the `objectives` table to `createSchema()`.

**`src/execution/permissions.ts`**: add `"objectives.read"` and
`"objectives.write"` to `ALL_CAPABILITIES` (auto-grants admin, backfills
existing installs — already proven for `executive.plan` and `screen.view`).

**`src/execution/tools.ts`**:
- `PERMISSION_BY_TOOL`: `set_objective` → `objectives.write`, `list_objectives` → `objectives.read`, `update_objective_status` → `objectives.write`.
- Three new `TOOL_DECLARATIONS` entries, matching the existing style (see `calendar_create_event`/`calendar_list_events` for the closest precedent — a paired read/write tool set on one resource).
- Three new `executeTool` cases, each a thin call into `objectives.ts`.
- `TOOL_TRIGGER_WORDS`: phrases like "help me", "my goal", "track this", "I want to accomplish" for `set_objective`; "what am I tracking", "my goals" for `list_objectives`.

**`src/execution/briefing.ts`**:
- `PrioritizedItem.source` gains `"objective"` alongside `"email" | "github"`.
- `RawSignals` gains `objectives: ObjectiveRow[]` and `objectivesError?: string`.
- `collectSignals()` calls `objectives.collectDueObjectives(username)` alongside the existing email/GitHub calls — same try/catch-and-continue pattern, one source failing never blocks another. This means `collectSignals()`/`generateBriefing()` need a `username` parameter now (today they're called with no user context, since email/GitHub are single-account-wide) — passed through from the scheduler job, which already knows it's operating for `"admin"` (the sole current user, per the existing `pushNotification("admin", ...)` call). The `get_briefing` chat tool's `executeTool` case (`src/execution/tools.ts`, `briefing.generateBriefing(briefing.getConfiguredAi())`) is the one other caller and needs the same one-line update — it already has `username` in scope as `executeTool`'s own parameter.
- `prioritizeSignals()` scores an objective `"high"` if `target_date` is within 3 days or has passed, `"medium"` otherwise.

**`src/execution/scheduler.ts`**: `startBriefingJob` calls
`objectives.markCheckedIn(ids)` for any `source === "objective"` items in
`result.items` after generating the briefing — mirrors the existing
`briefingRepo.saveBriefing(...)` call as a distinct, explicit write step
right after generation, not hidden inside collection.

## Error handling

Every new piece follows patterns already established in this exact
codebase: a Postgres failure in any `objectives.ts` function returns a
clear error string to Gemini (matching every other tool's
`{ok: false, error: ...}` shape) rather than throwing past `executeTool`'s
existing try/catch. `collectDueObjectives` failing inside `collectSignals()`
degrades to an empty objectives list plus `objectivesError`, exactly like
an email/GitHub failure does today — the briefing still generates from
whatever sources succeeded.

## Testing

- Automated (`tests/index.test.ts`, no live Gemini/Postgres needed beyond
  what's already gracefully degraded in existing tests):
  - `update_objective_status` denies without `objectives.write` grant (mirrors the existing "executeTool denies calls without a grant" test).
  - `prioritizeSignals()` scores an objective with a near `target_date` as `"high"`, and a distant one as `"medium"` — pure function, no DB needed if the test constructs a `RawSignals` object directly rather than going through `collectSignals()`.
  - `updateObjectiveStatus` returns `false` (not an error, just no-op) when the id belongs to a different username — the one real security-relevant behavior worth locking in with a test, using the same "degrade cleanly when Postgres isn't reachable" pattern the existing memory/identity tests already use for DB-dependent code running without a live Postgres.
- Manual/live (matching how `startBriefingJob` itself was originally verified, no automated test framework wraps the scheduler's actual timer behavior): create a real objective via chat, confirm it persists across a container restart, confirm it surfaces in a real briefing run when `last_checked_at` is stale or `target_date` is close, confirm `update_objective_status` (via `list_objectives` then the update call in the same turn) actually removes it from future check-ins.

## Out of scope (this pass)

- Auto-expiry past `target_date` — explicitly ruled out during brainstorming; an overdue objective just keeps surfacing until the user acts on it.
- A dashboard panel for objectives — chat-only creation/listing/completion for this pass.
- Per-objective custom check-in cadence — every objective uses the same 3-day staleness window and the same 3-day target-date lookahead; no per-objective configuration.
