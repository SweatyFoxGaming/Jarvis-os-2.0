# Command Outcome Tracking — Design Spec

**Roadmap:** Phase 3 of `docs/architecture/ROADMAP.md` ("Measuring whether
Jarvis is actually right"), scoped to its own explicitly-named starting
case: closing the loop on `command_proposals` — the one consequential,
human-approval-gated action type that already has a real success signal
(`exit_code`) to build on.

## The gap

`command_proposals` already tracks whether an approved command *ran*
without error (`exit_code`, `status: 'executed' | 'failed'`). Nothing
tracks whether it actually *helped* — the roadmap's own distinction. A
command can exit 0 and still not fix the problem the user approved it for.
Today that distinction is invisible; the per-turn confidence score has no
input derived from real-world outcomes at all.

## Scope

**In scope:** `command_proposals` only. One new outcome question, asked
once per successfully-executed command, captured via a chat tool, feeding
a new input into `ConfidenceModel`.

**Out of scope (explicitly, deferred to a future pass if ever pursued):**
- Outcome tracking for `feature_requests`, `remediation_proposals`, or
  Phase 2's `objectives` — the roadmap explicitly allows this phase to
  start with the simplest case.
- Any dashboard/UI changes — this reuses the existing chat + notification
  surface exactly like Phase 2.
- Proactively surfacing repeat failures in the briefing — this phase only
  wires outcomes into the confidence number, nothing else.
- Any automatic behavior change beyond the confidence input (e.g., no
  auto-blocking of re-proposing a command type that previously failed to
  help).

## Architecture

Five pieces, all built on infrastructure that already exists — no new
subsystem, no new capability.

1. **Schema** (`src/data/db.ts`): `command_proposals` gains two nullable
   columns: `outcome TEXT` (`'worked'` | `'not_worked'`) and
   `outcome_recorded_at TIMESTAMPTZ`.
2. **Repo** (`src/data/command-proposals-repo.ts`):
   - `recordCommandOutcome(id, outcome)` — `UPDATE ... SET outcome = $1,
     outcome_recorded_at = now() WHERE id = $2 AND status = 'executed' AND
     outcome IS NULL`. The `status = 'executed' AND outcome IS NULL` guard
     makes it structurally impossible to record an outcome for a command
     that hasn't successfully run, or to overwrite one already recorded —
     a duplicate tool call or a user answering twice is a safe no-op, not
     a data-integrity bug.
   - `getRecentOutcomeSuccessRate()` — returns the fraction of
     outcome-recorded commands (across all users; this system is
     single-user today per Phase 5's own deferral) where `outcome =
     'worked'`, over the most recent 20 recorded outcomes (or all of them
     if fewer than 20 exist). Returns `null` when zero outcomes have ever
     been recorded, so the confidence layer can distinguish "no data yet"
     from "0% success."
3. **Notification wiring** (`src/server.ts`'s existing
   `/api/system/ingest/command-result` route): immediately after
   `recordCommandResult` returns a row with `status === 'executed'`, push
   one notification via the existing `scheduler.pushNotification`, e.g.
   `"Ran your command, sir: <command>. Did that fix it?"`. `'failed'`
   rows never trigger this — a nonzero exit is already an unambiguous
   outcome signal, asking would be redundant.
4. **New tool** (`src/execution/tools.ts`): `record_command_outcome`
   — args `{ commandId: number, outcome: "worked" | "not_worked" }`.
   Gated under the **same** `system.execute` capability `propose_command`
   already requires (this is closing the loop on something the user
   already holds a grant for — no new capability, no new grant surface).
   Validates `outcome` is exactly one of the two allowed strings before
   touching the DB (same defensive pattern as Phase 2's
   `update_objective_status` guard) and returns a clean tool error
   otherwise. Calls `recordCommandOutcome`; if it returns `false` (no
   matching row — already answered, or the command never actually
   executed), returns a clean "No matching executed command found" error
   rather than a silent success.
5. **Confidence wiring** (`src/cognition/kernel/confidence.ts` +
   its two call sites in `src/server.ts` and
   `src/execution/autonomous_executive.ts`): `ConfidenceInputs` gains
   `outcomeConfidence?: number` (0–1). Both call sites compute it by
   calling `getRecentOutcomeSuccessRate()` and passing the result through
   directly when non-null; when `null` (no data yet), the input is simply
   omitted so `ConfidenceModel`'s existing `?? 1.0` default applies —
   identical to how every other input already behaves before its signal
   exists. This means Phase 3 changes zero behavior until the first real
   outcome is recorded, which is the correct behavior for a cold start.

## Data flow

1. Host executor reports a command result → `recordCommandResult` sets
   `status` to `'executed'` or `'failed'`, plus `exit_code`/`output`.
2. If `'executed'`: one `pushNotification` fires, naming the specific
   command, asking whether it worked.
3. User replies in a later chat turn (e.g. "yes" / "no, still broken").
   Gemini, given the conversation context (the notification text is part
   of what the user is responding to), calls `record_command_outcome`
   with the matching `commandId` and the `outcome` it infers from the
   reply.
4. `record_command_outcome` validates and calls `recordCommandOutcome`,
   which applies the `status = 'executed' AND outcome IS NULL` guard.
5. On the next confidence calculation (any chat turn, or an
   autonomous-executive run), `getRecentOutcomeSuccessRate()` is queried
   fresh and folded into `calculateOverallConfidence` as
   `outcomeConfidence`.

## Error handling / security & stability

*This project's standing directive: every update should make Jarvis more
secure and stable, not just add capability.* This design's properties:

- **No new attack surface.** `record_command_outcome` reuses the
  `system.execute` capability gate already enforced for
  `propose_command`/the claim/ingest routes — no new capability is
  introduced, so there is no new grant to misconfigure or backfill.
- **No new failure mode.** `recordCommandOutcome` and
  `getRecentOutcomeSuccessRate` both wrap their query in `try/catch` and
  degrade to a safe value (`false` / `null` respectively) rather than
  throwing, matching every Postgres-touching function added in Phase 2.
  A Postgres outage during outcome recording means the tool returns a
  clean error to Gemini — never a crash — and a Postgres outage during
  confidence calculation means `outcomeConfidence` is simply omitted,
  falling back to the existing neutral default.
- **No duplicate/ambiguous writes.** The `status = 'executed' AND outcome
  IS NULL` guard is the one line that matters here (the same role
  Phase 2's `WHERE username = $3 AND status = 'active'` clause played) —
  it is what prevents a re-asked or re-answered question from corrupting
  the rolling success rate.
- **Graceful cold start.** Zero recorded outcomes must never be
  interpreted as 0% success — `getRecentOutcomeSuccessRate()` returning
  `null` and the confidence layer omitting the input (not defaulting it
  to 0) is the specific mechanism that guarantees this.

## Testing

Following this codebase's established convention
(`tests/index.test.ts` never calls `initDatabase()`, so every DB-touching
path in the test suite exercises its no-DB-connection fallback, not a
live query):

- Repo: `recordCommandOutcome` degrades to `false` when Postgres is
  unreachable; `getRecentOutcomeSuccessRate` degrades to `null`.
- Tools: `record_command_outcome` denied without the `system.execute`
  grant; invalid `outcome` string rejected with a clean error before any
  DB call.
- `ConfidenceModel`: `calculateOverallConfidence` factors in
  `outcomeConfidence` when provided (verify the average shifts as
  expected) and falls back to the existing neutral default when it's
  omitted — a direct, fast unit test with no DB involved at all, since
  `ConfidenceModel` itself is pure.

The `status = 'executed' AND outcome IS NULL` scoping (the
security/data-integrity-critical clause) is verified by inspection, the
same way Phase 2's per-user isolation clause was — this codebase's no-
live-DB test convention makes it impractical to exercise with an
automated test, and that tradeoff was already made explicitly in Phase 2.
