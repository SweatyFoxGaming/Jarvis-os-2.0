# Architecture

Jarvis OS is organized into 9 subsystems, each a top-level folder under `src/`:

| Subsystem | Folder | Owns |
|---|---|---|
| Self | `src/self/` | Identity, self-reflection, mind/attention/confidence state |
| World | `src/world/` | Signal collection and briefing synthesis (email, GitHub, objectives) |
| Executive | `src/executive/` | Autonomous objective execution, department dispatch, the coding agent |
| Cognition | `src/cognition/` | Working memory (workspace, session) and long-term knowledge (memory store, knowledge graph) |
| Adaptation | `src/adaptation/` | Self-analysis, style/mistake reflection, long-term learning |
| Kernel | `src/kernel/` | Postgres state store (`src/kernel/state/`), capability-grant security, the job scheduler, observability/telemetry |
| Runtime | `src/runtime/` | LLM provider clients (Groq, the local-engine fallback) |
| Capabilities | `src/capabilities/` | Tool dispatch, MCP registry, external-world providers (GitHub, email, calendar, web search, files, news) under `src/capabilities/providers/` |
| Interaction | `src/interaction/` | Voice (live-voice, whisper, TTS), push notifications, the web frontend (`src/interaction/static/`), the optional desktop client, and most of the Express route handlers (`src/interaction/routes/`) |

**Purpose has no dedicated module.** Values, intent, and interruption policy are implicit today —
scattered across system-prompt text and individual policy checks (`ALLOW_REGISTRATION`,
`kernel.offlineMode`/`llmMode`, capability grants) rather than a distinct piece of logic. A real
Purpose module is a future step once there's an actual policy engine to put in it, not a
placeholder built to fill a ninth folder.

`src/server.ts` (the Express app) and `src/api.py` (the FastAPI process supervisor/proxy) are the
composition root — they wire the 9 subsystems together and are not owned by any single one of
them.

**Known naming compromise:** `src/self/kernel.ts`'s `MindKernel` class (in-memory per-turn state:
current thought, attention target, executive status) predates this structure and is a different
concept from the `Kernel` subsystem above (state store, security, scheduling) — an unfortunate but
pre-existing name collision. The file/class itself was not renamed as part of this reorg (only its
folder moved) since renaming a class used throughout the codebase is a separate, higher-risk change
from relocating a file.

## Route organization

`src/server.ts`'s 113 Express routes were later split into 14 per-subsystem router files under
`src/interaction/routes/` (98 routes), leaving 15 in `server.ts` itself — the chat SSE endpoint,
voice input/WebSocket bridge, the executive run/board-debate hooks (the latter since removed, see
below), and process startup/static serving, none of which factor into a router as cleanly as a
self-contained CRUD-style resource does. `server.ts` dropped from 2,885 to 1,224 lines. Two small
shared modules
(`src/kernel/auth-middleware.ts`, `src/runtime/clients.ts`) exist specifically so every router can
reach `validateApiKey` and the already-constructed Gemini/Groq clients without a circular
import back into `server.ts`.

The `board-debate` hook mentioned above (`src/executive/executive_board.ts`, "Phase XVI:
Multi-Agent Executive Board") was later removed entirely: it was a deterministic keyword/pattern
check, not real multi-agent reasoning (the README already said as much), it had zero callers
anywhere in the actual autonomous coding/build-request pipeline, and its own docstring — "check...
safety constraints... before final outputs are committed" — oversold it as a safety gate its
`finalConsensus` type could structurally never enforce (`"REJECTED"` was declared but never
reachable). The real code-review gate for the autonomous coding pipeline is
`departments.reviewCodeDiff`/`reviewTaskDiff`, not this. Route count as of that removal: 112
(server.ts down to 14).

## Not done here (tracked as follow-ups, not oversights)

- Any literal kernel-as-infrastructure rewrite (sandboxed process isolation, event-sourced state,
  zero-copy IPC, swappable runtime drivers). Postgres, Docker, and Express remain exactly as they
  are; this reorg changed file locations only, never the underlying infrastructure.

- An egress-allowlisting proxy for the coding agent's sandbox (`jarvis-builder/workspace.ts`).
  Investigated as part of a security review: the sandbox's lack of an explicit `--network` flag
  turned out to already put it on Docker's plain default `bridge` network, separate from
  `jarvis-os_default`, the compose-generated network `postgres`/`jarvis-builder`/`llama-cpp`/
  `whisper-cpp` actually run on (none of which publish a port to the host) — live-verified, a
  sandbox container cannot reach `jarvis-postgres` at all. This is Compose-network isolation
  specifically, not deployment-wide unreachability: `api` and `tts` do publish ports to the host,
  so they remain reachable from the sandbox via the host's own gateway IP (also live-verified) —
  though reaching `api` this way still requires an `X-API-Key` the sandbox has no way to obtain,
  since it starts with a clean environment and no credentials by design. Unrestricted internet
  egress remains open, and closing that properly needs a real forward proxy with a curated domain
  allowlist (npm/GitHub/pip, etc.) — new infrastructure, not a flag on the existing `docker run`
  call, and deliberately not attempted here.

See `docs/superpowers/specs/2026-07-22-repo-cleanup-and-subsystem-reorg-design.md` and
`docs/superpowers/specs/2026-07-21-groq-provider-design.md` for the two most recent real
architecture decisions and their full rationale.
