# Repository Cleanup and 9-Subsystem Reorganization — Design Spec

## Context

Two independent reviews of this repository (one pasted from an external tool, one I corroborated
directly against the actual code) converged on the same core finding: the ~4,500 lines of real
code are surrounded by ~4,000+ lines of governance/constitution/model documentation
(`CONSTITUTION.md`, `DEVELOPMENT_CONSTITUTION.md`, `COGNITIVE_MODEL.md`, `EXECUTION_MODEL.md`, and
`governance/`'s five more `*_MODEL.md` files), plus assorted repo-hygiene cruft (dead lockfiles,
stray media files, an empty dummy plugin, an unreferenced `docs/archive/`).

The user then proposed a much heavier addition on top of this: a "Frozen" 9-subsystem architecture
(Purpose, Self, World, Executive, Cognition, Adaptation, Kernel, Runtime, Capabilities,
Interaction) with a literal Kernel specification calling for C-bindings, zero-copy IPC,
ACID-compliant event-sourcing, and per-capability hardware/container sandbox isolation, all marked
"FROZEN / IMMUTABLE INFRASTRUCTURE."

I flagged directly that the literal spec is infrastructure-project scale (months of work, almost
certainly a different tech stack than Node/Express + Python) and would itself be a heavier instance
of the exact "governance before a battle-tested engine" problem both reviews just diagnosed. The
user agreed and chose the lightweight option: adopt the 9 subsystem names as an **organizational
convention** — regroup the existing, working code into folders named after the 9 subsystems, with
no new infrastructure, no rewritten persistence layer, no sandboxing rewrite. Postgres, Docker, and
Express stay exactly as they are; only file locations (and the folder names two of them are already
squatting on) change.

This spec covers both pieces together, since the cleanup naturally precedes and overlaps with the
reorg (e.g., two of the empty leftover directories the reorg wants to use, `src/capabilities/` and
`src/interaction/`, are currently occupied only by dead `__pycache__` files from a defunct Python
provider framework and need clearing first).

## Scope

**In scope:**
1. Documentation consolidation and repo-hygiene cleanup (see "Cleanup" below).
2. Moving existing source files into 9 new top-level directories under `src/`, matching the
   subsystem names, with corresponding import-path updates. No logic changes, no renamed
   classes/functions, no behavior changes — this is a structural move verified by the existing
   89-test suite and `tsc --noEmit` staying green throughout.

**Explicitly out of scope** (both are legitimate, valuable follow-ups, not bundled here):
- Splitting `server.ts`'s 70+ Express routes into per-subsystem router files. `server.ts` and
  `api.py` stay exactly where they are, as the composition root that wires the subsystems
  together — moving *what they depend on* is this spec's job; restructuring *their own 2,469
  lines* is a separate, deeper refactor.
- Any of the literal Kernel spec's infrastructure asks (C-bindings, zero-copy IPC, ACID
  event-sourcing, hardware sandboxing, swappable runtime drivers). Postgres remains the state
  store; Docker remains the process boundary; nothing here builds a new kernel primitive.
- Inventing a "Purpose" module. Nothing in this codebase today implements Purpose (values,
  intent, interruption policy) as a distinct piece of logic — it's implicit in system-prompt text
  and scattered policy checks (`ALLOW_REGISTRATION`, `kernel.offlineMode`/`llmMode`, capability
  grants). Manufacturing a hollow module to fill the ninth folder would be exactly the kind of
  speculative-architecture-before-real-need this whole effort is trying to undo, so `src/purpose/`
  is not created — the consolidated `ARCHITECTURE.md` documents this choice explicitly instead.

## Cleanup

- Consolidate `CONSTITUTION.md`, `DEVELOPMENT_CONSTITUTION.md`, `COGNITIVE_MODEL.md`,
  `EXECUTION_MODEL.md`, and `governance/`'s five files (`ECOSYSTEM_MODEL.md`,
  `ENVIRONMENT_MODEL.md`, `EVOLUTION_MODEL.md`, `INTERACTION_MODEL.md`, `OBSERVATION_MODEL.md`,
  `core_abstractions.md`) into one `ARCHITECTURE.md` under 200 lines, covering: the 9-subsystem
  map (this spec's mapping table), the explicit "Purpose has no dedicated module" note, and a
  short pointer to this spec + the Groq provider spec as the two most recent real architecture
  decisions. Delete the ten source files once consolidated.
- Delete `docs/archive/` (6 files) — git history preserves it if ever needed; it's not
  referenced from anywhere live.
- Delete `src/bridge/synapse.py` and `src/infrastructure/health.py` — confirmed dead code via
  `grep -rn` across the whole repo: zero import sites, zero instantiation sites, referenced only
  by their own internal string literals. `synapse.py`'s class docstring ("the exclusive,
  deterministic gateway to Phoenix OS internals") is itself an instance of the inflated-language
  pattern `scripts/check_jargon.py` exists to catch.
- Delete the untracked `__pycache__` directories inside `src/capabilities/`, `src/environment/`,
  `src/voice/`, `src/interaction/`, `src/ecosystem/` — confirmed via `git ls-files` that none of
  this content is tracked; it's leftover compiled bytecode from a Python provider framework whose
  source no longer exists in the repo. Two of these directory names (`capabilities/`,
  `interaction/`) are reused by this reorg once cleared.
- Delete `bun.lock` — confirmed dead: last touched a week before this session's work, and nothing
  in `package.json`'s scripts or the `Dockerfile` invokes `bun` anywhere; the app runs entirely on
  `tsx`. Not a second runtime, just a stray lockfile from a one-off `bun install`.
- Delete `plugins/my_new_plugin` (empty scaffold) and `speech.mp3`/`test_audio.mp3` from repo
  root.
- Add `.gitignore` rules for common audio/media extensions at root, so this doesn't recur.

## Subsystem Mapping

Every real (non-dead) source file moves into exactly one of the 9 folders below. `server.ts` and
`api.py` are not moved — they stay as the composition root.

| Subsystem | New location | Files (from) |
|---|---|---|
| **Purpose** | *(no module — documented in ARCHITECTURE.md)* | — |
| **Self** | `src/self/` | `cognition/identity.ts`; the whole `cognition/kernel/` directory (`attention.ts`, `confidence.ts`, `dialogue.ts`, `executive_state.ts`, `kernel.ts`, `settings-store.ts`, `state.ts`, `synchronization.ts`, `thought.ts`) |
| **World** | `src/world/` | `execution/briefing.ts` |
| **Executive** | `src/executive/` (renamed from `execution/`) | `autonomous_executive.ts`, `departments.ts`, `executive_board.ts` |
| **Cognition** | `src/cognition/` (stays, pared down) | `workspace.ts`, `session.ts`, `memory-store.ts`, `knowledge-graph.ts`, `learning-store.ts` |
| **Adaptation** | `src/adaptation/` (renamed from `evolution/`) | `evolution/analyzer.ts`; `cognition/reflection.ts`, `cognition/long_term_learning.ts` |
| **Kernel** | `src/kernel/` | `data/db.ts` + all 16 `data/*-repo.ts` files → `src/kernel/state/`; `execution/permissions.ts` → `src/kernel/security.ts`; `execution/scheduler.ts` → `src/kernel/scheduler.ts`; `observation/index.ts` → `src/kernel/observation.ts` |
| **Runtime** | `src/runtime/` | `cognition/groq-client.ts`, `cognition/local_engine.ts` |
| **Capabilities** | `src/capabilities/` (dead `__pycache__` cleared first) | `execution/tools.ts`, `execution/mcp-registry.ts`; `integrations/calendar.ts`, `email.ts`, `files.ts`, `github.ts`, `news.ts`, `websearch.ts` → `src/capabilities/providers/` |
| **Interaction** | `src/interaction/` (dead `__pycache__` cleared first) | `cognition/live-voice.ts`; `integrations/tts.ts`, `whisper.ts`, `push.ts`; `static/` (whole tree) → `src/interaction/static/`; `desktop/app.py` → `src/interaction/desktop/app.py` |

Rationale for the two splits that aren't obvious at a glance:
- **Persistence vs. logic**: every `*-repo.ts` file (pure SQL/Postgres access) moves to Kernel's
  state store, while the file that owns the *logic* using that data (e.g. `knowledge-graph.ts`'s
  entity-extraction judgment calls) stays in its conceptual subsystem (Cognition). This mirrors
  the frozen spec's own framing — Kernel exposes `readState`/`commitTransaction` as mechanical
  primitives; it doesn't know what the data means.
- **Voice/push vs. other integrations**: `tts.ts`, `whisper.ts`, and `push.ts` are how Jarvis
  *communicates with the user* (a modality), which is what Interaction means in this model;
  `calendar.ts`, `email.ts`, `github.ts`, `websearch.ts`, `news.ts`, `files.ts` are how Jarvis acts
  on or reads from the external world on the user's behalf, which is what Capabilities means.

### Known naming compromise

`cognition/kernel/`'s `MindKernel` class (in-memory chat-turn state: current thought, attention
target, executive status) predates this reorg and is a different concept from the new `src/kernel/`
subsystem (state store, security, scheduling) — an unfortunate but pre-existing name collision.
This spec resolves the *folder* collision (the directory moves to `src/self/`, since the class's
actual content — attention, confidence, dialogue state — is Self, not Kernel, in the new model) but
does **not** rename the `MindKernel` class itself or its internal identifiers. Renaming a class used
throughout the codebase is a real, separate refactor with its own risk profile; relocating its file
is not. The consolidated `ARCHITECTURE.md` calls this compromise out explicitly so it doesn't read
as an oversight later.

## Execution Approach

Structural-only move, verified continuously:
- Each subsystem's files move in its own step; after each step, `npx tsc --noEmit` must be clean
  and all 89 existing tests must still pass before moving to the next subsystem. A broken import
  is a compile error, not a subtle bug, so this is a strong, cheap safety net for a change this
  mechanical.
- No file's internal logic, exported names, or class names change — only its path and the import
  statements of everything that references it.
- `server.ts`'s and `api.py`'s own import statements get updated to the new paths as part of
  whichever subsystem step moves the thing they're importing — they are the last things touched
  in each step, never restructured themselves.
- Given ~30+ files import `observation/index.ts` alone, this touches import paths across most of
  the ~69-file codebase. That is the real, acknowledged cost of "regroup the code into named
  folders" — not hidden, just mechanical and low-risk given the test/typecheck safety net.

## Testing

No new tests are needed — this is a pure structural move with no behavior change. The existing
89-test suite plus `tsc --noEmit` are the acceptance criteria: if both are green after all steps,
the reorg preserved behavior exactly.

## Decisions made during brainstorming

- **Lightweight reorg over literal infra rewrite**: chosen explicitly by the user after I named
  the contradiction between the literal Kernel spec's scale (systems-programming primitives, a
  different tech stack, months of work) and the "governance before a battle-tested engine"
  critique both reviews had just made about this same repository.
- **No `src/purpose/` module**: rather than build a hollow placeholder to satisfy "9 folders,"
  Purpose is documented as currently-implicit in `ARCHITECTURE.md`. A real Purpose module is a
  future step once there's an actual policy engine to put in it, not before.
- **`server.ts`/`api.py` route-splitting deferred**: both this spec and the earlier review agree
  it's worth doing, but it's materially riskier (rewriting request-handling code, not moving
  files) and independent of the subsystem-folder question, so it's tracked as a follow-up, not
  bundled here.
- **`MindKernel` class not renamed**: the folder housing it moves to `src/self/` to resolve the
  naming collision with the new Kernel subsystem at the directory level; the class name itself is
  left alone as a deliberate, documented scope boundary, not an oversight.
