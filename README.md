# Jarvis OS

A self-hosted AI assistant console: a FastAPI gateway in front of an Express/TypeScript
application, running in Docker alongside Postgres and a text-to-speech service. Chat
runs against a local LLM (Ollama) by default, with an optional cloud fallback.

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
                              ┌─────────────────────────┼─────────────────────────┐
                              ▼                         ▼                         ▼
                     ┌────────────────┐        ┌────────────────┐      ┌──────────────────┐
                     │ Postgres        │        │ tts container   │      │ Ollama (host)     │
                     │ users, API keys,│        │ (openai-edge-   │      │ via host.docker.  │
                     │ memory records  │        │  tts)           │      │ internal:11434    │
                     └────────────────┘        └────────────────┘      └──────────────────┘
```

Only `src/api.py` and `src/server.ts` are in the request path. Several other directories
under `src/` (`bridge/`, `execution/planner.py`, `infrastructure/`) are leftover,
unimported fragments from an earlier design — see "Known limitations" below before
relying on anything not listed in "What's implemented."

## Quickstart

1. **Copy the env template and fill in secrets:**
   ```bash
   cp .env.example .env
   ```
   At minimum, set `INTERNAL_API_KEY` (generate one with `openssl rand -hex 32`) —
   the server refuses to start without it. Everything else in `.env.example` is
   optional and documented inline (GitHub/email/TTS integrations, Postgres, an
   optional cloud LLM fallback).

2. **Run it:**
   ```bash
   docker compose up -d --build
   ```
   This starts three containers: `api` (the app, ports 8000 and 3000), `postgres`
   (pgvector image, used for users/memory persistence), and `tts` (text-to-speech,
   port 5051). `./start.sh` does the same thing and opens a browser tab.

3. **Open the console:** `http://localhost:8000` (main console), `/admin`
   (operator panel), `/mind` (cognitive state graph).

4. **Local LLM chat:** the container is networked to reach a host-run Ollama at
   `host.docker.internal:11434` — but Ollama also needs to be listening on more
   than just loopback for that connection to succeed. If Ollama was installed
   with defaults, it binds to `127.0.0.1` only, which no container (Docker's
   `host.docker.internal` mapping included) can reach — you'll see chat fall
   through to the simulated response and `[WARN] [Memory] Local embedding
   request errored: fetch failed` in the logs. Fix: set `OLLAMA_HOST=0.0.0.0`
   for the Ollama service and restart it (e.g. `sudo systemctl edit ollama`,
   add `Environment="OLLAMA_HOST=0.0.0.0"`, `sudo systemctl restart ollama`)
   — this exposes Ollama beyond localhost, so only do it on a machine where
   that's acceptable. Change the endpoint/model in the Settings tab if yours
   runs elsewhere; it's saved to `data/settings.json` and survives restarts.

## What's implemented

- **Chat**, with a three-tier fallback chain: your local LLM → `GEMINI_API_KEY` (if
  set) → a canned offline reply generator (keyword-matched templates, not a model —
  see "Known limitations"). Each turn retrieves relevant semantic memory and applies
  your learned style preferences before generating a reply.
- **Sessions**: conversational state (current thought, attention, dialogue) is scoped
  per authenticated user — two people talking to Jarvis at once no longer interleave
  into the same state (`src/cognition/session.ts`).
- **Real delegation**: when Gemini is configured, chat supports function-calling
  against real capabilities (GitHub, email, TTS) — the model extracts structured
  arguments from the conversation and the server executes them for real, gated by a
  default-deny permission grant system (`GET/POST /api/permissions*`). Local-model
  tool-calling is attempted opportunistically and falls back cleanly when the model
  doesn't support it (most don't yet).
- **Semantic memory**: every real (non-simulated) chat turn is embedded and stored in
  Postgres/pgvector, then retrieved by similarity on future turns — requires an
  embedding provider to actually be reachable (Gemini, or a local Ollama instance
  with an embedding model *and* `--embeddings` support); degrades to no-op, not a
  crash, when neither is available.
- **Auth**: a single admin key (`INTERNAL_API_KEY`) plus self-service registration/login
  with bcrypt-hashed passwords, both backed by Postgres.
- **Settings**: local LLM endpoint/model/key, offline mode — persisted to disk.
- **Observation**: real CPU/disk/memory metrics, telemetry log, audit ledger, decision
  traces — all bounded in-memory buffers, viewable in `/admin`.
- **Long-term learning**: coding style preferences, cached workflow steps, and a
  mistake log — persisted to disk (`data/learning.json`), not reset on restart, and
  consulted (style preferences) when generating chat replies.
- **Confidence**: computed per-turn from what actually happened (which backend
  answered, whether memory had relevant hits, whether tool calls succeeded) instead
  of fixed inputs.
- **Memory review queue**: a pending-records approval flow, backed by Postgres.
- **Integrations**: GitHub (read repo/file, create issues/PRs), email (send via SMTP,
  read via IMAP), and text-to-speech — each gated behind its own env vars and
  degrading gracefully (clear error, not a crash) when unset.
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
  canned phrasing, not a language model. It's the default reply path whenever no
  local LLM and no `GEMINI_API_KEY` are reachable — i.e. out of the box, until you
  point it at Ollama or set a cloud key.
- A couple of files under `src/` (`bridge/synapse.py`, `infrastructure/health.py`)
  are unused fragments from a prior design and are not imported by anything that
  runs. `src/desktop/` is a separate, optional pywebview launcher, not part of the
  Docker/API path.
- **Capability grants are in-memory, not persisted** — they reset on restart (the
  admin default re-seeds itself; anyone else granted a capability needs it granted
  again). Durable storage is a natural next step once there's a UI to manage grants.
- **Tool-calling delegation only fires through `/api/chat`** — `/api/executive/run`'s
  free-text objective planner stays plan-only on purpose (see its own doc comment):
  invoking GitHub/email actions needs structured arguments an LLM extracts from real
  conversation, not keyword-matched from a plan string.

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
