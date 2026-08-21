# Outcome Ledger — Design Spec

**Status:** approved design, ready for implementation plan
**Phase:** Verified Autonomy roadmap ([docs/architecture/AUTONOMY_VISION.md](../../architecture/AUTONOMY_VISION.md)), Phase 2 of 5

## Problem

The vision document names "verify outcomes, record, learn" as a required leg of the propose → act → verify → record → learn loop, but today only one narrow slice of Jarvis's actions has any outcome tracking at all: shell commands proposed via `propose_command` get a full lifecycle in `command_proposals` (propose → approve → execute → `record_command_outcome`). Every other action Jarvis takes through a tool call — sending an email, writing a file, creating a GitHub issue, setting an objective — leaves no trace of whether it actually worked. There's no way to compute "how often do Jarvis's actions actually succeed" outside the one command-execution path, and no structural hook for the self-narration ever to ask "did that work?" about anything else.

## Scope

New, project-wide **Outcome Ledger**: a single new table that logs every tool call as it executes, and — for a curated subset of actions where being wrong actually costs something — a mechanism for the model to record whether the user confirmed it worked. `command_proposals` is untouched; it already does this well for its one action type, and duplicating it into the ledger would just create two disagreeing sources of truth for the same commands.

## Consequential vs. trivial

Every tool call gets logged (`execution_ok`), but only a curated subset also gets flagged `needs_follow_up` — these are the ones where the model should eventually ask "did that work?" A tool is consequential if it mutates something outside Jarvis's own head, where being wrong has a cost the user has to notice or undo.

**Consequential (8):** `send_email`, `send_personal_email`, `github_create_issue`, `calendar_create_event`, `write_file`, `write_vault_note`, `set_objective`, `update_objective_status`.

**Trivial — logged, no follow-up (24):** every read-only tool (`github_get_repo_or_file`, `list_files`, `read_file`, `search_vault`, `get_vault_note`, `get_vault_backlinks`, `query_knowledge_graph`, `calendar_list_events`, `list_objectives`, `get_briefing`, `get_news`, `search_web`, `get_security_status`, `view_screen`, `list_constraints`, `get_rapport_summary`), plus actions with no lasting external effect (`speak_text`, `decompose_plan`, `confirm_build_direction`, `display_content`, `reflect_on_self`), plus sandboxed actions that can't touch the real system (`run_sandbox_command`, `reset_sandbox`, `propose_mcp_server` — the last only ever creates a pending row a human must approve before anything connects).

**Logged like every other call, but never counted:** `propose_command` and `record_command_outcome`. These already have a complete, working lifecycle in `command_proposals` — a row is still written to the ledger for each of them, but they are never flagged `needs_follow_up` and therefore never countable toward the success rate. Folding them into the ledger's confidence signal too would give the confidence calculation two disagreeing signals for the same underlying events.

## Schema

New migration `014_outcome_ledger.ts`, following the existing pattern in `src/kernel/state/migrations/`:

```sql
CREATE TABLE outcome_ledger (
  id SERIAL PRIMARY KEY,
  username TEXT NOT NULL,
  action_name TEXT NOT NULL,        -- tool name, e.g. 'send_email'
  action_summary TEXT,              -- brief description, from the tool's args
  executed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  execution_ok BOOLEAN NOT NULL,    -- did the tool call itself succeed (result.ok)
  needs_follow_up BOOLEAN NOT NULL, -- true iff action_name is in the consequential set
  outcome TEXT,                     -- 'worked' | 'not_worked' | NULL (unverified)
  outcome_recorded_at TIMESTAMPTZ
);
CREATE INDEX outcome_ledger_username_idx ON outcome_ledger(username);
CREATE INDEX outcome_ledger_pending_idx ON outcome_ledger(username, action_name)
  WHERE needs_follow_up AND outcome IS NULL;
```

New repo `src/kernel/state/outcome-ledger-repo.ts`, mirroring `command-proposals-repo.ts`'s style:

- `logAction(username, actionName, actionSummary, executionOk): Promise<void>` — insert, computing `needs_follow_up` from a static `CONSEQUENTIAL_ACTIONS` set. Never throws to the caller — a logging failure must not break the tool call itself (wrap in try/catch, `observation.logTelemetry("warn", ...)` on failure, matching `recordCommandOutcome`'s own error-swallowing style).
- `recordActionOutcome(username, actionName, outcome): Promise<boolean>` — `UPDATE outcome_ledger SET outcome = $1, outcome_recorded_at = now() WHERE id = (SELECT id FROM outcome_ledger WHERE username = $2 AND action_name = $3 AND needs_follow_up AND outcome IS NULL ORDER BY executed_at DESC LIMIT 1)`. Resolves against the most recent still-open row for that `(username, action_name)`, not an id the model has to remember — a repeat call or the user answering twice is a safe no-op, the same guarantee `recordCommandOutcome`'s status-scoped `WHERE` gives today.
- `getRecentActionSuccessRate(): Promise<number | null>` — windowed to the most recent 20 rows with `outcome IS NOT NULL` across all users and action names, `null` when none exist. Exact mirror of `getRecentOutcomeSuccessRate` in `command-proposals-repo.ts:130-146`.

## Write path

`executeTool` in `src/capabilities/tools.ts:505` is the single choke point all three callers already go through (`server.ts:983`, `server.ts:1090`, `src/interaction/voice-session.ts:319`) — no per-caller instrumentation needed. The function has many `return` statements throughout its full body, not just the `switch`: the permission-denied return (line 543), the unknown-tool return (line 536), both MCP-tool-call returns (550, 553), the per-case early-return validation errors inside the `switch`, the success return (754-761), and the catch block (762-768). The cleanest hook is a rename-and-wrap covering the *entire current function body*, not just the switch: rename the whole existing body to `executeToolInner` (same signature, same internals, untouched), and make `executeTool` a thin wrapper that awaits it, calls `outcomeLedgerRepo.logAction(username, name, summarize(name, args), result.ok)`, and returns the result unchanged. This means permission-denied and unknown-tool attempts get logged too (`execution_ok = false`), which is correct — those are real attempted actions, just failed ones. `summarize()` is a small per-tool-name switch producing a short human-readable string from `args` (e.g. `send_email` → `to ${args.to}: "${args.subject}"`, `write_file` → `args.path`) — falls back to `name` alone for tools with no natural summary. Whatever `executeToolInner` returns, on any path, gets logged exactly once, exactly the same way.

## Verification path

New tool `record_action_outcome`, added to `TOOL_DECLARATIONS` in `src/capabilities/tools.ts` immediately after `record_command_outcome` (~line 428), same shape:

```
name: "record_action_outcome",
description: "Record whether a previously taken action (like sending an email or saving a note) actually worked, based on what the user told you. Call this only when the user has explicitly said whether it worked — never speculatively.",
parameters: {
  actionName: STRING — the tool name of the action being confirmed (e.g. "send_email"),
  outcome: STRING — "worked" or "not_worked"
}
```

Handled in `executeToolInner`'s switch, mirroring `record_command_outcome`'s case at line 684: validate `outcome` is one of the two allowed values, call `recordActionOutcome`, return `{ ok: false, error: "No matching action found awaiting an outcome." }` if nothing matched. Added to `PERMISSION_BY_TOOL` as `record_action_outcome: "system.execute"` (same grant as `record_command_outcome`) and to the exclusion comment at line 772-777 (`TOOL_TRIGGER_WORDS`) alongside the other model-driven-only tools.

## Read / confidence integration

`server.ts`'s existing `capabilityConfidence` calculation (near the `"Error"` tier added in PR #167) gains a second signal: `outcomeLedgerRepo.getRecentActionSuccessRate()`, read alongside `commandProposalsRepo.getRecentOutcomeSuccessRate()`. When both return non-null, average them; when only one has data, use it alone; when neither has data, behavior is unchanged from today.

## Testing

- `outcome-ledger-repo` unit tests: `logAction` sets `needs_follow_up` correctly for a consequential vs. a trivial action name; `recordActionOutcome` resolves the most-recent-open row and no-ops (returns `false`) on a repeat call or when nothing is open; `getRecentActionSuccessRate` returns `null` on zero rows and the correct ratio on a mixed set, windowed to 20.
- `tools.ts` integration test: calling a consequential tool (e.g. `set_objective`) results in a `needs_follow_up = true` row; calling a trivial tool (e.g. `list_objectives`) results in `needs_follow_up = false`.
- `record_action_outcome` contract test: rejects an invalid `outcome` value; succeeds and updates the row for a valid one; returns the "no matching action" error when there's nothing open for that `(username, actionName)`.
