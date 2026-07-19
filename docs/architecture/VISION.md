# Jarvis 50-Year Vision

## Building the World's Most Trusted Intelligence

> Our vision is to create the world's most trusted autonomous intelligence—an
> operating system that evolves from a personal executive into the cognitive
> foundation for individuals, businesses, and society.
>
> Jarvis is being engineered to understand, reason, learn, and collaborate
> with people over a lifetime. It will not simply answer questions or execute
> commands; it will build knowledge, anticipate needs, coordinate complex
> systems, and help people make better decisions while remaining transparent,
> trustworthy, and aligned with human goals.
>
> As technology evolves, Jarvis will seamlessly integrate with new models,
> devices, robots, digital environments, and future computing platforms
> without losing its identity. Regardless of how users interact—through text,
> voice, augmented reality, robotics, or technologies yet to be invented—they
> will always experience a single, consistent intelligence.
>
> Our long-term ambition is to establish Jarvis as the universal cognitive
> operating system: a platform capable of orchestrating millions of
> capabilities, managing vast networks of knowledge, and empowering people and
> organizations to solve problems that are impossible to tackle alone.
>
> Success will not be measured by the number of features Jarvis possesses, but
> by the trust it earns, the decisions it improves, and the positive impact it
> has on the lives of those who rely on it.
>
> Over the next fifty years, our mission is to transform artificial
> intelligence from a reactive tool into a lifelong executive partner—one
> that grows alongside humanity and helps shape a future where intelligence is
> accessible, dependable, and designed to amplify human potential.

The vision statement above is the project owner's own, unedited, updated
2026-07-19. Everything below is an honest read of the current codebase,
current as of the 2026-07-17 "close every remaining gap" pass — it predates
this vision update and was written against a prior version of the statement
above (organized around four named principles — One Intelligence, Executive
Thinking, Continuous Learning, Human-Centered Design — that this revision no
longer states in those exact terms, though the same substance carries
through). The technical claims below are still accurate about the codebase
itself; they just haven't been re-organized around this new statement's own
framing yet. Every claim below was live-verified against the real running
Postgres/Docker/Gemini/GitHub/IMAP infrastructure this pass, not just read
from source or unit-tested; where a claim is still qualified, the
qualification is the honest boundary, not a gap in how it was checked.

## Current state vs. the four principles

**One Intelligence.** `/api/chat` is genuinely the single entry point now: it
consults memory, applies learned style preferences, and can invoke GitHub,
email, TTS, or objective planning as tools within the same request — a user
never has to know which of those four "surfaces" a given ask belongs to,
because chat itself decides. The one place internal structure still shows
through on purpose is the `llmMode` setting (local-first / online-first /
strictly-local / strictly-online) — a deliberate operator knob, not leftover
plumbing, so a user or operator can pin behavior (privacy, cost, latency)
without needing to understand the routing logic underneath it.

**Executive Thinking** (observe → reason → plan → delegate → execute → learn)
— all six verbs are real and reachable from chat:
- *Observe*: real (`MindKernel`/`CognitiveWorkspace`/`SessionState`), scoped
  per user, still limited to conversation text — no file/calendar/system
  awareness beyond what's already visible in this repo.
- *Reason*: real via the local `llama-cpp` model (default) or Gemini; canned
  templates only as the last-resort fallback if both are unreachable.
- *Plan*: real step decomposition (`src/execution/autonomous_executive.ts`),
  reachable both as its own endpoint (`/api/executive/run`) and — as of this
  pass — as a `decompose_plan` chat tool, so "make me a step-by-step plan for
  X" reaches it directly mid-conversation.
- *Delegate*: real. Gemini's function-calling can invoke GitHub (read/create
  issue), email (send), TTS (speak), and now objective planning, each gated by
  an explicit, revocable, Postgres-persisted capability grant.
- *Execute*: real for the four capabilities above; still honestly narrated
  ("planned, not executed") for the free-text multi-step "specialist swarm"
  planner, which doesn't have structured arguments to act on — see "What I'd
  deliberately not do" below for why that boundary stays.
- *Learn, automatically*: real. A reflection pass after every real chat turn
  judges whether the exchange revealed a style preference or a genuine
  mistake+fix, and only then writes it — no manual `/api/learning/*` call
  required.

**Continuous Learning** — both halves of the loop close automatically now:
- **Write**: every real (non-simulated) chat turn is embedded into
  Postgres/pgvector for semantic recall, and separately judged by a
  lightweight Gemini reflection call for style/mistake capture — two
  independent automatic write paths, not one manual endpoint.
- **Read**: memory hits and learned style preferences are both pulled into
  the system prompt on the next turn. Recording without reading isn't
  learning; both directions are live-verified working.
- **Restart durability**: conversation history now persists to Postgres and
  rehydrates the first time a user's session is touched after a restart —
  live-verified via a simulated process restart. The "live" cognitive state
  (current thought, active plan step) deliberately does not persist — it's a
  per-turn narration of what's happening right now, not information a restart
  should fabricate continuity for.

**Human-Centered Design** ("confidence and clarity") — the UI is calm and
polished, and the confidence score is a real per-turn signal (which backend
answered, memory hit rate, tool-call success rate), not a fixed input. The
trust hazard this document previously flagged as the single highest-priority
gap — the local model fabricating a plausible-sounding fake tool result
instead of admitting it had no tool access — is now fixed (see below), which
was the one part of "clarity" that was actively working against the vision
rather than just falling short of it.

**Bottom line:** the four principles now hold up under inspection rather than
being aspirational. What's left (below) is genuinely secondary — none of it
is a user-facing integrity problem the way the trust hazard was.

## The trust hazard — fixed this pass

Previously: in the default `local-first` configuration, asking Jarvis to use
a tool ("check that GitHub repo...") would hit the local model first, which
has no tool access and — rather than declining — would confidently invent a
plausible-sounding fake result (invented branch names, a confidently wrong
"the repo is public" claim), indistinguishable from a real answer without
checking the source.

Fixed with two layers, both live-verified:
1. **Smart routing** — a message that looks tool-shaped is routed to Gemini
   first when it's configured and the user hasn't explicitly forced
   strictly-local mode, so the request gets real capability instead of local
   hallucination. Verified: five representative scenarios (tool-shaped +
   Gemini available, plain chat, explicit strictly-local override, no Gemini
   configured, offline mode) all route exactly as designed.
2. **An honest local system prompt** — as the safety net for whenever Gemini
   genuinely isn't available (strictly-local mode, or no API key), the local
   model is told explicitly it has no tool/live-data access and to say so
   rather than invent an answer.

## What's implemented and live-verified this pass

- **Capability grants persist to Postgres** (`capability_grants` table) — a
  restart no longer resets everyone's grants back to just the admin defaults.
  Verified: a grant survives a simulated restart (fresh in-memory cache
  reload from the DB), and a revoke actually deletes the row. Also verified
  the migration path for a *newly added* capability on an already-existing
  table (`executive.plan`, added this pass) — it backfills for admin instead
  of silently leaving it ungranted.
- **Automatic style/mistake learning capture** (`src/cognition/reflection.ts`)
  — verified live against the real Gemini API: correctly extracted an actual
  mistake discussed earlier in a conversation and a stated style-preference
  change (flipping naming convention/architecture to values that didn't
  already match, to rule out a false-positive from an already-correct
  baseline), and correctly wrote nothing for a neutral, off-topic exchange —
  i.e. it discriminates, it doesn't just always fire.
- **Conversation history survives a restart** — persisted to a new
  `conversation_history` Postgres table, rehydrated on first access per user.
  Verified: messages written in one process are rehydrated in the correct
  order by a fresh session lookup simulating a post-restart process.
- **Local/offline speech-to-text** via a new `whisper-cpp` Docker service
  (`ghcr.io/ggml-org/whisper.cpp`, a genuine bundled ~142MB whisper-base.en
  model, no separate download) — the offline-first counterpart to Gemini's
  multimodal transcription, matching the chat local-first pattern. Verified
  with a full real round trip: synthesized speech via the actual `tts`
  container, fed through the real `whisper-cpp` container via the live
  `/api/voice-input` endpoint with offline mode forced on, got back the
  correct transcription.
- **Objective planning as a real chat tool** (`decompose_plan`) — the last
  disconnected surface. Verified two ways: `executeTool()` directly (grant
  gating, session lookup, plan generation all correct), and — the more
  meaningful test — Gemini's own function-calling reasoning choosing this
  tool and correctly extracting the objective from a natural, un-hinted
  sentence ("make me a step-by-step plan for launching a small podcast").
- **Full stack, brought up together from a clean state** — all five
  containers (`api`, `postgres`, `tts`, `llama-cpp`, `whisper-cpp`) in an
  isolated parallel instance (distinct container names/ports/volume, zero
  disruption to the live deployment), confirming a genuinely fresh install
  initializes its schema, seeds capability grants, and serves real chat
  (including a live tool call — `decompose_plan` — inside a real Gemini
  function-calling turn) and real offline voice transcription correctly.

## What I'd deliberately not do

Resurrect the older, larger architecture described in the archived docs
(`docs/archive/` — a `ChiefOfStaff` scheduler, a department/agent hierarchy,
`SecureMemoryStore`). That design was torn out for a reason this review
couldn't fully reconstruct, and its replacement — a single Express app with
focused modules — is easier to reason about and extend.

Make the free-text "specialist swarm" planner (inside `decompose_plan`/
`/api/executive/run`) actually write files or run commands from a plan
string. A plan step like "Implement operational components" doesn't carry
the structured arguments (which file, which repo, which recipient) that real
delegation needs — guessing them from keywords would be less honest than the
current narrated-plan behavior, not more capable. Real execution stays scoped
to the four tools that do have structured arguments a model can extract
directly from conversation (GitHub, email, TTS, planning).

Build full multi-instance/horizontally-scaled session state. Conversation
history now survives a restart of the single `api` container this project
actually runs as — that's the real, noticeable continuity gap for this
architecture. Building for multiple concurrent `api` instances sharing live
session state would be solving a scaling problem this single-Docker-host
project doesn't have yet, at the cost of real complexity today.

## What's left

Nothing that's a user-facing integrity problem. What remains is smaller and
more clearly scoped:

1. **Semantic memory embeddings require `GEMINI_API_KEY`** — the bundled
   `llama-cpp` service doesn't serve embeddings by default (would need a
   second instance configured with `--embeddings` and an embedding-capable
   model). Not a bug, just a gap in the fully-offline configuration: chat and
   voice both have real local-first paths now; memory's local embedding path
   doesn't yet.
2. **If you swap `llama-cpp` for a host-run Ollama** (an explicit opt-in via
   Settings, not the default), Ollama's default `127.0.0.1`-only bind means
   no container can reach it without also setting `OLLAMA_HOST=0.0.0.0` and
   restarting Ollama — documented in the README, an operator decision since
   it changes what's reachable on the host's network. The bundled `llama-cpp`
   service avoids this whole class of problem, which is why it's the default.
3. **The free-text executive planner stays narration-only**, on purpose —
   see "What I'd deliberately not do" above.
