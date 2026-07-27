# Reward/Punishment System for the Coding Agent — Design Spec

**Status:** approved by user via brainstorming dialogue (2026-07-27)

## Problem

Jarvis's coding agent already produces several real signals about whether its own work was any good — a per-task LLM review verdict (`reviewTaskDiff`), a human's approve/reject decision at the code-approval gate, and whether QA/tests ultimately passed — but none of it is remembered. Every build request starts from the exact same blank slate as the one before it: the same default model order, the same system prompt regardless of what kind of work is being attempted, and the same unconditional "proceed to code" the moment a human confirms direction, no matter how the last several attempts at similar work actually went.

The user's framing: the underlying LLM (Groq/Gemini, called via hosted APIs) is not "the brain" of Jarvis — it's a tool Jarvis uses, and tools that perform well should get used more, while ones that don't should get used less, in the same spirit as a reward/punishment signal. True reinforcement learning (gradient-based policy updates to model weights) is not possible against hosted third-party APIs — there is no way to fine-tune Groq's or Gemini's weights from here. This system is deliberately **RL-flavored, not RL**: a persistent, queryable reward ledger over real outcomes that biases which model gets tried first and how carefully Jarvis proceeds, closer to a multi-armed-bandit than anything gradient-based. Naming throughout (code, tables, docs) should say what this actually is — `reward-events`, not `rl-engine` — so nobody mistakes it for weight-level learning.

## Non-goals

- No change to the LLM providers themselves, no fine-tuning, no weight updates — architecturally impossible against hosted APIs and out of scope regardless.
- No new human-facing approval checkpoint beyond what's described below — the confirmation gate reuses the *existing* `direction_confirmed` status as its "paused" signal rather than adding a new build-request status or a new tool.
- No scope beyond the coding-agent pipeline for v1 (explicitly chosen over scoring every chat tool call or host-command execution — see "Approaches considered" in the brainstorming transcript). `command_proposals`' existing separate worked/not_worked tracking is untouched.
- No revert-detection (noticing that merged code was later reverted on GitHub) — no existing infrastructure for this (would need webhook/polling), and it's a natural future extension once the ledger shape below is in place, not a v1 requirement.
- No change to `LongTermLearningEngine` in this pass — it stays JSON-file-backed as-is. If it's ever migrated to Postgres, `reward_events` and its per-model/per-category aggregations would be a natural fit to fold in there rather than staying a separate module forever, but that migration is not part of this work.

## Data model

One new migration, one new table:

```sql
CREATE TABLE reward_events (
  id SERIAL PRIMARY KEY,
  build_request_id INTEGER NOT NULL REFERENCES build_requests(id) ON DELETE CASCADE,
  source TEXT NOT NULL,        -- 'task_review' | 'terminal_outcome'
  model_used TEXT,             -- which Groq model drafted the code this event is about
  category TEXT NOT NULL,      -- classified from the objective text, see below
  reward_value INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX reward_events_model_idx ON reward_events(model_used);
CREATE INDEX reward_events_category_idx ON reward_events(category);
CREATE INDEX reward_events_source_idx ON reward_events(source);
```

Every downstream consumer (dashboard, model preference, category caution, confirmation gate) is a **read-side aggregation** over this one table — no separate scoring/state tables. This mirrors `command_proposals`' existing shape (one write path, several read aggregations, e.g. `getRecentOutcomeSuccessRate`).

**Reward values:**
- `task_review` — one event per `reviewTaskDiff` call (i.e. per attempt, not just the final one for a task): approved → **+1**, rejected → **-1**. A genuinely rejected draft is a real negative signal even if a later retry fixes it.
- `terminal_outcome` — one event when a build request reaches a terminal status: `qa_complete` → **+2** (cleared review, human approval, *and* QA), `rejected_at_code` → **-2** (a human explicitly rejected the code). `error` (infra/timeout failures) is **not recorded** — a technical failure isn't a genuine reflection of code quality and would pollute the model/category signal with noise unrelated to what's actually being measured.

**Category classification** (`classifyTaskCategory(objective: string): string`, pure function, no LLM call): simple keyword matching against the objective text — `"migration"`/`"schema"` → `database`, `"UI"`/`"dashboard"`/`"frontend"` → `frontend`, `"auth"`/`"security"`/`"permission"` → `security`, otherwise `general`. Computed once per coding session, before coding starts (so it's available for the prompt-caution injection), and reused unchanged when tagging that session's reward events afterward.

## Components

**`src/kernel/state/reward-events-repo.ts`** (new):
- `recordRewardEvent(buildRequestId, source, modelUsed, category, rewardValue): Promise<void>` — the one write path. Fire-and-forget from callers' perspective: internally try/catch + telemetry warning on failure, matching `extractAndStore`/`extractSelfReflection`'s existing pattern. A failure to record must never block the coding loop or fail a build request.
- `getModelPreferenceOrder(candidates: string[]): Promise<string[]>` — reorders `candidates` by descending average `reward_value` over each model's most recent 50 events. A model with zero events gets a neutral score of exactly 0, so — via a stable sort — it keeps its original relative position among other unscored models. Degrades to `candidates` unchanged on any DB failure or with no data at all.
- `getCategoryScore(category: string): Promise<{ score: number; count: number } | null>` — average `reward_value` + event count for one category. `null` means "no data yet," never treated as a score of 0.
- `getOverallScore(source?: "task_review" | "terminal_outcome"): Promise<{ score: number; count: number } | null>` — same shape, optionally filtered to one source.

**`src/runtime/groq-agent-client.ts`**:
- `callGroqAgentChat(groq, messages, tools, modelOrder?)` — new optional 4th parameter overriding `DEFAULT_MODELS` when supplied. Existing call sites that don't pass it are unaffected.
- `AgentChatResult` gains `modelUsed: string | null`, read from the Groq chat-completion response's own `model` field in `parseGroqAgentResponse` — this is how a caller learns which model in the fallback chain actually answered.

**`src/executive/coding-agent.ts`**:
- `runCodingAgent` classifies `category` from `objective` once at the top, then calls `rewardEventsRepo.getModelPreferenceOrder(DEFAULT_MODELS)` once for the whole session; the resulting order is threaded into every `callGroqAgentChat` call in that session (both the per-task loop and the flat-loop fallback), and the resolved `modelUsed` from the first successful call is reused for every reward event this session records (a session doesn't switch models mid-flight).
- Both the per-task loop's and the flat loop's system prompts get one conditional extra sentence when `getCategoryScore(category)` has enough data (min 3 events) and a meaningfully negative average (below -0.3, say): *"Past sessions touching {category} work have had a rough track record — be extra careful here."* Omitted entirely otherwise — no neutral filler sentence when there's nothing to say.
- Immediately after each `reviewTaskDiff` call (in the per-task loop), record a `task_review` event with that session's `modelUsed` and `category`.

**`src/kernel/state/build-requests-repo.ts`**:
- `recordQaReview` (on success, → `qa_complete`) and `rejectCode` (→ `rejected_at_code`) each record one `terminal_outcome` event immediately after their status-changing UPDATE succeeds, using the build request's own stored data to recover `model_used`/`category` (both need to be threaded through — see Open questions for exactly how `model_used` survives from the coding session to this later point, since these functions run well after `runCodingAgent` returns).

**`src/executive/autonomous_executive.ts`**:
- `confirmDirection`'s coding-start logic (currently: `markCoding` → `runCodingAgent` → `recordCodeDraft` → notifications) is extracted into a private `startCoding(confirmed, directionNotes, username)` helper, behaviorally identical to today's inline code.
- After `recordDirectionConfirmed` succeeds and before calling `startCoding`, check `rewardEventsRepo.getOverallScore("terminal_outcome")`. If it has at least 3 recorded outcomes and a meaningfully negative average (below -0.5, say — most recent outcomes trending toward rejection), return a caveat message (e.g. *"Before I start coding, sir — my recent track record here has been rough ({score} over the last {count} attempts). Want me to proceed anyway, or reconsider the plan first?"*) **without** calling `startCoding` — the build request is left sitting in `direction_confirmed`.
- At the top of `confirmDirection`, before the normal `getLatestAwaitingConsult` lookup, check for a build request already in `direction_confirmed` for this user (a new `buildRequestsRepo.getLatestPendingRewardGate(username)`). If found, that means a prior call already paused here — proceed straight to `startCoding` using that row's already-stored `direction_notes`, treating this second call as the user's explicit "go ahead anyway." No new tool, no new status value — `direction_confirmed` sitting unconsumed for more than an instant only ever happens via this gate, since the normal flow moves through it immediately.

**Dashboard**: new `GET /api/reward/summary` route returning overall/per-model/per-category breakdowns, gated behind a new `reward.read` capability (auto-granted to admin at startup, same as every other capability added this session). One new panel in the Operations tab, alongside Self-improvement/MCP servers — numbers only (overall score, a small per-model table, a small per-category table), no charts or history list, matching "just report it honestly" without over-building the UI.

## Data flow (one walkthrough)

1. User confirms direction on a `database`-related build request. `confirmDirection` checks `getOverallScore("terminal_outcome")` — no data yet (fresh deployment) → proceeds straight to `startCoding`.
2. `runCodingAgent` classifies `category = "database"`, calls `getModelPreferenceOrder(["llama-3.3-70b-versatile", "llama-3.1-8b-instant"])` — no data, order unchanged.
3. Task 1's first draft is rejected by `reviewTaskDiff` → `recordRewardEvent(id, "task_review", "llama-3.3-70b-versatile", "database", -1)`. The fix attempt is approved → `recordRewardEvent(id, "task_review", "llama-3.3-70b-versatile", "database", +1)`.
4. The build request reaches `qa_complete` → `recordRewardEvent(id, "terminal_outcome", "llama-3.3-70b-versatile", "database", +2)`.
5. Weeks later, after enough `database`-tagged sessions have gone badly: a new database-related objective is confirmed. `getOverallScore("terminal_outcome")` now shows a real negative average → `confirmDirection` pauses and asks first. Once the user says go ahead, the per-task loop's system prompt also carries the extra caution sentence, and if `llama-3.1-8b-instant` has meanwhile built up a better track record than the 70b model, `getModelPreferenceOrder` tries it first instead.

## Error handling

Every read aggregation follows this codebase's existing degrade-cleanly convention: no live Postgres, or zero recorded events, returns `null` / an unchanged model order / no caution sentence — never a thrown error, never treated as "0 reward." The confirmation gate and prompt-caution injection are strictly additive: on any failure they silently fall back to today's unconditional behavior (start immediately, no caution sentence) rather than blocking a build request or crashing a coding session.

## Testing

- **Unit**: `classifyTaskCategory` (pure — table of objective strings → expected category) and the reward-value constants/mapping, as pure functions with no DB dependency.
- **Repo degrade-cleanly tests** (existing pattern, no live DB in `tests/index.test.ts`): all three read aggregations return their documented "no data" fallback; `recordRewardEvent` doesn't throw.
- **DB-integration test** (new, in `tests/db-integration.test.ts`, real Postgres): record a realistic mix of events across two models and two categories, confirm `getModelPreferenceOrder` actually reorders correctly, and `getCategoryScore`/`getOverallScore` compute real averages against real rows.
- Existing `coding-agent`/`groq-agent-client` tests are unaffected — every new parameter is optional and defaults to today's behavior.

## Open questions for the implementation plan

- Exact mechanism for `model_used`/`category` surviving from `runCodingAgent` (coding time) to `recordQaReview`/`rejectCode` (review time, potentially much later, driven by a human action not the coding session itself) — likely two new nullable columns on `build_requests` (`coding_model_used`, `task_category`) populated once when the code draft is recorded, read back by the terminal-outcome recording calls. This is a small, mechanical addition the implementation plan should size and confirm rather than something requiring further design discussion.
- Exact numeric thresholds above (`-0.3` for the prompt caution, `-0.5` and a minimum of 3 for the confirmation gate) are reasonable starting points, not empirically tuned — worth a comment in the code saying so, the same way `MAX_CONTAINER_LIFETIME_MS` and similar constants elsewhere in this codebase are documented as "a first-pass number, not carefully tuned."
