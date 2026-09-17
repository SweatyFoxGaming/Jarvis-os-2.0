# Retire `feature_requests`, Surface Build Requests in the Dashboard — Design Spec

## Context

Jarvis has two separate, disconnected systems for "the user asks for something new":

1. **`feature_requests`** (older): a chat tool, `queue_feature_request`, that records an idea and
   explicitly hands it to "a real human developer" — Jarvis never writes or executes code in this
   path. This is the only one of the two visible in the dashboard, in the "Projects" panel
   (`src/interaction/static/index.html`), whose own copy says exactly that: "queues it here for a
   real developer to build. Jarvis never writes or runs code itself."
2. **`build_requests`** (built in the Agent Departments phase, newer): triggered automatically —
   with no special tool call — whenever `AutonomousExecutive.executeObjective` decomposes an
   objective and detects a `coding`-tagged step. This drives a real lifecycle: research → a
   consult conversation → (once the user confirms direction) real drafted code → human
   approval → a real GitHub PR → QA review. The admin routes for this
   (`GET /api/system/build-requests`, `POST .../:id/approve-code`, `POST .../:id/reject-code`)
   already exist and work — they were built and reviewed in the Agent Departments phase — but
   have never been exposed in the dashboard UI at all.

The user noticed the "Projects" panel implies Jarvis always needs a human developer to write code,
which is only true of the older, less-capable path — the capable path already exists and simply
isn't visible. The fix is consolidation, not new capability: retire the tool nobody should be
using, and give the capability that already exists a UI.

## Architecture

**System prompt** (`src/server.ts`, the paragraph instructing the model on unrecognized
capability requests): remove the `queue_feature_request` instruction. The model doesn't need
special instructions to reach the build-requests path — a user's objective just flows through the
executive's normal decomposition, which detects a coding step on its own.

**Tool removal** (`src/capabilities/tools.ts`): delete the `queue_feature_request` entry from
`TOOL_DECLARATIONS`, its `feature.propose` entry from the tool-to-permission map, and its
`executeTool` switch case. `feature-requests-repo.ts` and the `feature_requests` table are left
completely alone — no migration, no data loss, just no more writes going forward. The existing
`GET /api/feature-requests` admin route also stays (harmless, still reads whatever's there).

**Dashboard panel** (`src/interaction/static/index.html`'s `view-projects` pane, same location,
matching visual style to the panel it replaces and to this dashboard's other status panels): shows
real build requests instead of queued feature requests.

- List backed by `GET /api/system/build-requests` (already exists, requires the
  `github.pulls.create` grant like it already does).
- Each row shows: the objective, a status badge covering all 9 `BuildRequestStatus` values
  (`researching`, `awaiting_consult`, `direction_confirmed`, `coding`, `awaiting_code_approval`,
  `pr_opened`, `qa_complete`, `rejected_at_code`, `error` — each mapped to a readable label and a
  color matching the existing `FEATURE_REQUEST_STATUS_STYLE`-style convention in this file), and
  whichever of `research_summary` / `direction_notes` / `code_summary` / `qa_summary` is present
  yet, truncated the same way the old panel truncated `proposed_plan`.
- When `pr_url` is set, it's a real link to the PR.
- When status is `awaiting_code_approval`, the row gets two buttons, Approve and Reject, calling
  the existing `POST /api/system/build-requests/:id/approve-code` and `.../reject-code` routes.
  These routes already exist and are already reviewed/working — this is only wiring a UI to them,
  not building new backend behavior.
- Empty state and count badge follow the same pattern as the panel being replaced.

## Explicitly out of scope

- Any change to `AutonomousExecutive`, `departments.ts`, or the build-requests backend routes
  themselves — all already built and working; this only removes a redundant tool and adds a UI.
- Dropping the `feature_requests` table or its GET route.
- A UI for the `researching`/`awaiting_consult`/`direction_confirmed`/`coding` states beyond
  showing their status and available summary text — no new interactive actions for those states
  beyond what's already possible in chat (the consult conversation itself stays in chat, not the
  dashboard).

## Testing

- Confirm no test currently exercises `queue_feature_request`'s tool case (if one does, update it
  to reflect the tool no longer existing, per this codebase's existing convention for permission
  map / tool declaration changes).
- No new backend logic is added — the two admin routes this UI calls are already covered by
  existing behavior (this spec adds no new server-side code, only static frontend markup/JS and
  the system-prompt/tool-declaration edits, none of which need new unit tests under this
  codebase's existing conventions for UI/prompt-text changes).
- Manual verification at deploy time: confirm the panel renders real build requests, confirm the
  Approve/Reject buttons actually call through to the existing routes correctly.

## Decisions made during brainstorming

- **Retire `queue_feature_request` entirely rather than keep both or auto-bridge them** — chosen
  because the build-requests path already covers the same need with no separate tool call
  required; keeping two parallel "ask for new capability" paths would only reintroduce the
  original confusion in a different form.
- **Leave `feature_requests` data and its GET route alone** — no migration, no destructive action;
  it simply stops being written to.
- **Reuse the existing "Projects" panel's slot and visual style** rather than adding a new
  navigation entry, since this is a direct replacement of what that panel was always meant to
  represent (the bridge from "asked Jarvis for it" to "actually built").
