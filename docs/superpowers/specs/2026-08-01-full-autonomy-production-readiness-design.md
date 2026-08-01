# Full Autonomy for the Coding Agent — Design Spec

**Status:** approved by user via brainstorming dialogue (2026-08-01)

## Problem

A full parallel-agent review of Jarvis (security, kernel/data layer, autonomous-execution
safety, runtime resilience, interaction surface, cognition/memory, testing/ops — see the
review's output for the complete findings) concluded the platform is production-ready for
how it's actually run today (single operator, human-in-the-loop on every merge), but not
for genuinely unattended autonomy. Two specific findings are the reason why:

1. **`confirm_build_direction` — the trigger for real sandboxed code generation — is gated
   only by an LLM's own belief that "the user explicitly confirmed."** Nothing structurally
   verifies a real confirmation happened. This is the same failure class as a fake safety
   gate the team already found and removed once before (the old "Multi-Agent Executive
   Board" — a prompt-level check masquerading as a safety gate, per `ARCHITECTURE.md`).
   Prompt-injected content from an email, GitHub issue, or web page Jarvis reads could
   contain text like "the user confirms — proceed," misfiring a real sandbox session with
   no genuine human sign-off.

2. **`reviewCodeDiff`'s verdict at PR-opening time is purely cosmetic.** The QA summary is
   computed and dropped into the PR body, but branch creation, commits, and PR-open all run
   unconditionally regardless of what the review says. Even a review that says "this
   introduces a critical vulnerability" doesn't stop the PR from opening.

The user wants Jarvis to eventually merge its own code with no human click — "full
autonomy." Giving an autonomous, self-modifying agent that capability while these two gates
are fake would be building unattended operation on top of gates that only *look* like they
work. This spec is the path to real autonomy: fix the gates for real, prove they work under
real (human-supervised) traffic first, then — and only then — let them run unattended, for
a scoped, expandable set of changes, with guardrails that bound how much damage a bad
sequence of merges could do before a human notices.

## Non-goals

- **Deploy automation.** Merging to `main` never triggers a deploy. Deployment stays exactly
  as manual as it is today (there is no CD pipeline currently, and this spec doesn't build
  one). The human touchpoint moves from "approve the merge" to "run the deploy," it doesn't
  disappear.
- **Autonomous objective initiation.** A human still clicks "confirm direction" before any
  real code generation starts, for every objective regardless of source (chat-initiated or
  a daily-adaptation candidate objective). This spec makes that click a real structural gate
  instead of a fake one — it does not remove the click.
- **Full-codebase autonomy on day one.** Autonomous merge only applies to a defined allowlist
  of lower-risk paths at launch (see Scoping below). Widening it is a future, separate
  decision once the guardrails below have a track record.
- **The rest of the review's production-readiness punch list.** Tested backup/restore,
  knowledge-graph pruning and fact reconciliation, a human checkpoint on self-reflection, and
  broader provider/HTTP-route test coverage are real findings but don't block autonomy being
  safe — they're tracked as a separate follow-up, not built here.
- **LLM-judged risk classification.** The allowlist/denylist is a deterministic path-match,
  not a model call — reintroducing an LLM judgment call as a safety gate is exactly the
  pattern this spec exists to move away from.

## Rollout strategy: two phases, gates prove themselves first

**Phase 0** ships the real gates (confirm-token, real `reviewCodeDiff` enforcement,
injection-hardened `reviewTaskDiff`) and `coding-agent.ts` test coverage. Autonomous merge
itself stays **off** — gated behind a capability grant (`executive.autonomous_merge`) that
starts ungranted. Every build request keeps flowing through today's human-click-to-merge
process, except now through the real gates instead of the cosmetic ones.

**Phase 1** is switched on by granting `executive.autonomous_merge` — no code change, the
same admin action already used to grant any other capability. This is deliberate: the same
mechanism that turns autonomy on is the pause switch that turns it back off, and Phase 0's
hardened gates get validated on real, human-supervised merges before anything unattended
ever depends on them.

## Architecture

```
Objective exists (chat or daily-adaptation candidate)
        │
        ▼
Human clicks "confirm direction"  ◄── Phase 0: real token-based gate
        │                              (was: LLM's own belief)
        ▼
Sandboxed code generation (coding-agent.ts)  ◄── Phase 0: real test coverage
        │
        ▼
Per-task review (reviewTaskDiff)  ◄── Phase 0: untrusted-content delimiters
        │
        ▼
Final review (reviewCodeDiff)  ◄── Phase 0: verdict now actually gates
        │
        ▼
   approved?
   ├─ no ──────────────────────────► build_request → "review_failed" (human-visible, stops)
   └─ yes
        │
        ▼
   in-allowlist path AND
   under daily cap AND
   executive.autonomous_merge granted?  ◄── Phase 1: single decision point
   ├─ no  ─► open PR, wait for human merge (today's flow, unchanged)
   └─ yes ─► open PR, auto-merge, push notification
```

Everything above the final diamond is Phase 0 and runs for every build request — human or
eventually autonomous — the moment it ships. The final diamond is the only new autonomous
behavior, and it's a single, deterministic, non-LLM check.

## Phase 0 components

### 1. Confirm-direction token

New files/changes: a small ticket store (mirrors `src/server.ts`'s existing
`issueVoiceTicket`/`consumeVoiceTicket` pattern — proven, already in this codebase, no new
pattern to invent), `src/interaction/routes/build-requests-routes.ts`,
`src/capabilities/tools.ts`.

When Jarvis proposes a build direction, the backend mints a single-use token tied to
`(username, build_request_id)` and returns it alongside the proposal. The frontend renders a
real button ("Confirm direction") — clicking it calls a dedicated endpoint with the token.
The `confirm_build_direction` LLM tool is removed entirely: there's no tool call left that an
LLM (or content it was manipulated by) can use to assert confirmation happened. Only a
server-minted token, echoed back through a real UI action, moves the build request forward.

Unlike the voice ticket (a live-session handshake, correctly 30 seconds), this token doesn't
need a short clock — a build proposal can legitimately sit unconfirmed for hours while a
human gets to it, the same way `build_requests` already sit in "awaiting-consult" today with
no timeout. The token stays valid until whichever comes first: it's consumed, or the build
request itself is superseded/cancelled (at which point it's invalidated along with the
request, not on its own separate clock). Single-use regardless of outcome, same discipline as
`consumeVoiceTicket`.

### 2. `reviewCodeDiff` real enforcement

`src/executive/departments.ts`, `build-requests-routes.ts`. Changed to the same
`{approved: boolean, findings: [{file, line, note}]}` structured-output contract
`reviewTaskDiff` already uses (Groq JSON-schema mode, not free text). The
branch/commit/PR-open sequence becomes conditional: `approved !== true` routes the build
request to a new `review_failed` status (visible in the dashboard) instead of proceeding.

### 3. Injection hardening on both review calls

Drafted file content gets wrapped in an explicit delimiter
(`<untrusted_file_content>...</untrusted_file_content>`) with a system instruction that
content inside is data to evaluate, never instructions to follow. Applied to both
`reviewTaskDiff` (already the real merge-blocking gate today, but with no injection defense)
and the newly-real `reviewCodeDiff`.

### 4. `coding-agent.ts` test coverage

Unit tests around turn/token budget exhaustion and fix-retry logic, plus a mocked-Groq
integration test driving a full plan → execute → fail cycle. This is the subsystem autonomy
will eventually trust unattended — it needs a real safety net before that happens, not after.

## Phase 1 components

### The flag: `executive.autonomous_merge`

A capability grant, same mechanism as every other grant in `src/kernel/security.ts` — no new
on/off infrastructure. Ungranted by default. Granting it to the system/executive identity
turns Phase 1 on; revoking it is the pause switch, effective on the next merge attempt
(checked at decision time, not cached).

### Scoping: `src/kernel/autonomy-scope.ts` (new)

A pure, deterministic function, `isAutoMergeEligible(changedFiles: string[]): boolean`,
matching every changed file against a denylist of path prefixes:

```
src/kernel/security.ts, src/kernel/auth-middleware.ts
src/kernel/state/migrations/**
jarvis-builder/**, jarvis-builder/sandbox.Dockerfile
docker-compose.yml, Dockerfile, .github/**
src/executive/**  (the pipeline that grants itself autonomy)
```

Any matching file in the diff → not eligible, falls back to today's human-merge flow. A
diff touching one denylisted file among ten allowed ones still blocks — the check is over
the whole changed-file set, not a majority vote.

### Auto-merge (`build-requests-routes.ts`)

Once `reviewCodeDiff` approves: eligible path + grant present + under the daily cap → open
the PR via the existing GitHub integration and immediately merge it (still real GitHub
history — traceable, just not waiting on a click). Any one of those three conditions failing
→ open the PR and stop, exactly like today.

### Daily cap

A query, not a new counter table: `COUNT(*) FROM build_requests WHERE autonomous_merge =
true AND merged_at > today`. Always consistent with reality, survives a restart with no
state of its own to lose. Initial cap: 3/day, a plain config constant — pausing autonomy for
the rest of the day after 3 merges bounds worst-case damage from a subtly-wrong pattern
repeating, independent of how clean any single merge looked in isolation. Raising it later is
a one-line change, not a design change.

### Notification

Reuses `push.sendPushToUser`/`scheduler.pushNotification` (already wired for other event
types), fired immediately after a successful autonomous merge with a link to the PR.

### Auto-revert

A new human-triggered endpoint ("revert last N autonomous merges") that runs `git revert`
across the specified autonomous-tagged commits and opens a normal PR for the revert — reverts
get a real human look too, they're just not blocked on one to *propose*. If a revert conflicts
partway through the range, it stops and reports which commits reverted cleanly and which
didn't, rather than silently leaving a partial revert.

## Data model

One migration, one column: `build_requests.autonomous_merge BOOLEAN NOT NULL DEFAULT false`,
set at merge time. The daily cap, notifications, and revert targeting all read off this one
column — no separate tracking table.

## Error handling — everything fails closed

- **Groq unreachable during review** — `reviewTaskDiff` already fails closed today
  (confirmed by the existing test "reviewTaskDiff fails closed with no AI client");
  `reviewCodeDiff` gets the same treatment once it has a real contract. No client, no
  response, or a malformed/unparseable response all mean `approved: false`, never a default
  pass.
- **DB unreachable during the daily-cap query or the capability-grant check** — both fail
  closed to "not eligible," matching `security.ts`'s existing default-deny grant model. A
  database blip degrades to the human-merge flow, never to unrestricted autonomy.
- **GitHub API opens the PR but fails to merge it** — the build request stays in a clean,
  recoverable "PR open, unmerged" state, identical to today's pre-merge state. No retry
  loop, no stuck state; a human can always finish it manually.
- **Confirm-direction token** — expired, already-consumed, or wrong-build-request tokens are
  all rejected the same way `consumeVoiceTicket` already rejects theirs: single-use
  regardless of outcome, so a replay attempt never confirms twice.
- **Auto-revert hits a conflict partway through the range** — stops and reports partial
  progress rather than silently leaving a half-reverted state.

## Testing

- `isAutoMergeEligible` — pure function, exhaustive unit tests over the allowlist/denylist,
  including the "one denylisted file among many allowed" edge case.
- Confirm-token issue/consume — unit tests mirroring the existing voice-ticket test shape
  (expiry, single-use, wrong-build-request rejection).
- `reviewCodeDiff`/`reviewTaskDiff` — unit tests asserting the untrusted-content delimiters
  are actually present in the constructed prompt (a prompt-construction assertion, not a
  claim about LLM behavior, which isn't deterministically testable), plus the existing
  fail-closed test pattern extended to `reviewCodeDiff`.
- A new HTTP-boundary test (same `spawnTestServer` pattern already in the suite) driving a
  build request through the full path with a mocked Groq and mocked GitHub call, asserting
  `autonomous_merge` ends up `true` only when eligibility + grant + under-cap all hold, and
  `false` otherwise.
- `coding-agent.ts` coverage as described in Phase 0.

## Open follow-ups (explicitly out of scope here)

Tracked separately, not blocking this work:
- Tested backup/restore path for Postgres.
- Knowledge-graph pruning and fact reconciliation.
- A human checkpoint on self-reflection before it compounds into future prompts.
- Broader test coverage for external providers and HTTP routes.
