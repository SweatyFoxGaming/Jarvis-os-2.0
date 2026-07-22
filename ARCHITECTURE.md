# Architecture

Jarvis OS is organized into 9 subsystems, each a top-level folder under `src/`:

| Subsystem | Folder | Owns |
|---|---|---|
| Self | `src/self/` | Identity, self-reflection, mind/attention/confidence state |
| World | `src/world/` | Signal collection and briefing synthesis (email, GitHub, objectives) |
| Executive | `src/executive/` | Autonomous objective execution, department dispatch, the executive board |
| Cognition | `src/cognition/` | Working memory (workspace, session) and long-term knowledge (memory store, knowledge graph) |
| Adaptation | `src/adaptation/` | Self-analysis, style/mistake reflection, long-term learning |
| Kernel | `src/kernel/` | Postgres state store (`src/kernel/state/`), capability-grant security, the job scheduler, observability/telemetry |
| Runtime | `src/runtime/` | LLM provider clients (Groq, the local-engine fallback) |
| Capabilities | `src/capabilities/` | Tool dispatch, MCP registry, external-world providers (GitHub, email, calendar, web search, files, news) under `src/capabilities/providers/` |
| Interaction | `src/interaction/` | Voice (live-voice, whisper, TTS), push notifications, the web frontend (`src/interaction/static/`), the optional desktop client |

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

## Not done here (tracked as follow-ups, not oversights)

- Splitting `src/server.ts`'s 70+ Express routes into per-subsystem router files.
- Any literal kernel-as-infrastructure rewrite (sandboxed process isolation, event-sourced state,
  zero-copy IPC, swappable runtime drivers). Postgres, Docker, and Express remain exactly as they
  are; this reorg changed file locations only, never the underlying infrastructure.

See `docs/superpowers/specs/2026-07-22-repo-cleanup-and-subsystem-reorg-design.md` and
`docs/superpowers/specs/2026-07-21-groq-provider-design.md` for the two most recent real
architecture decisions and their full rationale.
