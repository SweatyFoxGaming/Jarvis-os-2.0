# Vision

> **Jarvis is an Autonomous Intelligence Operating System designed to become the
> trusted executive partner for every user.**
>
> Unlike traditional AI assistants that simply answer questions or execute
> commands, Jarvis is built to understand, reason, plan, and act with purpose.
> It continuously learns from experience, remembers what matters, coordinates
> specialized capabilities, and makes intelligent decisions while presenting
> itself as a single, unified intelligence.
>
> Our vision is to create an operating system where artificial intelligence
> moves beyond conversation and becomes a true partner — capable of managing
> knowledge, orchestrating complex workflows, anticipating needs, and helping
> people achieve more with confidence and clarity.
>
> Every architectural decision is guided by four principles:
>
> - **One Intelligence** — The user interacts with a single entity: Jarvis.
>   Internal complexity remains invisible.
> - **Executive Thinking** — Jarvis observes, reasons, plans, delegates,
>   executes, and learns before acting.
> - **Continuous Learning** — Every interaction strengthens Jarvis, transforming
>   information into lasting knowledge and better decisions.
> - **Human-Centered Design** — Powerful intelligence delivered through a calm,
>   intuitive, and trustworthy experience.
>
> Jarvis is not being built as another chatbot. It is being engineered as the
> foundation for a new generation of autonomous intelligence — an operating
> system that grows alongside its user and becomes an indispensable partner for
> work, creativity, decision-making, and everyday life.

The vision statement above is the project owner's own, unedited. Everything below
is an honest read of the current codebase (as of the 2026-07-17 security/architecture
review and the fixes that followed it) against these four principles — where they
hold up, where they don't yet, and what closes the gap.

## Current state vs. the four principles

**One Intelligence** — partially true, and thin under inspection. `/api/chat` is
a single entry point with one streaming response, so at the surface it reads as
one entity. But the internals aren't invisible: Settings exposes
`llmMode: local-first/online-first/strictly-local/strictly-online` as something
the *user* configures, and the Executive Board, Long-Term Learning, and Memory
systems each have their own disconnected API surface and UI tab. Confirmed by
reading the code: `/api/chat` never calls the executive planner, the learning
engine, or the memory store. They're four separate features today, not
sub-processes of one orchestrating mind.

**Executive Thinking** (observe → reason → plan → delegate → execute → learn) —
2 of 6 verbs are real, 1 is real-but-disconnected, 3 don't exist yet:
- *Observe*: real (`MindKernel`/`CognitiveWorkspace` state), scoped to
  conversation text only — no file, calendar, or system awareness.
- *Reason*: real when a local LLM or Gemini is configured; canned keyword-matched
  templates otherwise (`src/cognition/local_engine.ts` — the out-of-the-box
  default state, not a rare fallback).
- *Plan*: real step decomposition exists (`src/execution/autonomous_executive.ts`),
  but lives behind a separate endpoint (`/api/executive/run`) — Jarvis doesn't
  decide mid-conversation that something needs planning.
- *Delegate*: doesn't exist. No mechanism routes a plan step to an actual
  capability.
- *Execute*: doesn't exist. The "Specialist Swarm" now honestly reports
  `"planned, not executed"` (fixed this pass — it previously claimed a
  fabricated "Green Compile"). Nothing in the codebase writes a file, calls an
  API, or takes an action on its own initiative.
- *Learn, automatically*: doesn't exist. `learningEngine.optimizeWorkflow` /
  `logMistake` / `updateStylePreference` are only ever called from the dedicated
  `/api/learning/*` routes — never from `/api/chat`. Learning only happens if
  something external explicitly calls those endpoints by hand.

**Continuous Learning** — the largest gap. "Every interaction strengthens
Jarvis" implies an automatic loop; there isn't one. The memory store's only
`INSERT` path is a one-time seed of 3 demo records — nothing turns a real
conversation into a new memory. Learning entries now persist correctly to disk
(fixed this pass) but nothing writes to them automatically, and nothing reads
them back into a future response either — style preferences are stored and
displayable, never consulted when generating one.

**Human-Centered Design** ("confidence and clarity") — the UI itself is calm
and polished; that part holds up. The confidence score meant to deliver
"clarity" is fabricated: `memoryConfidence: ai ? 0.98 : 0.8, toolConfidence: 1.0`
— fixed inputs keyed only on whether a Gemini key is configured, not a
measurement of what actually happened in the request. Before this pass it was
worse (claiming successful builds that never ran, described above); it's now
honestly labeled where fixable, but a hardcoded number still isn't the real
signal the vision calls for.

**Bottom line:** the current build is closer to *a well-built chat console with
several disconnected demo panels wearing the names of an executive AI system*
than to the partner described above. That's not a knock on what's here — auth,
persistence, a real multi-backend chat loop, telemetry, and working GitHub/email/TTS
integrations are genuinely solid foundations as of this pass — it's an honest
distance reading so the next work is aimed at the real gap: **delegation,
execution, and an automatic learning/memory loop**, not more surface area.

## What closes the gap, mapped to the four principles

### 1. One Intelligence → one orchestration loop
Replace four independent API surfaces (chat / executive / learning / memory)
with one: `/api/chat` internally decides when to consult memory, invoke
planning, delegate to a capability, and record what it learned — the seams
disappear because there's one loop, not because the UI hides four of them.
Also pull the LLM-backend choice (local/cloud/simulated) behind the curtain as
an implementation detail rather than a setting the user manages.

### 2. Executive Thinking → real delegation and execution
The single highest-leverage change: a tool-calling loop. Gemini supports
function calling; most local models via Ollama do too. Give the LLM a manifest
of the working integrations (`src/integrations/github.ts`, `email.ts`, `tts.ts`)
as callable tools, let it choose and invoke them, feed results back in. That
turns "[Coding Swarm — planned, not executed]" into an assistant that actually
opens the PR.

**Ships together with this, not after it:** a permission/capability model.
Extend the audit log (already real) into a grant system — "Jarvis may create
GitHub issues" is an explicit, revocable, logged permission, not an implicit
consequence of setting `GITHUB_TOKEN`. An executive that can act and can't be
scoped is the fastest way to lose the trust the vision is named after.

### 3. Continuous Learning → close the write *and* read loop
Two halves, both currently missing:
- **Write**: after each `/api/chat` turn, automatically extract what's worth
  remembering and what was learned, instead of requiring a manual API call.
- **Read**: actually consult that stored state (style preferences, past
  mistakes, prior workflows) when generating the *next* response. Recording
  without reading isn't learning, it's logging.

Real memory belongs here too: `docker-compose.yml` runs `pgvector/pgvector:pg16`
— a vector database — currently used as a plain relational table with zero
embeddings. Embedding conversation turns and retrieving them semantically (via
Gemini's embedding endpoint, or a local model through Ollama) is what turns
"Jarvis forgets everything past the last 50 messages" into "Jarvis remembers
what you told it three weeks ago" — and the infrastructure for it is already
running, unused.

### 4. Human-Centered Design → a confidence signal that means something
Replace the fixed-input confidence formula with one derived from something
real: retrieval quality, tool-call success/failure, model-reported certainty.
"Clarity" isn't served by a number that doesn't move.

### Prerequisite underneath all four: sessions
`MindKernel`, `ObservationPlatform`, and `CognitiveWorkspace` are process-wide
singletons — two people talking to this Jarvis right now would interleave into
the same conversation history and kernel state. "Trusted executive partner for
**every user**" is architecturally impossible until state is scoped per
session/user. This is unglamorous and belongs early: retrofitting it after
building tool-calling, memory, and learning on top of global state costs far
more than doing it first.

### Status update (implemented since the gap analysis above was written)

Everything in "What closes the gap" above has since been built and live-verified
against the real Postgres/Docker/GitHub/IMAP infrastructure — not just unit-tested:

- **Session-scoped state**: `src/cognition/session.ts`. Verified live — two
  concurrent users' conversations no longer interleave.
- **Tool-calling + permission model**: `src/execution/tools.ts` /
  `permissions.ts`, wired into `/api/chat`'s Gemini branch (and attempted,
  with graceful fallback, on local models). Verified live end-to-end: denied
  without a grant, executes a real GitHub API call with one. The one part
  *not* independently verified in this environment is the LLM's own decision
  to invoke a tool, since no `GEMINI_API_KEY` was configured to test against
  and the local model available here doesn't support tool calling.
- **Automatic learning/memory loop**: `src/cognition/memory-store.ts`, backed
  by a real `pgvector` table (`CREATE EXTENSION vector` succeeded live).
  Every non-simulated chat turn is embedded and stored; future turns retrieve
  by similarity. Requires a working embedding provider to actually produce
  results — see the note below, this is currently blocked in this environment
  by the same Ollama bind-address issue as chat.
- **Real confidence signal**: `/api/chat` now computes confidence from which
  backend actually answered, whether memory had hits, and tool-call success
  rate — verified live returning different values (84% on a simulated-path
  reply, not the old fixed ~95-100%).
- **Scheduler**: `src/execution/scheduler.ts`. A real job (`email-watch`)
  polls the configured IMAP mailbox every 5 minutes and pushes a notification
  on new mail — verified live against the real Gmail account in `.env`
  (~5s per IMAP fetch, confirmed firing on schedule).

**Correction to the original version of this doc**: it claimed speech-to-text
"doesn't exist anywhere in the codebase." That was wrong — `/api/voice-input`
already calls Gemini's multimodal API to transcribe audio for real when
`GEMINI_API_KEY` is set. The actual gap is narrower: there's no *local/offline*
STT (e.g. Whisper) to match the local-first chat pattern, so voice input
degrades to a canned string in the default (no-cloud-key) configuration. Not
built in this pass — it needs a new dependency (a Whisper model or sidecar)
that would be irresponsible to add without being able to verify it runs
cleanly in the target Docker image.

**Newly discovered, blocking local LLM entirely in this environment**: Ollama
on the host binds to `127.0.0.1:11434` only. No container — regardless of the
`host.docker.internal` mapping already in `docker-compose.yml` — can reach a
loopback-only bind. This blocks local chat *and* local embeddings, live-verified
via `docker exec ... fetch(...)` returning connection-refused. Fix is
`OLLAMA_HOST=0.0.0.0` plus an Ollama restart (see README's Quickstart) — a
host-level change intentionally left for the operator to decide on, since it
changes what's reachable on the host's network.

## What I'd deliberately not do

Resurrect the older, larger architecture described in the archived docs
(`docs/archive/` — a `ChiefOfStaff` scheduler, a department/agent hierarchy,
`SecureMemoryStore`). That design was torn out for a reason this review
couldn't fully reconstruct, and its replacement — a single Express app with
focused modules — is easier to reason about and extend. Every gap above closes
by adding real capability to the current architecture, not by rebuilding a more
complex one that was already abandoned once.

## What's left

1. **Local/offline STT** (Whisper) — the one item from the original list not
   yet built; see the correction above.
2. **Fix the Ollama bind address** on the host (operator decision, one line +
   a restart) — unblocks local chat and local embeddings at once.
3. **Persist capability grants to Postgres** — currently in-memory, reset on
   restart; noted as a known limitation in the README.
4. **Extend automatic learning capture beyond memory** — style/mistake
   learning is still only written via explicit `/api/learning/*` calls, not
   automatically inferred from a conversation the way memory now is.
