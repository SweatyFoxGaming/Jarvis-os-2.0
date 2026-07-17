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

The vision statement above is the project owner's own, unedited. This document
has been rewritten twice now as work closed gaps against it — this version
reflects the state **after** a full-stack + real-browser verification pass
(isolated `docker compose up`, a real Gemini key, real GitHub/IMAP calls, a
real browser driving the actual UI), not just code review or unit tests. Where
a claim below says "verified live," that means it was actually observed
happening against real infrastructure in this session, not inferred from
reading the code.

## Current state vs. the four principles

**One Intelligence** — meaningfully closer, one real gap remains. `/api/chat`
now internally orchestrates three of the four systems that used to be
separate: it retrieves semantic memory, applies learned style preferences, and
can delegate to a real capability (GitHub/email/TTS) — all within one turn,
verified live. What's still a separate, disconnected surface by design:
`/api/executive/run` (the free-text objective planner) stays plan-only and
un-wired into chat on purpose — see "Executive Thinking" below for why. The
LLM backend choice (local/cloud) is also still a user-facing Settings toggle
rather than an invisible implementation detail.

**Executive Thinking** (observe → reason → plan → delegate → execute → learn)
— 5 of 6 are now real in some form:
- *Observe*: real, still scoped to conversation text only.
- *Reason*: real via either backend. Both independently verified live this
  session — Gemini (`gemini-3.5-flash`) and a local GGUF model served by the
  new `llama-cpp` Docker service (see below).
- *Plan*: real step decomposition, still behind the separate
  `/api/executive/run` endpoint, honestly labeled `"simulated": true` in its
  own response.
- *Delegate*: **now real.** `/api/chat` gives Gemini a manifest of real tools
  (`src/execution/tools.ts`) via function-calling, gated by a default-deny
  permission grant system. Verified live end-to-end: denied without a grant,
  then granted, then made a real GitHub API call and correctly reported the
  actual repo's default branch and visibility back to the user.
- *Execute*: real for the specific capabilities wired (GitHub read/issues/PRs,
  email send/read, TTS) — not general-purpose code execution. Verified live
  for GitHub and TTS.
- *Learn, automatically*: **partially real.** Every non-simulated chat turn is
  now embedded and stored in Postgres/pgvector automatically, and retrieved by
  similarity on later turns — verified live (a real embedding landed in the
  database, and a later question's decision trace showed `"Memory hits": 1`
  pulling the earlier exchange back in). Style preferences are now also
  automatically *applied* to every chat turn's system prompt. What's still
  manual-only: nothing automatically calls `logMistake`/`optimizeWorkflow` —
  that half of "learning" still requires an explicit `/api/learning/*` call.

**Continuous Learning** — the memory half of this (the one this doc previously
called "the largest gap") is now real and live-verified, both write and read.
The learning-*style* half is real but still one step removed from automatic:
correctly stored and consulted once set, but not yet inferred from a
conversation on its own.

**Human-Centered Design** ("confidence and clarity") — confidence is now
computed from what actually happened in a turn (which backend answered,
memory hits, tool success rate) instead of fixed inputs — verified live
returning genuinely different numbers across different real scenarios (84%,
92%, 97%, 72%) rather than a static ~95-100%. The UI itself held up well under
a real browser pass, with one exception below.

## What's real now, live-verified this session (not just built)

- **Session-scoped state** — two concurrent users' conversations no longer
  interleave (`src/cognition/session.ts`).
- **Offline-first local LLM** — `docker-compose.yml`'s new `llama-cpp` service
  serves a GGUF model straight from disk over the Docker network, sidestepping
  a real problem this session discovered: Ollama on a typical host binds to
  `127.0.0.1` only, which no container can ever reach regardless of Docker
  networking config. Verified live: a real, coherent, on-topic answer streamed
  back from local CPU inference through the full `api.py → server.ts →
  llama-cpp` stack.
- **Real tool-calling + permissions** (see "Executive Thinking" above).
- **Real semantic memory** via Postgres/pgvector — required fixing two live-only
  bugs neither static review nor curl testing caught: Gemini's function-calling
  follow-up was missing a `thought_signature` field the API now requires
  (400 on every multi-turn tool call), and the embedding model name
  (`text-embedding-004`) 404s against the current API — replaced with
  `gemini-embedding-001`.
- **A real confidence signal.**
- **A real scheduler** — `src/execution/scheduler.ts`'s `email-watch` job polls
  the actual configured Gmail inbox every 5 minutes and pushes real
  notifications on new mail; confirmed firing against the live account,
  including inside the admin UI's telemetry pane.
- **The full `docker-compose.yml` stack**, brought up together for the first
  time as a whole (previously only tested piecemeal) in an isolated parallel
  instance, with zero disruption to the live deployment.
- **XSS protection**, confirmed against a real injected `<img onerror>` payload
  in the live admin panel — renders as inert text, no script fires.

A real browser pass also caught a bug no API-level test could have: streamed
chat replies were rendering with no spaces between words (the client was
trimming the trailing space off every streamed word-chunk). Fixed in both
`index.html` and `mind.js`, confirmed visually.

## The one thing this pass found and did *not* fix

**In the default configuration, asking Jarvis to use a tool can produce a
confident, fabricated answer instead of a real one — and the user can't tell
the difference from the response alone.** `llmMode` defaults to `local-first`,
so a tool-using request hits the local model before Gemini ever sees it. The
local model has no tool access (see the README's note on why local tool-calling
isn't attempted — it's slow and unsupported by most local models). When asked
to "use your GitHub tool," it doesn't decline or defer to Gemini — it
hallucinates a plausible-sounding fake result (invented branch names, a
confidently wrong "the repo is public" claim) with the same tone and format as
a real answer. Live-verified side by side in this session: the exact same
prompt, only `llmMode` changed, produced a fabricated answer from the local
model and a correct, real answer (with an honest failure message when
ungranted) from Gemini.

This directly undermines "confidence and clarity" — worse than a gap, it's a
trust hazard, since it's indistinguishable from a real answer without checking
the source. Not fixed in this pass because closing it properly needs a design
decision, not a quick patch: either detect a tool-requiring intent and force
that turn through Gemini regardless of `llmMode`, or teach the local model's
system prompt that it has no tool access so it defers/declines instead of
inventing an answer, or both. Whichever direction, this should be the next
thing worked on — it's the single highest-leverage fix remaining, because
everything else in "Executive Thinking" now genuinely works when the honest
path is taken.

## What I'd deliberately not do

Resurrect the older, larger architecture described in the archived docs
(`docs/archive/` — a `ChiefOfStaff` scheduler, a department/agent hierarchy,
`SecureMemoryStore`). That design was torn out for a reason this review
couldn't fully reconstruct, and its replacement — a single Express app with
focused modules — is easier to reason about and extend.

## What's left

1. **Fix the local-model tool-hallucination trust hazard** (above) — highest
   priority, since it's a live, default-configuration integrity problem.
2. **Local/offline STT** (Whisper or similar) — cloud transcription works via
   Gemini; there's still no offline equivalent, so voice input isn't fully
   offline-first the way chat now is.
3. **Persist capability grants to Postgres** — currently in-memory, reset on
   restart.
4. **Automatic style/mistake learning capture** — memory now closes this loop
   automatically; style/mistake learning still requires an explicit
   `/api/learning/*` call.
5. **Durable, multi-instance session state** — `SessionState` is per-process
   in-memory; fine for a single container, but "trusted executive partner for
   every user" eventually implies state that survives a restart or scales
   past one instance.
