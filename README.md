# Jarvis OS

A self-hosted, offline-first AI assistant console: a FastAPI gateway in front of an
Express/TypeScript application, running in Docker alongside Postgres, a text-to-speech
service, and a local LLM server. Chat runs against a GGUF model you already have on
disk by default — no cloud account needed — with an optional cloud (Gemini) fallback.

This README describes what's actually in this repository and how to run it. If you find
another doc in this repo (or an old commit) describing a different architecture —
`src/main.py`, a `ChiefOfStaff` scheduler, a multi-agent department system — that's a
prior, now-replaced design. Treat this file and `docs/architecture/ROADMAP.md` as current.

## Architecture

```
┌─────────────────────────────┐        ┌──────────────────────────────┐
│  src/api.py (FastAPI :8000) │ proxy  │  src/server.ts (Express :3000)│
│  Spawns & supervises the    │──────▶ │  All real business logic:     │
│  Express process; falls     │        │  auth, chat, settings,        │
│  back to canned JSON if the │        │  observation, integrations    │
│  Express server is down     │        │                                │
└─────────────────────────────┘        └──────────────┬─────────────────┘
                                                        │
                        ┌───────────────────────────────┼───────────────────────────────┐
                        ▼                                ▼                                ▼
               ┌────────────────┐              ┌────────────────┐              ┌──────────────────┐
               │ Postgres        │              │ tts container   │              │ llama-cpp         │
               │ users, API keys,│              │ (openai-edge-   │              │ serves a GGUF     │
               │ memory records  │              │  tts)           │              │ model you provide,│
               └────────────────┘              └────────────────┘              │ entirely offline   │
                                                                                 └──────────────────┘
```

Gemini is the only piece that talks to the internet, and only if you set `GEMINI_API_KEY` —
everything else, including chat, runs fully inside this Docker network.

Only `src/api.py` and `src/server.ts` are in the request path. Several other directories
under `src/` (`bridge/`, `execution/planner.py`, `infrastructure/`) are leftover,
unimported fragments from an earlier design — see "Known limitations" below before
relying on anything not listed in "What's implemented."

## Quickstart

1. **Get a GGUF model** — anything from [Hugging Face](https://huggingface.co/models?library=gguf)
   works; a small quantized model (`Q4_K_M`, 2-4GB) is enough to get chat working, though
   expect CPU inference to be slow (tens of seconds to a couple minutes per reply on a
   modest machine — no GPU passthrough is configured here). Point `HOST_MODEL_DIR` (the
   directory) and `LOCAL_MODEL_FILE` (the filename) at it in `.env`.

2. **Copy the env template and fill in secrets:**
   ```bash
   cp .env.example .env
   ```
   At minimum, set `INTERNAL_API_KEY` (generate one with `openssl rand -hex 32`) and
   `HOST_MODEL_DIR`/`LOCAL_MODEL_FILE` from step 1 — the server refuses to start without
   the former, and chat falls back to a canned reply without the latter. Everything else
   in `.env.example` is optional and documented inline (GitHub/email/TTS integrations,
   Postgres, an optional cloud LLM fallback).

3. **Run it:**
   ```bash
   docker compose up -d --build
   ```
   This starts five containers: `api` (the app, ports 8000 and 3000), `postgres`
   (pgvector image, used for users/memory persistence), `tts` (text-to-speech, port
   5051), `llama-cpp` (serves your GGUF model), and `whisper-cpp` (offline speech-to-
   text — a real ~142MB whisper-base.en model ships inside that image, no separate
   download needed). `./start.sh` does the same thing and opens a browser tab. First
   boot pulls/loads the model, which can take a minute.

4. **Open the console:** `http://localhost:3000` (main console), `/admin`
   (operator panel), `/mind` (cognitive state graph). Port 8000 (the FastAPI
   gateway) only serves `/health`, `/props`, and `/api/*` — it doesn't proxy
   the frontend, so opening it directly 404s. Live-verified: this is the
   actual current behavior, not a typo carried over from an earlier draft.

5. **Prefer a different local backend (e.g. Ollama) instead?** Change the endpoint/model
   in the Settings tab — it's saved to `data/settings.json` and survives restarts. One
   thing to know if you go that route: Ollama binds to `127.0.0.1` only by default, which
   no container can reach (not even via `host.docker.internal`, which this compose file
   maps for exactly this case) — you'd need `OLLAMA_HOST=0.0.0.0` and a restart on the
   host for it to be reachable at all. The `llama-cpp` service above avoids this whole
   class of problem by running inside the same Docker network as everything else.

## What's implemented

- **Proactive briefing** (`GET /api/briefing`, `/api/briefing/history`): the one thing
  in this codebase that happens without a chat message triggering it first. An hourly
  scheduled job (`src/execution/scheduler.ts`) collects real signals (unread email via
  IMAP, GitHub notifications via the real `/notifications` API — both best-effort,
  one failing never blocks the other), prioritizes them with real urgency scoring
  (a GitHub review request or a stale unread email ranks above a routine comment),
  and synthesizes a short natural-language summary via Gemini when configured —
  degrading to a plain prioritized list, not a canned string, when it isn't. Also
  reachable mid-conversation as the `get_briefing` chat tool ("what's new today?").
  History persists to Postgres.
- **Chat**, with a three-tier fallback chain: your local `llama-cpp` model →
  `GEMINI_API_KEY` (if set) → a canned offline reply generator (keyword-matched
  templates, not a model — see "Known limitations"). Each turn retrieves relevant
  semantic memory and applies your learned style preferences before generating a
  reply. CPU inference of even a small (2-3B) local model is genuinely slow —
  live-measured at 90-130 seconds for a short reply on a modest machine — not a
  bug, just the tradeoff of offline-first, CPU-only local inference. A message
  that looks like it needs a real tool (GitHub, email, ...) is routed to Gemini
  first when it's available, rather than to the local model — which has no tool
  access and, left to answer such a request itself, was observed fabricating a
  plausible-sounding result instead of admitting it couldn't act. If forced into
  strictly-local mode (or Gemini isn't configured), the local model is told
  explicitly it has no tool access and to say so rather than invent an answer.
- **Sessions**: conversational state (current thought, attention, dialogue) is scoped
  per authenticated user — two people talking to Jarvis at once no longer interleave
  into the same state (`src/cognition/session.ts`). Conversation history specifically
  is persisted to Postgres and rehydrated on first access after a restart — the
  "live" cognitive state (current thought, active plan step) is not, since it's a
  per-turn narration of what's happening right now, not something a restart should
  pretend to remember.
- **Real delegation**: when Gemini is configured, chat supports function-calling
  against real capabilities (GitHub, email, TTS, and objective planning) — the
  model extracts structured arguments from the conversation and the server
  executes them for real, gated by a default-deny permission grant system
  (`GET/POST /api/permissions*`). Local models are not attempted for
  tool-calling: live-tested against a real local model, a tool-enabled request
  took over two minutes and the model ignored the tools entirely — a pure
  latency cost with no payoff for this class of model. Objective planning
  (`/api/executive/run`'s decomposition logic) is reachable as a `decompose_plan`
  tool too, so a plain chat request like "make me a step-by-step plan for X"
  triggers it directly — live-verified Gemini's own function-calling correctly
  chose this tool and extracted the objective from a natural sentence, not just
  a hand-written test calling it directly.
- **Semantic memory**: every real (non-simulated) chat turn is embedded and stored in
  Postgres/pgvector, then retrieved by similarity on future turns — requires an
  embedding provider to actually be reachable (Gemini, or a local model server with
  embedding support); degrades to no-op, not a crash, when neither is available. The
  bundled `llama-cpp` service doesn't serve embeddings by default (would need a
  second instance with `--embeddings` and an embedding-capable model) — this
  currently only lights up with `GEMINI_API_KEY` set.
- **Structured knowledge graph**: the reliable complement to similarity-based semantic
  memory — pgvector answers "what sounds like this," which is inherently
  probabilistic; this answers "what do we actually know about X." A real Gemini
  call (`src/cognition/knowledge-graph.ts`) extracts concrete entities, facts, and
  relationships after every real chat turn — only when something was genuinely
  stated, never invented — and stores them in Postgres. Queryable via the
  `query_knowledge_graph` chat tool or `GET /api/knowledge/search?q=`.
- **Auth**: a single admin key (`INTERNAL_API_KEY`) plus self-service registration/login
  with bcrypt-hashed passwords, both backed by Postgres.
- **Settings**: local LLM endpoint/model/key, offline mode — persisted to disk.
- **Observation**: real CPU/disk/memory metrics, telemetry log, audit ledger, decision
  traces — all bounded in-memory buffers, viewable in `/admin`.
- **Long-term learning**: coding style preferences, cached workflow steps, and a
  mistake log — persisted to disk (`data/learning.json`), not reset on restart, and
  consulted (style preferences) when generating chat replies. Written automatically
  too: after every real chat turn, a lightweight Gemini reflection call judges
  whether the exchange actually revealed a style preference or a genuine
  mistake+fix, and only then writes it — not a manual `/api/learning/*` call
  required for either.
- **Speech-to-text**: Gemini's multimodal API when configured; otherwise a real
  local `whisper-cpp` service (`docker-compose.yml`) with a genuine bundled
  whisper-base.en model, entirely offline. Falls back to a canned string only if
  neither is reachable.
- **Voice-native mode** (`/voice`): a continuous, real-time spoken conversation via
  Gemini's Live API (`src/cognition/live-voice.ts`) over a WebSocket
  (`/ws/voice`) — raw PCM audio streamed both directions as it's generated,
  not the record → transcribe → reply → synthesize round trip `/api/voice-input`
  uses. Requires `GEMINI_API_KEY`. Live-verified end-to-end with real synthesized
  speech in and real spoken audio back, through the actual server (not just the
  SDK in isolation) — this surfaced and fixed a real race condition where audio
  sent immediately on connect could be silently dropped before the server had
  finished opening its own session with Gemini.
- **Confidence**: computed per-turn from what actually happened (which backend
  answered, whether memory had relevant hits, whether tool calls succeeded) instead
  of fixed inputs.
- **Memory review queue**: a pending-records approval flow, backed by Postgres.
- **Self-analysis** (`/api/evolution/*`): real computed signals, not decoration —
  architecture score from an actual parsed import graph and cycle detection,
  quality from real `tsc`/TODO-marker output, performance from real observed
  latency/error telemetry, security from a real hardcoded-secret and
  dangerous-call pattern scan. Persisted to Postgres so `/trends` reflects real
  history and `/forecast` does a real (naively linear, honestly labeled)
  projection once at least 3 runs exist — otherwise it says so rather than
  inventing a number. Goals (`/api/evolution/goals`) compare a real metric
  against a real target.
- **Integrations**: GitHub (read repo/file, create issues/PRs), email (send via SMTP,
  read via IMAP), text-to-speech, local files/notes (`JARVIS_FILES_DIR`,
  read/write/list/delete scoped to one dedicated folder — see "Files/notes" below),
  and Google Calendar (list/create events, real OAuth2 with automatic token
  refresh — see "Google Calendar setup" below) — each gated behind its own env
  vars and degrading gracefully (clear error, not a crash) when unset or not yet
  authorized.
- **Executive planning / board review**: a request planner and a static proposal
  linter — see "Known limitations," they're both real but more modest than their
  names suggest.

## Known limitations

Some subsystems produce plausible output without the reasoning their names imply.
None of this is a security issue — it's worth knowing before you rely on it:

- **`POST /api/executive/run`** ("Autonomous Executive") decomposes an objective into
  steps (optionally via Gemini) and narrates what each step *would* do. It does not
  write files, compile anything, or run tests. Its response includes
  `"simulated": true` and an honest `buildVerification` field for exactly this reason.
- **`POST /api/executive/board/debate`** ("Executive Board") is a deterministic
  pattern-matching guardrail (checks for code fences, sensitive-key mentions) — a
  real, useful lint step, not multi-agent LLM reasoning. Its response includes
  `"method": "deterministic-pattern-check"`.
- **The offline chat fallback** (`src/cognition/local_engine.ts`) is keyword-matched
  canned phrasing, not a language model. It only fires if `llama-cpp` itself is
  unreachable (or `HOST_MODEL_DIR`/`LOCAL_MODEL_FILE` were never set) and no
  `GEMINI_API_KEY` is configured either — with the bundled `llama-cpp` service, that's
  no longer the out-of-the-box default the way it used to be with a host-run Ollama.
- A couple of files under `src/` (`bridge/synapse.py`, `infrastructure/health.py`)
  are unused fragments from a prior design and are not imported by anything that
  runs. `src/desktop/` is a separate, optional pywebview launcher, not part of the
  Docker/API path.
- **Tool-calling delegation only fires through `/api/chat`** — `/api/executive/run`'s
  free-text objective planner stays plan-only on purpose (see its own doc comment):
  invoking GitHub/email actions needs structured arguments an LLM extracts from real
  conversation, not keyword-matched from a plan string.

## Files/notes

`JARVIS_FILES_DIR` (host path, defaults to `./jarvis-notes`) is bind-mounted
read-write into the `api` container at `/jarvis-files` — the *only* folder
`src/integrations/files.ts` can ever touch. Every path is resolved against that
root and rejected if it would escape it (`list_files`/`read_file`/`write_file`
chat tools, or `GET/POST/DELETE /api/integrations/files*` directly), gated by
`files.read`/`files.write` capability grants like every other tool. The folder
is created automatically if it doesn't exist — nothing to set up beyond
pointing `JARVIS_FILES_DIR` somewhere you're happy for Jarvis to read and write.

## Google Calendar setup

Optional — chat, memory, and every other integration work without this. Calendar
needs a real Google Cloud OAuth client, which only you can create (it requires a
Google account and a one-time consent grant no server-side process can do on your
behalf):

1. In the [Google Cloud Console](https://console.cloud.google.com/), create a
   project (or reuse one) and enable the **Google Calendar API**
   (APIs & Services → Library).
2. Configure the **OAuth consent screen** (APIs & Services → OAuth consent screen).
   For personal use, "External" + "Testing" mode is enough — add your own Google
   account as a test user.
3. Create an **OAuth client ID** (APIs & Services → Credentials → Create Credentials
   → OAuth client ID), type **Web application**. Add an **Authorized redirect URI**
   of `http://localhost:3000/api/integrations/calendar/callback` (must match
   `GOOGLE_REDIRECT_URI` in `.env` exactly).
4. Copy the generated **Client ID** and **Client Secret** into `.env` as
   `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`, restart the stack.
5. With the server running, open
   `http://localhost:3000/api/integrations/calendar/auth-url` while sending your
   `x-api-key` header (e.g. via a browser extension, or just `curl` and paste the
   returned URL into a browser), approve access, and you'll land back on the
   callback route with a "connected" confirmation. This is a one-time step — the
   refresh token it stores in Postgres keeps working across restarts.

Until step 5 is done, every calendar route/tool returns a clear "not configured" or
"not authorized yet" error rather than failing silently or fabricating data.

## Testing

```bash
npm test        # hand-rolled assertion suite, 12 scenarios covering the
                 # cognition/execution/observation core logic
npx tsc --noEmit # type check
```

Both run in CI on every push (`.github/workflows/ci.yml`).

## Project structure

```
src/
  api.py                 FastAPI gateway — proxies to Express, supervises the
                          Node process, falls back to canned JSON if it's down
  server.ts               Express app — all routes, auth, chat logic
  cognition/               Kernel/state machine, workspace, long-term learning
  execution/                Executive planner, board review
  observation/               Telemetry, metrics, audit
  integrations/                GitHub, email, TTS clients
  data/                         Postgres access (users, memory records)
  static/                       Frontend (vanilla HTML/JS, no build step)
docker-compose.yml    api + postgres + tts services
Dockerfile             Node 20 + Python 3 image running the FastAPI gateway
```

## Docs worth reading

- `docs/architecture/ROADMAP.md` — closest thing to an accurate architecture history.
- `docs/architecture/VISION.md` — where this could go next, and in what order.
- `.env.example` — every environment variable, what reads it, and whether it's
  currently used by any code.

Other root-level markdown files (`ARCHITECTURE.md`, `CONSTITUTION.md`,
`CONTEXT.md`, etc.) describe an earlier, larger system design that predates the
current Docker/Express implementation and has been superseded by it.
