# Vision: where Jarvis OS could go from here

A proposal, not a spec — written after a full-repo security/architecture review
(2026-07-17) that fixed the immediate problems and found the codebase in decent
shape underneath them: a real Express app, a real (if shallow) test suite, and
now a real Postgres instance and working GitHub/email/TTS integrations. The
question this doc answers: if "Jarvis" means the thing everyone actually pictures
— a capable, proactive personal AI, not a chat window with a dashboard — what's
the honest path from here to there?

## The gap between "chat" and "assistant"

Right now, every feature in this app is **reactive and narrated**: you send a
message, something plans a response (sometimes a real LLM, sometimes a template),
and it tells you what it *would* do. Nothing acts on your behalf, nothing runs on
its own schedule, and nothing remembers you beyond a flat list of pending records.
That's the actual distance between what's here and "Jarvis" — not model quality,
not UI polish. Closing it is four separate, buildable pieces of work.

## 1. Give the executive real hands — tool-calling, not narration

`POST /api/executive/run` currently decomposes an objective into steps and
describes what each step *would* do (see `README.md` → "Known limitations"). The
pieces to make it real already exist as of this pass: `src/integrations/github.ts`,
`email.ts`, and `tts.ts` are working, callable functions. The missing piece is a
tool-calling loop: give the LLM (Gemini already supports function calling; most
local models via Ollama do too) a manifest of these integrations as callable
tools, let it choose and invoke them, and feed results back in. That turns
"[Coding Swarm — planned, not executed] Would write templates" into an assistant
that actually opens the PR.

This is the single highest-leverage change in this list — everything below
assumes an executive that can act, not just plan.

**Guardrail that has to ship alongside it:** a permission/capability model.
Extend the audit log (already real, already working) into a grant system —
"Jarvis may create GitHub issues" is an explicit, revocable, logged permission,
not an implicit consequence of setting `GITHUB_TOKEN`. Don't ship tool-calling
without this; an executive that can act and can't be scoped is the fastest way
to regret this list.

## 2. Give it real memory — the database already paid for this

`docker-compose.yml` runs `pgvector/pgvector:pg16` — a vector database — and as
of this pass, the app finally talks to it. But `src/data/memory-repo.ts` uses it
as a plain relational table; the pending-records "memory" is a flat approve/reject
queue, not retrieval. The natural next step: embed conversation turns and
approved facts (via Gemini's embedding endpoint, or a local embedding model
through Ollama), store the vectors in a `memory_embeddings` table, and have chat
retrieve semantically relevant history before responding instead of relying on
the fixed 50-entry in-memory buffer in `workspace.ts`. This is what turns "Jarvis
forgets everything on restart" into "Jarvis remembers what you told it three
weeks ago" — and the infrastructure for it is already running, unused.

## 3. Give it a clock — proactive, not just reactive

Everything today waits for a chat message. A scheduler (even a simple in-process
cron via `node-cron`, or a proper job queue if this ever needs to survive
multi-instance deployment) is what lets Jarvis check your email and summarize
what's urgent, post a morning briefing, or watch a GitHub repo for CI failures
without being asked. `/api/notifications` already exists as an endpoint — right
now it's a stub returning an empty array; a scheduler is what gives it something
real to report.

## 4. Give it ears — voice input is currently not implemented at all

TTS (speech out) is real as of this pass. Speech *in* is not: `/api/voice-input`
returns a canned string telling you to configure `GEMINI_API_KEY` — there's no
speech-to-text anywhere in the codebase. Whisper (local, via a small Python
sidecar or `whisper.cpp`) or a cloud STT API closes this loop and makes the
`/mind` voice-console UI (which already has a working conversational interface)
actually voice-driven instead of text-only with a voice-shaped UI around it.

## Prerequisite fix: sessions

`MindKernel`, `ObservationPlatform`, and `CognitiveWorkspace` are process-wide
singletons — two people talking to this Jarvis at once currently interleave into
the same conversation history and the same kernel state. None of the above (a
scheduler running proactive tasks, a real permission model, semantic memory)
holds together well until state is scoped per session/user rather than global.
This is unglamorous and should happen early, not last — retrofitting it after
building scheduling/memory/tool-calling on top of global state is much more
expensive than doing it first.

## What I'd deliberately not do

Resurrect the old, larger architecture described in the archived docs
(`docs/archive/` — a `ChiefOfStaff` scheduler, a department/agent hierarchy,
`SecureMemoryStore`). That design was torn out for a reason this review couldn't
fully reconstruct, and its replacement — a single Express app with focused
modules — is actually easier to reason about and extend. The four items above
get you further toward "a capable, proactive personal AI" by adding real
capability to the current architecture than by rebuilding a more complex one
that was already abandoned once.

## Suggested order

1. Session-scoped state (prerequisite, not visible to users, but everything
   else compounds on top of it)
2. Tool-calling executive + permission model (the biggest visible capability jump)
3. Semantic memory via pgvector (makes every subsequent conversation better)
4. Scheduler (turns "assistant" into "proactive assistant")
5. Voice input (closes the loop the `/mind` UI already implies exists)
