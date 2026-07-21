# Agent Departments (Research / Coding / QA) — Design Spec

## Context

`src/execution/autonomous_executive.ts` already has a "specialist swarm" concept —
`decompose_plan` (chat tool) and `/api/executive/run` both route through it,
and it already narrates a Research → Coding → Coding → QA sequence for any
objective. Every one of those stages is currently fake: it returns a fixed
string like `"[Coding Swarm — planned, not executed] Would write templates,
endpoints, and database connection logic."` and does nothing. This has been
deliberate — `VISION.md` explicitly documents not guessing structured
arguments (which file, which repo) from a free-text plan step, and separately
documents tearing out an older, larger "department/agent hierarchy" in favor
of "a single Express app with focused modules."

This spec makes the Research, Coding, and QA stages real, without
reintroducing that older architecture: no new agent framework, no new
registry class — three real routines dispatched from the same planner that
already exists, reusing the existing capability-grant/approval system for
anything consequential.

## Motivating scenario

The user asks for something to be built (e.g. "build me a website for X").
Today: four canned strings come back, nothing happens. After this spec:
Jarvis does real research, stores it, brings the findings back to the user
for a conversation about direction, and — only once the user has actually
confirmed that direction — drafts real code and proposes it as a GitHub pull
request for the user to approve before it's opened.

## Architecture

`decompose_plan` remains the single entry point (no new tool name to learn
for triggering this). What changes is what decomposition produces and what
happens after:

- Decomposition now asks Gemini to tag each step with a department —
  `research`, `coding`, or `qa` — instead of assuming a fixed 4-step shape.
  An objective with no coding step (e.g. "help me plan a podcast launch")
  gets real research instead of narration, but stops there — the existing,
  simpler behavior, just no longer fake.
- An objective with a coding step is where the full lifecycle below kicks
  in, backed by a new `build_requests` table that persists state across the
  pause-for-a-human-conversation step this flow requires — something
  nothing in this codebase has needed before (every other proposal shape —
  `command_proposals`, `mcp_servers` — pauses for a single approve/reject
  decision, not an open-ended conversation).

New files:
- `src/data/build-requests-repo.ts` — DB layer for `build_requests`.
- `src/execution/departments.ts` — the three real department routines
  (`runResearch`, `draftCodeChanges`, `reviewCodeDiff`). Kept separate from
  `autonomous_executive.ts` so that file stays the orchestrator/dispatcher,
  not a growing monolith holding both the coordination logic and the actual
  department work.

Modified files:
- `src/execution/autonomous_executive.ts` — department-tagged decomposition;
  dispatch calls into `departments.ts` and `build-requests-repo.ts` instead
  of returning canned strings.
- `src/integrations/github.ts` — three new functions: create a branch,
  commit file changes to it, open a PR. All plain REST calls via `fetch`
  against the GitHub API (matching this file's existing style — no new git
  library dependency), never touching `main` directly and never merging —
  Jarvis proposes a PR the same way any contributor would; a human merges it
  on GitHub, same as everything else in this repo.
- `src/execution/tools.ts` — one new chat tool, `confirm_build_direction`.
- `src/server.ts` — two new admin routes: approve / reject a drafted code
  change.
- `src/execution/permissions.ts` — no capability logic changes needed;
  `github.pulls.create` already exists in `ALL_CAPABILITIES` (reserved,
  unused) — this is the first tool to actually require it.
- `.env`/`.env.example` — new `SELF_REPO_OWNER`/`SELF_REPO_NAME` variables
  (e.g. `SweatyFoxGaming`/`Jarvis-os-2.0`). Nothing in the codebase today
  identifies "this repo" to itself — `github_get_repo_or_file` always takes
  an explicit owner/repo argument from the caller. Coding needs a fixed
  target that isn't model-suppliable (see "Decisions" below), so it's
  read from config, not passed as a tool/routine argument.

## Data model

```sql
CREATE TABLE IF NOT EXISTS build_requests (
  id SERIAL PRIMARY KEY,
  objective TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'researching',
  requested_by TEXT NOT NULL,
  research_summary TEXT,
  direction_notes TEXT,
  code_summary TEXT,
  proposed_files JSONB,
  pr_url TEXT,
  pr_number INTEGER,
  qa_summary TEXT,
  error_detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS build_requests_status_idx ON build_requests(status);
CREATE INDEX IF NOT EXISTS build_requests_requested_by_idx ON build_requests(requested_by, status);
```

`status` values: `researching` → `awaiting_consult` → `direction_confirmed`
→ `coding` → `awaiting_code_approval` → `pr_opened` → `qa_complete`, or
`rejected_at_code` / `error` off the happy path. `coding` is set the moment
`draftCodeChanges` starts, *before* its Gemini call — since that call is
synchronous within the same request as `confirm_build_direction`, an
external observer would otherwise see the row jump straight from
`direction_confirmed` to `awaiting_code_approval` with no visibility if it
hangs; sitting visibly in `coding` (rather than being ambiguously stuck at
`direction_confirmed`) is what lets an admin tell "still working" from
"never started" if that call fails or times out — the failure path writes
`error_detail` and sets `status: error` from there. There is deliberately
no explicit "abandon at consult" state — if the user never confirms
direction, the row simply stays `awaiting_consult` forever. That's harmless
(nothing external happened yet, only research), so an explicit cancel
action is left as a future enhancement rather than built now.

`proposed_files` is a JSON array of `{ path: string, content: string }` —
the drafted file changes, stored before anything touches GitHub.

Brand-new table — a plain `CREATE TABLE IF NOT EXISTS` is correct, no
migration risk (same as `mcp_servers` in the prior phase, unlike
`command_proposals`'s live-table `ALTER`).

## The lifecycle, in detail

1. **Research.** `decompose_plan` sees a coding-tagged step, creates a
   `build_requests` row (`status: researching`), and `departments.ts`'s
   `runResearch(objective, ai)` runs for real in two Gemini calls: the
   first is given the objective and asked to propose up to 3 concrete
   lookups — specific web search queries, and/or whether this repo's
   current structure is relevant enough to fetch via
   `github_get_repo_or_file` — rather than guessing search terms directly
   from the raw objective string. Those lookups execute via the existing
   integration functions directly (not through the chat tool-calling loop —
   this is server-side orchestration, not a second model turn per lookup),
   and `query_knowledge_graph` always runs too (cheap, checks whether
   Jarvis already knows something relevant). The second Gemini call
   synthesizes everything gathered into a findings summary — each lookup
   that fails is noted, not fatal (see "Error handling" below). Written to
   `research_summary`, status → `awaiting_consult`, a notification goes out
   (`scheduler.pushNotification`, same mechanism as every other proposal in
   this codebase) inviting the user to discuss it.

2. **Consult.** This is just conversation — no new mechanism needed for the
   back-and-forth itself. `research_summary` gets pulled into the system
   prompt context for that user the same way memory/identity context
   already is, so Jarvis can discuss the findings naturally. A new tool,
   `confirm_build_direction(directionNotes: string)`, lets Jarvis capture
   the moment the user has actually signed off — **deliberately no id
   parameter**. It looks up the caller's own most recent `awaiting_consult`
   row server-side rather than requiring the model to correctly recall a
   numeric id from many turns back. (This sidesteps the exact class of bug
   the Phase 3 final review caught and fixed for `record_command_outcome` —
   a notification's id scrolling out of context by the time the user
   responds. A consult conversation can run far longer than a yes/no
   approval, so that risk is worse here, not better.) Gated by the existing
   `executive.plan` capability (same one `decompose_plan` already uses) —
   this only drafts code and stores it, no real-world side effect yet.

3. **Coding.** `confirm_build_direction`'s handler writes `direction_notes`,
   flips status to `direction_confirmed`, and synchronously calls
   `departments.ts`'s `draftCodeChanges(objective, researchSummary,
   directionNotes, ai)` — one Gemini call producing real file content for
   this repo specifically (not an arbitrary user-named repo — see
   "Decisions" below). Written to `code_summary`/`proposed_files`, status →
   `awaiting_code_approval`, another notification sent — the same
   propose-then-notify shape `propose_command` already uses.

4. **Approval.** `POST /api/system/build-requests/:id/approve-code` (admin
   route, gated by `github.pulls.create`) is where GitHub actually gets
   touched for the first time: fetch the repo's current default branch
   (`GET /repos/{owner}/{repo}` — not hardcoded `"main"`), create a new
   branch off its HEAD, commit each file in `proposed_files` to that branch
   via the Contents API (`PUT /repos/{owner}/{repo}/contents/{path}` — one
   commit per file, the API's natural granularity; the PR itself, not a
   clean commit history, is the human-reviewable unit here), then open the
   PR. Row gets `pr_url`/`pr_number`, status → `pr_opened`. `POST
   .../reject-code` sets `status: rejected_at_code`, no GitHub calls made —
   mirrors `command_proposals`' reject flow exactly.

5. **QA.** Runs synchronously right after the approval route's GitHub calls
   succeed (no new scheduled job) — one Gemini call reviews `proposed_files`
   against the original `objective` and `direction_notes`, flagging
   concerns. Written to `qa_summary`, status → `qa_complete`, a final
   notification includes the PR link and where to watch CI — QA reads the
   signal CI already produces on every PR in this repo rather than trying
   to re-run tests itself; Jarvis has no sandbox to execute an arbitrary
   repo's test suite, and this repo already has real CI on every PR.

## Error handling

- Research and coding both genuinely need Gemini — there's no sane "dumb
  local fallback" for drafting real code the way `autonomous_executive.ts`
  already falls back to 4 heuristic strings for decomposition today. If
  `ai` is null or `kernel.offlineMode` is on, the research/coding step
  reports that plainly (`research_summary`/`code_summary` explains why,
  status moves to `error`) rather than attempting something unreviewed with
  a weak local model.
- The approval route's GitHub calls (branch → commit each file → open PR)
  must not silently report success on a partial failure. If branch creation
  succeeds but a file commit fails partway through, the row records exactly
  which step failed (`status: error`, `error_detail` populated) rather than
  claiming `pr_opened` — matching how every GitHub/MCP integration in this
  codebase already degrades (never silently corrupt state).
- `runResearch`/`draftCodeChanges`/`reviewCodeDiff` each wrap their
  sub-calls so one failing read (e.g. `search_web` erroring) doesn't abort
  the whole research pass — synthesize from whatever succeeded, note what
  didn't, same resilience posture as `getRecentOutcomeSuccessRate` and
  friends degrading to `null` rather than throwing.

## Security / trust model

- No new capability for Research — reuses `web.search`/`github.read`/
  `knowledge.read`, already granted at the same trust level as calling
  those tools directly in chat today.
- `confirm_build_direction` is gated by `executive.plan` (existing).
- The PR-opening action is gated by `github.pulls.create` — reserved in
  `ALL_CAPABILITIES` since an earlier phase, wired to a real tool for the
  first time here. Admin gets it auto-backfilled the same way every other
  capability does.
- Coding is scoped to this repo only (see "Decisions" below) — no
  arbitrary-repo write access, and even within this repo, nothing reaches
  GitHub until a human explicitly approves the specific diff.
- Jarvis never pushes to `main` and never merges anything, in this repo or
  any other — a PR is the ceiling of what this feature can do unattended;
  merging stays a manual human action via GitHub.

## Testing

Same convention as every prior phase: `build-requests-repo.ts`'s functions
get degrade-safety tests with no live Postgres connection (matching
`mcp-servers-repo.ts`'s pattern exactly). `departments.ts`'s three routines
depend on live Gemini calls and, for coding/QA, live GitHub calls — those
get tested for structure/error-handling where mockable, with the actual
live round trip (real research query, real PR opened against this repo)
deferred to manual verification at deploy time, same as the MCP plan's
live-server-connection tests were deferred.

## Decisions made during brainstorming

- **Real execution, not narration** — the user explicitly chose to cross
  the line `VISION.md` had drawn against guessing structured arguments from
  free-text plan steps. The mitigation isn't "don't do it," it's "keep every
  consequential step gated," which this design does at both the coding and
  PR-opening boundaries.
- **Upgrades the existing engine** rather than adding a second, parallel
  orchestration system next to `autonomous_executive.ts` — this codebase's
  own audit history (`ARCHITECTURE_AUDIT.md`) flags duplicate
  registries/orchestrators from the old Python era as a recurring mistake;
  this spec deliberately avoids repeating it.
- **Coding is scoped to this repo only**, not an arbitrary user-named repo —
  smallest contained trust surface for a first version. Extending to
  other repos is a natural, separately-decided future step once this shape
  is proven, not part of this pass.
- **Two approval checkpoints, not one** — confirming direction (what to
  build) is a separate decision from approving the actual generated code
  (is this specific diff good). Collapsing them would mean a casual "yeah
  sounds good" in conversation triggers a real GitHub PR with no chance to
  review the actual diff first.
- **QA does an immediate diff review, not CI polling** — waiting for CI
  would need a new scheduled job (like the MCP health-check job). The
  user chose to keep this pass's scope tighter and let CI's own result
  speak for itself on GitHub, same as any other PR.
- **`confirm_build_direction` takes no id parameter**, resolving against
  the caller's own most recent `awaiting_consult` row instead — a
  deliberate design choice to avoid the exact "id scrolled out of context"
  failure mode the Phase 3 final review found and fixed for
  `record_command_outcome`, which matters more here since a consult
  conversation can run much longer than a yes/no approval.
