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
- **Vision**: the camera starts itself when the dashboard loads (see "Always-on
  voice + vision" below) — no manual toggle needed, though the button still
  works as a mute/off control. Every typed chat turn automatically captures a
  fresh still frame and sends it to Gemini alongside your message — genuine
  multimodal input, not the cosmetic motion-tracking effect that drives the
  eye icon's gaze (that's separate, purely visual, and now also the signal
  behind ambient presence nudges — see below). Only Gemini can actually
  process the image, so a message with a frame attached routes there first
  even in local-first mode, the same way a tool-shaped message does.
  Live-verified: sent a real generated test image (an orange circle over a
  blue bar), got back an accurate description of exactly those shapes/colors
  through the real `/api/chat` pipeline.
- **Capability requests**: Jarvis never writes or executes code itself. When
  you ask for something it has no tool for, it researches feasibility with
  `search_web` and proposes a concrete plan in conversation instead of
  declining or inventing a fake result — only once you explicitly approve
  does it call `queue_feature_request`, handing the request to a real human
  developer via the exact same reviewed build → test → PR → merge process
  used for every feature in this repo. See the "CAPABILITY REQUESTS" panel
  on the dashboard, or `GET /api/feature-requests`.
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
- **Continuity of self** (`src/cognition/identity.ts`): not a claim of actual sentience —
  a real, structured record of things Jarvis itself said. After every real chat turn, a
  Gemini call judges whether Jarvis's own reply genuinely contained an opinion it formed,
  a commitment it made, or a notable realization/observation — empty on most turns, by
  design, and never invented when nothing qualifies (`src/data/identity-repo.ts`,
  `self_reflections` table in Postgres). Recent entries are read back into the system
  prompt for every future turn (`buildIdentityContext`), so Jarvis's sense of continuity
  comes from real past statements instead of a static persona string. A 6-hour scheduled
  job (`startSelfReflectionJob`) synthesizes one genuine proactive thought from at least
  3 stored reflections — a follow-up on a prior commitment, a connection between two
  past opinions — and honestly returns nothing rather than fabricating introspection when
  there isn't enough real history yet. Reachable mid-conversation as the `reflect_on_self`
  chat tool ("what have you been thinking about?", "what do you believe?") and via
  `GET /api/identity/reflections`, `/thought`, `/thoughts/history`. Live-verified through
  the real `/api/chat` pipeline: a genuine opinion turn was auto-extracted and stored, and
  a follow-up turn had Gemini's own function-calling select `reflect_on_self` and weave the
  real stored opinions back into a coherent answer.
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
- **Always-on voice + vision**: the dashboard's default experience, not an
  opt-in mode — mic and camera both start themselves on load and stay live,
  no click-to-talk button. Under the hood this is a continuous, real-time
  spoken conversation via Gemini's Live API (`src/cognition/live-voice.ts`)
  over a WebSocket (`/ws/voice`) — raw PCM audio streamed both directions as
  it's generated, not the record → transcribe → reply → synthesize round trip
  `/api/voice-input` uses. Spoken turns get real transcription
  (`inputAudioTranscription`/`outputAudioTranscription`) rendered into the
  same conversation view text chat uses, and are written through the exact
  same memory/reflection/knowledge-graph/continuity-of-self pipeline as a
  typed turn — voice and text share one identity and one memory, not two
  disconnected personas wearing the same name. Tool-calling (GitHub, email,
  TTS, planning, etc.) works over voice too, dispatched through the same
  `executeTool()` `/api/chat` uses. Requires `GEMINI_API_KEY`; falls back
  automatically to the browser-STT + per-message-snapshot pipeline above if
  it isn't configured or the connection fails, so "ears" stay on either way.
  Live-verified end-to-end with real synthesized speech in and real spoken
  audio back, through the actual server (not just the SDK in isolation) —
  this surfaced and fixed a real race condition where audio sent immediately
  on connect could be silently dropped before the server had finished
  opening its own session with Gemini.
- **Wake-word gating**: without this, "always on" would mean every word
  spoken anywhere near the mic gets sent to Gemini and treated as addressed
  to Jarvis. A separate, continuous local speech-recognition instance
  watches only for the trigger phrase ("jarvis") — mic audio keeps recording
  regardless, but only forwards into the live session once armed, and stays
  armed for a 12-second grace window (extended by each new exchange) so a
  real back-and-forth doesn't need the wake word repeated every sentence.
  If browser speech recognition isn't available or silently fails to
  produce events (a real, documented issue on some Linux/Electron Chromium
  builds — the reason the STT fallback pipeline above exists at all), this
  fails open — arms permanently rather than leaving live voice unreachable
  with no way to ever trigger it — and tells you plainly that wake-word
  detection isn't available here.
- **Ambient awareness**: the same motion-tracking canvas that drives the
  cosmetic eye-follow effect also feeds a simple presence heuristic — sustained
  motion after a stretch of stillness (a proxy for "someone's attention just
  returned") sends a silent synthetic prompt into the live voice session, so
  Jarvis can naturally acknowledge it if it's genuinely worth mentioning,
  throttled to at most once every 2 minutes. Deliberately narrow: a 32x32
  pixel diff can't reliably tell "left the room" from "sitting still," so this
  only claims the more honest half.
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
  Google Calendar (list/create events, real OAuth2 with automatic token
  refresh — see "Google Calendar setup" below), news (`NEWS_API_KEY` — real
  headlines and topic search via newsapi.org, `get_news` chat tool or
  `GET /api/integrations/news/headlines`/`/search`), and live web search
  (`BRAVE_API_KEY` — real current results via Brave's Search API, `search_web`
  chat tool or `GET /api/integrations/websearch`) — each gated behind its own
  env vars and degrading gracefully (clear error, not a crash) when unset or
  not yet authorized.
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
  runs. `src/desktop/app.py` is an older, separate pywebview launcher attempt that
  tries to spawn its own copy of the server directly on the host rather than
  pointing at the Docker stack — superseded by `desktop-electron/` (see "Desktop
  app" below), which does the latter and is the maintained path going forward.
- **Tool-calling delegation only fires through `/api/chat`** — `/api/executive/run`'s
  free-text objective planner stays plan-only on purpose (see its own doc comment):
  invoking GitHub/email actions needs structured arguments an LLM extracts from real
  conversation, not keyword-matched from a plan string.

## Security ops (human-gated)

Jarvis observes and proposes; it never applies anything to your network or
host itself. Two host-side scripts (`scripts/security/`) do the actual
scanning — deliberately **outside** Docker, so the chat-facing `api`
container (the part most exposed to prompt injection or bad model output)
never gains new network privileges to do this:

- **`network_scan.sh`** — `arp-scan`s your real LAN (needs root/`CAP_NET_RAW`),
  posts the device list to `POST /api/security/ingest/devices`. A MAC seen
  for the first time gets both a device row and a real "new device" finding;
  an already-known device just gets its `last_seen` refreshed.
- **`host_scan.sh`** — real checks against the actual host: pending `apt`
  security updates, SSH root-login config, listening ports reachable beyond
  localhost. Posts to `POST /api/security/ingest/findings`. Any finding can
  carry a proposed remediation — the exact command is stored and shown to
  you verbatim, but **nothing in this codebase ever executes it**. Approving
  a proposal only flips its status; running the command, if you want it, is
  a manual step you take yourself.

Both scripts read `INTERNAL_API_KEY` straight from `.env` (same key as
everything else — no separate secret to manage) and need `arp-scan`/`nmap`
installed (`apt install arp-scan nmap`). Run periodically via cron, e.g.:

```
*/15 * * * * /path/to/scripts/security/network_scan.sh >> /var/log/jarvis-network-scan.log 2>&1
0 6 * * *    /path/to/scripts/security/host_scan.sh    >> /var/log/jarvis-host-scan.log 2>&1
```

The "SECURITY OPS" dashboard panel shows the live device inventory (with a
one-click acknowledge for anything new), open findings by severity, and
pending proposals with their exact command and an approve/reject choice —
also reachable via the `get_security_status` chat tool or
`GET /api/security/devices`/`/findings`/`/proposals` directly.

### Command execution — the single most consequential capability here

Built only after an explicit conversation about what "you have final say"
means mechanically. Jarvis can propose an exact shell command via the
`propose_command` chat tool — this only ever writes a `pending` row to
`command_proposals`; it never runs anything. A command only ever executes
after **your own fresh approval** in the dashboard, one command at a time,
with no standing/blanket trust — approving one command does not authorize
any future one. Changed your mind after approving? A command still sitting
in `approved` (not yet claimed by the executor) can be cancelled from the
dashboard — this is the only way an `approved` row ever moves to `rejected`,
and it atomically loses the race to a claim already in flight, so it can
never cancel something that's actually started running.

Execution itself is deliberately a separate, host-side step
(`scripts/security/command_executor.sh`), for the same reason as the
network/host scanners: the chat-facing `api` container — the part most
exposed to prompt injection or bad model output — never gains the ability
to actually run commands, only to write a proposal. The executor:

- Atomically **claims** one `approved` command at a time
  (`POST /api/system/commands/claim`, `approved -> running` in one
  `UPDATE ... RETURNING`) so an overlapping run can never execute the same
  command twice, plus a `flock` guard against concurrent script instances.
- Runs a defense-in-depth **safety denylist** first (catastrophic patterns
  like `rm -rf /`, `mkfs.*`, writing directly to a raw disk device) — this
  is not a substitute for reading the command before approving it, just a
  last-resort backstop.
- Executes with a timeout (`COMMAND_TIMEOUT`, default 60s), captures the
  real combined stdout/stderr and exit code, and reports back via
  `POST /api/system/ingest/command-result` — visible in the dashboard
  alongside the original proposal.

Run periodically via cron, e.g. every minute:

```
* * * * * /path/to/scripts/security/command_executor.sh >> /var/log/jarvis-command-executor.log 2>&1
```

`arp-scan` and the executor's own command execution both need real host
privileges (raw sockets, and whatever the approved command itself needs) —
neither is granted automatically by this repo; see the scripts' own
comments for what to set up and why.

## Local-only network integrations

Anything that gives a container real presence on your home network (device
discovery, physical security hubs, camera integrations) belongs in
`docker-compose.override.yml`, not `docker-compose.yml` — it's gitignored
and `docker compose` merges it in automatically, with no extra flag needed.
This keeps home-network-specific setup (topology, device names, what's
connected) off GitHub entirely while still working locally with a plain
`docker compose up -d`.

## Remote access (phone/off-LAN)

A `tailscale` sidecar service in `docker-compose.override.yml` joins Jarvis
onto a private [Tailscale](https://tailscale.com) network using Tailscale's
own hosted coordination service (not a self-hosted alternative — that would
need a router port-forward to be reachable while off-LAN, which this avoids
entirely). It exposes *only* the dashboard, not the rest of the home network:

```
tailscale serve --bg --https=443 http://api:3000
```

To reach Jarvis from your phone or laptop when away from home:

1. Install the real Tailscale app (App Store / Play Store / tailscale.com/download).
2. Log into the **same Tailscale account** used to approve the sidecar container
   (check `docker exec jarvis-tailscale tailscale status` for the account/device list).
3. Open the container's tailnet URL shown by
   `docker exec jarvis-tailscale tailscale serve status` — something like
   `https://jarvis-1.tail<xxxxx>.ts.net` — in a mobile browser, or "Add to
   Home Screen" it as the PWA for a native-feeling app icon.

Nothing here is reachable by anyone not logged into that Tailscale account —
it isn't exposed to the public internet, and the sidecar has no route to any
other device on the home LAN.

**Note:** `docker compose` derives its project name from the current
directory unless `COMPOSE_PROJECT_NAME` is set in `.env` — set it explicitly
(e.g. `COMPOSE_PROJECT_NAME=jarvis-os`) so a checkout in a differently-named
folder doesn't silently spin up a second, disconnected set of
networks/volumes alongside the real stack.

## Files/notes

`JARVIS_FILES_DIR` (host path, defaults to `./jarvis-notes`) is bind-mounted
read-write into the `api` container at `/jarvis-files` — the *only* folder
`src/integrations/files.ts` can ever touch. Every path is resolved against that
root and rejected if it would escape it (`list_files`/`read_file`/`write_file`
chat tools, or `GET/POST/DELETE /api/integrations/files*` directly), gated by
`files.read`/`files.write` capability grants like every other tool. The folder
is created automatically if it doesn't exist — nothing to set up beyond
pointing `JARVIS_FILES_DIR` somewhere you're happy for Jarvis to read and write.

## Desktop app

`desktop-electron/` wraps the dashboard in a real native window instead of a
browser tab — mainly useful for microphone access, since a dedicated window
has no browser-profile history of a previously-blocked mic permission to get
stuck on. It does not run its own copy of the server: the Docker stack
(`docker compose up -d`) must already be running at `localhost:3000` — the app
polls for it on launch, shows a connecting screen while it waits, and a clear
"isn't reachable" screen with the exact command to run if it times out.

```bash
cd desktop-electron
npm install
npm start              # run directly
npm run build           # produce an installable .deb / .AppImage (Linux)
```

Microphone/camera permission requests are auto-granted only for the app's own
`localhost:3000` origin (`session.setPermissionRequestHandler` in `main.js`) —
this window never navigates anywhere else, so there's no broader exposure from
that.

**OS integration** — on first launch, the app writes two per-user XDG
`.desktop` files (`~/.local/share/applications` for the app menu/taskbar,
`~/.config/autostart` for login autostart) if they don't already exist —
never overwritten on later launches, so any hand-edits survive. No sudo or
system package install involved. Beyond that:

- Closing the window hides it to the system tray instead of quitting; only
  the tray's "Quit" item actually exits.
- `Ctrl+Alt+J` is a global hotkey (works even when the window isn't focused)
  that shows/focuses it.
- Native OS notifications fire for the same events the in-app toasts already
  cover (briefing updates, command proposals, security findings, feature
  requests) — but only when the window isn't focused, since the toast is
  already visible otherwise. `preload.js` exposes exactly one bridge call
  for this (`window.jarvisDesktop.notify`), nothing else is reachable from
  the page.

**Starting the whole stack at boot, independent of login** —
`deploy/jarvis-os.service` is a `systemd` unit that brings up the Docker
stack the moment the machine reaches `multi-user.target`, before any
graphical session or login. Install it once:

```bash
sudo cp deploy/jarvis-os.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now jarvis-os.service
```

Adjust `WorkingDirectory`/`COMPOSE_PROJECT_NAME` in the unit first if your
checkout lives somewhere else, or if your containers were created under a
different project name than `jarvis-os` — otherwise `docker compose up -d`
will try to recreate everything under a new project and fail with a
container-name conflict (hit and fixed once already; see the comment in the
unit file for the exact check to run first).

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
