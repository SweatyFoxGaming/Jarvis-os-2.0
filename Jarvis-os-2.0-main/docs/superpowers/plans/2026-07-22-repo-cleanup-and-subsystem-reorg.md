# Repository Cleanup and 9-Subsystem Reorganization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move every real source file into one of 9 subsystem-named folders under `src/` (Self, World, Executive, Cognition, Adaptation, Kernel, Runtime, Capabilities, Interaction — Purpose has no dedicated module), and separately clean up dead documentation/code/hygiene cruft — with zero logic changes anywhere.

**Architecture:** A pure structural move. No file's exported names, class names, or internal logic change — only its path and the import statements that reference it. `server.ts` and `api.py` stay exactly where they are as the composition root; only their import lines pointing at moved dependencies get updated.

**Tech Stack:** TypeScript (`NodeNext` module resolution, relative `.js`-suffixed imports — no path aliases exist in `tsconfig.json`), the existing `tests/index.test.ts` harness (89 tests currently), Python (2 files being deleted as dead code, 1 file being relocated).

## Global Constraints

- **No logic changes anywhere in this plan.** Every step is `git mv` plus fixing import paths. If a step's diff shows anything beyond a moved file, a changed import line, or a changed path string literal, that's a mistake — revert it.
- **`server.ts` and `api.py` are never moved.** Only their import statements referencing files this plan relocates get updated.
- **Verification method for every task:** because this is a 100% structural move, correctness is fully and exactly determined by two deterministic checks — `npx tsc --noEmit` (zero errors) and `npm test` (89/89 passing, same count in every task; this plan adds no new tests and removes none). A broken import is a compile error, not a subtle bug, so the fastest and most reliable way to finish each task is: `git mv` the files, then repeatedly run `npx tsc --noEmit`, and for every reported "Cannot find module" (or similar) error, fix that one import statement using the **Subsystem Mapping Table** below to find the file's new location — repeat until clean — then run `npm test` and fix any remaining runtime-only import issue (e.g. a dynamic `import()`, or a string path the compiler doesn't check) the same way, then confirm the final run reports exactly `89 / 89`. This plan deliberately does not hand-diff every one of the ~69 affected files' import lines — for a pure rename this size, iterating against the compiler is more reliable than hand-computed relative-path arithmetic, and every fix is independently checkable in isolation.
- **Relative-import arithmetic worked example** (read this once, it's the same pattern everywhere): a file directly under `src/X/` importing another file directly under `src/Y/...` always uses exactly one `../` (up to `src/`, back down into `Y/...`) — the target's own internal depth under `Y/` doesn't add more `../`, it only changes what comes after. Sibling files that move together (e.g., two files both moving from `src/data/` to `src/kernel/state/`) keep their `./`-relative imports to each other completely unchanged, since they're still siblings after the move.
- **Task order matters for minimizing rework**: Kernel (Task 1) moves first because `db.ts`, the 15 repo files, and `observation/index.ts` are the most broadly-imported files in the codebase (30+ files import `ObservationPlatform` alone) — fixing all of their importers in one pass means every later task only has to think about the files *that* task moves, never re-discovering an already-fixed Kernel-path reference.
- **Task 10 (cleanup) runs last** because its consolidated `ARCHITECTURE.md` documents the *final* file structure — writing it before the moves finish would go stale immediately.

### Subsystem Mapping Table (source of truth for every task's import fixes)

| Subsystem | New location | Old location |
|---|---|---|
| Purpose | *(no module)* | — |
| Self | `src/self/` | `cognition/identity.ts`; all of `cognition/kernel/*` |
| World | `src/world/` | `execution/briefing.ts` |
| Executive | `src/executive/` | `execution/autonomous_executive.ts`, `execution/departments.ts`, `execution/executive_board.ts` |
| Cognition | `src/cognition/` (pared down, stays) | `cognition/workspace.ts`, `cognition/session.ts`, `cognition/memory-store.ts`, `cognition/knowledge-graph.ts`, `cognition/learning-store.ts` |
| Adaptation | `src/adaptation/` | `evolution/analyzer.ts`; `cognition/reflection.ts`, `cognition/long_term_learning.ts` |
| Kernel | `src/kernel/` (state store under `src/kernel/state/`) | `data/db.ts` + all 15 `data/*-repo.ts` → `src/kernel/state/`; `execution/permissions.ts` → `src/kernel/security.ts`; `execution/scheduler.ts` → `src/kernel/scheduler.ts`; `observation/index.ts` → `src/kernel/observation.ts` |
| Runtime | `src/runtime/` | `cognition/groq-client.ts`, `cognition/local_engine.ts` |
| Capabilities | `src/capabilities/` (providers under `src/capabilities/providers/`) | `execution/tools.ts`, `execution/mcp-registry.ts`; `integrations/calendar.ts`, `email.ts`, `files.ts`, `github.ts`, `news.ts`, `websearch.ts` |
| Interaction | `src/interaction/` | `cognition/live-voice.ts`; `integrations/tts.ts`, `whisper.ts`, `push.ts`; `static/` (whole tree) → `src/interaction/static/`; `desktop/app.py` → `src/interaction/desktop/app.py` |

---

### Task 1: Kernel — state store, security, scheduler, observation

**Files:**
- Move: `src/data/db.ts` + all 15 `src/data/*-repo.ts` → `src/kernel/state/`
- Move: `src/execution/permissions.ts` → `src/kernel/security.ts`
- Move: `src/execution/scheduler.ts` → `src/kernel/scheduler.ts`
- Move: `src/observation/index.ts` → `src/kernel/observation.ts`
- Modify: every file across the codebase that imports any of the above (found via the grep in Step 3)

**Interfaces:**
- Consumes: nothing new.
- Produces: `getPool`, `initDatabase`, `isVectorReady` now live at `src/kernel/state/db.js`; every `*-repo.ts` export keeps its exact name, now at `src/kernel/state/<name>-repo.js`; `ALL_CAPABILITIES`, `Capability`, `loadGrantsFromDb`, `hasGrant`, `grantCapability`, `revokeCapability`, `listGrants` (confirmed via `grep -n "^export " src/execution/permissions.ts` — these are the real exports, not the aspirational `verifyPermission` name from the Kernel spec sketch) now at `src/kernel/security.js`; `registerJob`/`pushNotification`/`getNotifications`/`markAllRead`/the job-start functions now at `src/kernel/scheduler.js`; `ObservationPlatform` now at `src/kernel/observation.js`. No export is renamed.

- [ ] **Step 1: Move the files**

```bash
mkdir -p src/kernel/state
git mv src/data/db.ts src/kernel/state/db.ts
git mv src/data/briefing-repo.ts src/kernel/state/briefing-repo.ts
git mv src/data/build-requests-repo.ts src/kernel/state/build-requests-repo.ts
git mv src/data/command-proposals-repo.ts src/kernel/state/command-proposals-repo.ts
git mv src/data/evolution-repo.ts src/kernel/state/evolution-repo.ts
git mv src/data/feature-requests-repo.ts src/kernel/state/feature-requests-repo.ts
git mv src/data/identity-repo.ts src/kernel/state/identity-repo.ts
git mv src/data/knowledge-graph-repo.ts src/kernel/state/knowledge-graph-repo.ts
git mv src/data/mcp-servers-repo.ts src/kernel/state/mcp-servers-repo.ts
git mv src/data/memory-repo.ts src/kernel/state/memory-repo.ts
git mv src/data/oauth-repo.ts src/kernel/state/oauth-repo.ts
git mv src/data/objectives-repo.ts src/kernel/state/objectives-repo.ts
git mv src/data/push-subscriptions-repo.ts src/kernel/state/push-subscriptions-repo.ts
git mv src/data/security-repo.ts src/kernel/state/security-repo.ts
git mv src/data/session-repo.ts src/kernel/state/session-repo.ts
git mv src/data/users-repo.ts src/kernel/state/users-repo.ts
git mv src/execution/permissions.ts src/kernel/security.ts
git mv src/execution/scheduler.ts src/kernel/scheduler.ts
git mv src/observation/index.ts src/kernel/observation.ts
rmdir src/data src/observation
```

`src/execution/` and `src/cognition/` are NOT removed — both still have other files pending later tasks.

- [ ] **Step 2: Fix the moved files' own internal imports**

Every moved file that imported `../observation/index.js` (a relative path that changed because `observation/index.ts` itself moved) now needs `../observation.js` instead — worked example: `src/kernel/state/db.ts` had `import { ObservationPlatform } from "../observation/index.js";`; since `observation/index.ts` is now `src/kernel/observation.ts` (a sibling of `state/`, one level up from `state/`), this becomes `import { ObservationPlatform } from "../observation.js";`. Apply the same fix to every other moved file that imports `ObservationPlatform` this way (run `grep -l "ObservationPlatform" src/kernel/state/*.ts src/kernel/security.ts src/kernel/scheduler.ts` to find them all).

`src/kernel/security.ts` (formerly `permissions.ts`) and `src/kernel/scheduler.ts`: check each for any `../data/...` or `../observation/...` import and fix the same way (one level up from `src/kernel/` reaches `src/`, so a repo import becomes `./state/<name>-repo.js`, and the observation import becomes `./observation.js`).

Sibling imports within the moved group need **no change**: any `*-repo.ts` file that imports `./db.js` stays `./db.js` (both are now siblings in `src/kernel/state/`).

- [ ] **Step 3: Find and fix every external importer**

```bash
grep -rln '\.\./data/\|\.\./\.\./data/\|from "\./data/\|observation/index\.js\|\.\./execution/permissions\.js\|\.\./execution/scheduler\.js' src/ tests/ --include="*.ts"
```

For every file this returns, open it and update the matched import path per the mapping table: any `.../data/db.js` → `.../kernel/state/db.js` (adjust the leading `../` count to however many that specific file already used to reach `src/data/` — the count doesn't change, only the path *after* the last `../` does, per the worked example in Global Constraints); any `.../data/<name>-repo.js` → `.../kernel/state/<name>-repo.js`; any `.../observation/index.js` → `.../kernel/observation.js`; any `.../execution/permissions.js` → `.../kernel/security.js`; any `.../execution/scheduler.js` → `.../kernel/scheduler.js`.

- [ ] **Step 4: Run tsc, iterate until clean**

Run: `npx tsc --noEmit`
Expected: eventually zero errors. Each reported "Cannot find module" names the broken import and the file it's in — fix that one line using the mapping table, re-run, repeat.

- [ ] **Step 5: Run the test suite**

Run: `npm test`
Expected: `89 / 89 Tests Passed`. If any test file itself imports a moved path directly, fix it the same way as Step 3.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: move state/security/scheduler/observation into src/kernel/"
```

---

### Task 2: Self — identity, attention, confidence, dialogue, mind state

**Files:**
- Move: `src/cognition/identity.ts` → `src/self/identity.ts`
- Move: `src/cognition/kernel/attention.ts`, `confidence.ts`, `dialogue.ts`, `executive_state.ts`, `kernel.ts`, `settings-store.ts`, `state.ts`, `synchronization.ts`, `thought.ts` → `src/self/`
- Modify: every importer of the above

**Interfaces:**
- Consumes: `getPool` from `src/kernel/state/db.js`, `ObservationPlatform` from `src/kernel/observation.js` (Task 1's new locations — these files import both).
- Produces: every export keeps its exact name (including the `MindKernel` class, still called `MindKernel`, still in a file called `kernel.ts` — see the spec's "Known naming compromise": the folder moves, the class/file name inside it does not), now at `src/self/*.js`.

- [ ] **Step 1: Move the files**

```bash
mkdir -p src/self
git mv src/cognition/identity.ts src/self/identity.ts
git mv src/cognition/kernel/attention.ts src/self/attention.ts
git mv src/cognition/kernel/confidence.ts src/self/confidence.ts
git mv src/cognition/kernel/dialogue.ts src/self/dialogue.ts
git mv src/cognition/kernel/executive_state.ts src/self/executive_state.ts
git mv src/cognition/kernel/kernel.ts src/self/kernel.ts
git mv src/cognition/kernel/settings-store.ts src/self/settings-store.ts
git mv src/cognition/kernel/state.ts src/self/state.ts
git mv src/cognition/kernel/synchronization.ts src/self/synchronization.ts
git mv src/cognition/kernel/thought.ts src/self/thought.ts
rmdir src/cognition/kernel
```

- [ ] **Step 2: Fix the moved files' own internal imports**

These files previously lived two levels deep (`src/cognition/kernel/*.ts`), so any import reaching outside that pair of directories had two `../`. Now at `src/self/*.ts` (one level deep), the same external target needs one fewer `../`. Worked example: `src/cognition/kernel/kernel.ts` importing `src/data/db.ts` would have used `import { getPool } from "../../data/db.js";` (up twice: kernel/ → cognition/ → src/, then into data/) — now at `src/self/kernel.ts`, the same target (now `src/kernel/state/db.ts`) needs `import { getPool } from "../kernel/state/db.js";` (up once: self/ → src/, then into kernel/state/). Apply this pattern to every moved file: any import that used to go `../../X` now goes `../X` (with `X` itself updated per Task 1's mapping if it also moved), and any sibling import among the 10 moved files (e.g. `kernel.ts` importing `./attention.js`) stays exactly as `./attention.js` — they're still siblings.

`src/cognition/identity.ts` moved from one level deep to one level deep (`cognition/` → `self/`), so its `../` counts to anything outside `cognition/`/`self/` stay the same — only paths whose *target* also moved (e.g. `../data/...` → `../kernel/state/...`) need editing.

- [ ] **Step 3: Find and fix every external importer**

```bash
grep -rln 'cognition/identity\.js\|cognition/kernel/' src/ tests/ --include="*.ts"
```

For every match: `.../cognition/identity.js` → `.../self/identity.js`; `.../cognition/kernel/attention.js` → `.../self/attention.js` (and the same pattern for `confidence`, `dialogue`, `executive_state`, `kernel`, `settings-store`, `state`, `synchronization`, `thought`).

- [ ] **Step 4: Run tsc, iterate until clean**

Run: `npx tsc --noEmit`
Expected: eventually zero errors.

- [ ] **Step 5: Run the test suite**

Run: `npm test`
Expected: `89 / 89 Tests Passed`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: move identity/mind-state modules into src/self/"
```

---

### Task 3: World — briefing

**Files:**
- Move: `src/execution/briefing.ts` → `src/world/briefing.ts`
- Modify: every importer of `briefing.ts`

**Interfaces:**
- Consumes: `ObservationPlatform` (from Task 1's `src/kernel/observation.js`), integrations moved in Task 8 (this file imports `email.ts`/`github.ts`, which don't move until Task 8 — see the note below).
- Produces: `collectSignals`, `prioritizeSignals`, `synthesizeBriefing`, `generateBriefing`, `configureGroq`, `getConfiguredGroq` all keep their names, now at `src/world/briefing.js`.

**Note on Task ordering:** `briefing.ts` imports `../integrations/email.js`, `../integrations/github.js`, and `../data/objectives-repo.js` (now `../kernel/state/objectives-repo.js` after Task 1). Since Task 8 (Capabilities) hasn't run yet, the integrations imports don't change in this task — only their relative-path depth might, if `briefing.ts`'s own depth changed. `src/execution/briefing.ts` and `src/world/briefing.ts` are both exactly one level under `src/`, so imports to still-unmoved siblings (`integrations/*`) keep the same `../` count and path.

- [ ] **Step 1: Move the file**

```bash
mkdir -p src/world
git mv src/execution/briefing.ts src/world/briefing.ts
```

- [ ] **Step 2: Fix the moved file's own internal imports**

Only the `objectives-repo.js` import needs updating (Task 1 moved it): `../data/objectives-repo.js` → `../kernel/state/objectives-repo.js`. The `../integrations/email.js`, `../integrations/github.js`, and `../observation/index.js`-turned-`../kernel/observation.js` imports (already fixed if Task 1 ran first) stay path-depth-equivalent since `world/` and `execution/` are both one level under `src/`.

- [ ] **Step 3: Find and fix every external importer**

```bash
grep -rln 'execution/briefing\.js' src/ tests/ --include="*.ts"
```

For every match: `.../execution/briefing.js` → `.../world/briefing.js`.

- [ ] **Step 4: Run tsc, iterate until clean**

Run: `npx tsc --noEmit`
Expected: eventually zero errors.

- [ ] **Step 5: Run the test suite**

Run: `npm test`
Expected: `89 / 89 Tests Passed`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: move briefing.ts into src/world/"
```

---

### Task 4: Executive — autonomous executive, departments, executive board

**Files:**
- Move: `src/execution/autonomous_executive.ts`, `src/execution/departments.ts`, `src/execution/executive_board.ts` → `src/executive/`
- Modify: every importer of the above

**Interfaces:**
- Consumes: `Groq`/`toGroqSchema` (from `src/runtime/groq-client.js` once Task 7 runs — until then this stays at its Task-1/2-corrected path since Task 7 hasn't moved it yet), `ObservationPlatform` (Task 1), `MindKernel` (Task 2's `src/self/kernel.js`).
- Produces: `AutonomousExecutive`, `decomposeObjective`, `runResearch`, `draftCodeChanges`, `reviewCodeDiff`, `ExecutiveBoard` all keep their names, now at `src/executive/*.js`.

**`src/execution/` is not removed by this task** — `tools.ts` and `mcp-registry.ts` still live there until Task 8.

- [ ] **Step 1: Move the files**

```bash
mkdir -p src/executive
git mv src/execution/autonomous_executive.ts src/executive/autonomous_executive.ts
git mv src/execution/departments.ts src/executive/departments.ts
git mv src/execution/executive_board.ts src/executive/executive_board.ts
```

- [ ] **Step 2: Fix the moved files' own internal imports**

Both old (`src/execution/`) and new (`src/executive/`) locations are exactly one level under `src/`, so every import these files already had keeps the same `../` count — only the path *segment* for anything that already moved in Tasks 1-3 needs updating (e.g. `autonomous_executive.ts`'s import of `MindKernel` — check whether it currently reads `../cognition/kernel/kernel.js`; if so, update to `../self/kernel.js` per Task 2's mapping). `departments.ts`'s import of `ObservationPlatform`: `../observation/index.js` → `../kernel/observation.js` (Task 1).

- [ ] **Step 3: Find and fix every external importer**

```bash
grep -rln 'execution/autonomous_executive\.js\|execution/departments\.js\|execution/executive_board\.js' src/ tests/ --include="*.ts"
```

For every match: `.../execution/autonomous_executive.js` → `.../executive/autonomous_executive.js` (and the same pattern for `departments.js`, `executive_board.js`).

- [ ] **Step 4: Run tsc, iterate until clean**

Run: `npx tsc --noEmit`
Expected: eventually zero errors.

- [ ] **Step 5: Run the test suite**

Run: `npm test`
Expected: `89 / 89 Tests Passed`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: move autonomous_executive/departments/executive_board into src/executive/"
```

---

### Task 5: Cognition — verify the pared-down set

**Files:**
- Verify/fix imports in: `src/cognition/workspace.ts`, `src/cognition/session.ts`, `src/cognition/memory-store.ts`, `src/cognition/knowledge-graph.ts`, `src/cognition/learning-store.ts`

**Interfaces:**
- Consumes: `ObservationPlatform` (Task 1), `getPool`/repo functions (Task 1), possibly `MindKernel`/identity exports (Task 2) if any of these five files reference them.
- Produces: no name changes — this task moves nothing, it only fixes these 5 files' imports of things Tasks 1-4 relocated.

No files move in this task — `workspace.ts`, `session.ts`, `memory-store.ts`, `knowledge-graph.ts`, and `learning-store.ts` all stay in `src/cognition/`, which is why this needs its own verification pass rather than being folded into an earlier task: as siblings, they never needed a *self*-referential fix, but each may import something that moved in Tasks 1-4.

- [ ] **Step 1: Grep each of the 5 files for now-stale import paths**

```bash
grep -n 'from "\.\./' src/cognition/workspace.ts src/cognition/session.ts src/cognition/memory-store.ts src/cognition/knowledge-graph.ts src/cognition/learning-store.ts
```

- [ ] **Step 2: Fix every stale import found**

For each hit whose path points at something Tasks 1-4 moved, update it per the mapping table (e.g. `../data/memory-repo.js` → `../kernel/state/memory-repo.js`, `../observation/index.js` → `../kernel/observation.js`, `../execution/briefing.js` → `../world/briefing.js` if referenced, `../execution/autonomous_executive.js` → `../executive/autonomous_executive.js` if referenced). Leave anything pointing at a file that hasn't moved yet (Tasks 6-9) untouched — those get fixed in their own tasks.

- [ ] **Step 3: Run tsc, iterate until clean**

Run: `npx tsc --noEmit`
Expected: eventually zero errors.

- [ ] **Step 4: Run the test suite**

Run: `npm test`
Expected: `89 / 89 Tests Passed`.

- [ ] **Step 5: Commit** (only if Step 2 changed anything — if the grep in Step 1 found nothing stale, skip the commit, there's nothing to record)

```bash
git add -A
git commit -m "refactor: fix src/cognition/'s remaining imports after Kernel/Self/World/Executive moves"
```

---

### Task 6: Adaptation — analyzer, reflection, long-term learning

**Files:**
- Move: `src/evolution/analyzer.ts` → `src/adaptation/analyzer.ts`
- Move: `src/cognition/reflection.ts`, `src/cognition/long_term_learning.ts` → `src/adaptation/`
- Modify: every importer of the above

**Interfaces:**
- Consumes: `Groq`/`toGroqSchema` (once Task 7 moves `groq-client.ts` — if Task 7 hasn't run yet, `reflection.ts` still imports it from its Task-2-unaffected original path `../cognition/groq-client.js`, which stays valid since `groq-client.ts` hasn't moved), `ObservationPlatform` (Task 1).
- Produces: `analyzeCodebase` (or whatever `analyzer.ts` exports), `reflectAndLearn`, `LongTermLearningEngine` all keep their names, now at `src/adaptation/*.js`.

- [ ] **Step 1: Move the files**

```bash
mkdir -p src/adaptation
git mv src/evolution/analyzer.ts src/adaptation/analyzer.ts
git mv src/cognition/reflection.ts src/adaptation/reflection.ts
git mv src/cognition/long_term_learning.ts src/adaptation/long_term_learning.ts
rmdir src/evolution
```

- [ ] **Step 2: Fix the moved files' own internal imports**

`analyzer.ts` moves from one level deep (`evolution/`) to one level deep (`adaptation/`) — same `../` counts, only segment names for already-moved targets change (e.g. `../observation/index.js` → `../kernel/observation.js`). `reflection.ts` and `long_term_learning.ts` move from `cognition/` (one level) to `adaptation/` (one level) — same rule applies, with one real edit to make here: `reflection.ts` currently imports `groq-client.ts` as a sibling, `import { toGroqSchema } from "./groq-client.js";` (both live in `cognition/` today). Since Task 7 (Runtime) hasn't run yet at this point in the plan, `groq-client.ts` is still in `cognition/` while `reflection.ts` is moving to `adaptation/` — they stop being siblings, so this import must change to `import { toGroqSchema } from "../cognition/groq-client.js";` (up once from `adaptation/` to `src/`, back down into the still-unmoved `cognition/`). Task 7's own external-importer grep will find and correct this exact line to `../runtime/groq-client.js` once it moves `groq-client.ts` later — no action needed here beyond making the import valid for `groq-client.ts`'s location *as of this task*.

- [ ] **Step 3: Find and fix every external importer**

```bash
grep -rln 'evolution/analyzer\.js\|cognition/reflection\.js\|cognition/long_term_learning\.js' src/ tests/ --include="*.ts"
```

For every match: `.../evolution/analyzer.js` → `.../adaptation/analyzer.js`; `.../cognition/reflection.js` → `.../adaptation/reflection.js`; `.../cognition/long_term_learning.js` → `.../adaptation/long_term_learning.js`.

- [ ] **Step 4: Run tsc, iterate until clean**

Run: `npx tsc --noEmit`
Expected: eventually zero errors.

- [ ] **Step 5: Run the test suite**

Run: `npm test`
Expected: `89 / 89 Tests Passed`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: move analyzer/reflection/long_term_learning into src/adaptation/"
```

---

### Task 7: Runtime — groq-client, local_engine

**Files:**
- Move: `src/cognition/groq-client.ts`, `src/cognition/local_engine.ts` → `src/runtime/`
- Modify: every importer of the above

**Interfaces:**
- Consumes: `ObservationPlatform` (Task 1).
- Produces: `toGroqSchema`, `toGroqTools`, `generateWithFallback` (from `groq-client.ts`), `LocalCognitiveEngine` (from `local_engine.ts`) all keep their names, now at `src/runtime/*.js`.

- [ ] **Step 1: Move the files**

```bash
mkdir -p src/runtime
git mv src/cognition/groq-client.ts src/runtime/groq-client.ts
git mv src/cognition/local_engine.ts src/runtime/local_engine.ts
```

- [ ] **Step 2: Fix the moved files' own internal imports**

Both move from one level deep (`cognition/`) to one level deep (`runtime/`) — same `../` counts; only the `ObservationPlatform` import's segment changes (`../observation/index.js` → `../kernel/observation.js`, already the correct form if Task 1 ran first).

- [ ] **Step 3: Find and fix every external importer**

```bash
grep -rln 'cognition/groq-client\.js\|cognition/local_engine\.js' src/ tests/ --include="*.ts"
```

For every match: `.../cognition/groq-client.js` → `.../runtime/groq-client.js`; `.../cognition/local_engine.js` → `.../runtime/local_engine.js`. This includes every file the Groq-provider migration touched (`identity.ts`/now `self/identity.ts`, `knowledge-graph.ts`, `reflection.ts`/now `adaptation/reflection.ts`, `briefing.ts`/now `world/briefing.ts`, `departments.ts`/now `executive/departments.ts`, `live-voice.ts`, `server.ts`) — expect this grep to return a relatively long list; fix each the same way.

- [ ] **Step 4: Run tsc, iterate until clean**

Run: `npx tsc --noEmit`
Expected: eventually zero errors.

- [ ] **Step 5: Run the test suite**

Run: `npm test`
Expected: `89 / 89 Tests Passed`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: move groq-client/local_engine into src/runtime/"
```

---

### Task 8: Capabilities — tools, MCP registry, external providers

**Files:**
- Delete first: `src/capabilities/`'s existing contents (dead `__pycache__` only — confirmed untracked via `git ls-files`)
- Move: `src/execution/tools.ts`, `src/execution/mcp-registry.ts` → `src/capabilities/`
- Move: `src/integrations/calendar.ts`, `email.ts`, `files.ts`, `github.ts`, `news.ts`, `websearch.ts` → `src/capabilities/providers/`
- Modify: every importer of the above

**Interfaces:**
- Consumes: `ObservationPlatform` (Task 1), `hasGrant` (Task 1's `src/kernel/security.js`), `AutonomousExecutive` (Task 4's `src/executive/autonomous_executive.js`), `MindKernel` (Task 2's `src/self/kernel.js`).
- Produces: `executeTool`, `getAllToolDeclarations`, `TOOL_DECLARATIONS` (from `tools.ts`); `proposeMcpServer`/`connectAndListTools`/`callMcpTool`/etc. (from `mcp-registry.ts`) all keep their names, now at `src/capabilities/*.js`; every provider export (`getRepo`, `sendEmail`, `webSearch`, etc.) keeps its name, now at `src/capabilities/providers/*.js`.

This is the task that finally empties `src/execution/` and `src/integrations/` entirely.

- [ ] **Step 1: Clear dead cache, then move the files**

```bash
rm -rf src/capabilities/__pycache__ src/capabilities/providers
mkdir -p src/capabilities/providers
git mv src/execution/tools.ts src/capabilities/tools.ts
git mv src/execution/mcp-registry.ts src/capabilities/mcp-registry.ts
git mv src/integrations/calendar.ts src/capabilities/providers/calendar.ts
git mv src/integrations/email.ts src/capabilities/providers/email.ts
git mv src/integrations/files.ts src/capabilities/providers/files.ts
git mv src/integrations/github.ts src/capabilities/providers/github.ts
git mv src/integrations/news.ts src/capabilities/providers/news.ts
git mv src/integrations/websearch.ts src/capabilities/providers/websearch.ts
rmdir src/execution
```

(`src/integrations/` is not removed here — `tts.ts`, `whisper.ts`, `push.ts` still live there until Task 9.)

- [ ] **Step 2: Fix the moved files' own internal imports**

`tools.ts` and `mcp-registry.ts` move from `execution/` (one level) to `capabilities/` (one level) — same `../` counts for anything that hasn't moved, updated segments for anything that has (e.g. `../execution/permissions.js` → `../kernel/security.js`, `../execution/autonomous_executive.js` → `../executive/autonomous_executive.js`, `../integrations/github.js` → `./providers/github.js` since both now live under `capabilities/`).

`calendar.ts`/`email.ts`/`files.ts`/`github.ts`/`news.ts`/`websearch.ts` move from `integrations/` (one level) to `capabilities/providers/` (two levels) — this is the one case in this plan where depth actually increases, so imports to anything under `src/` need one *more* `../`. Worked example: `github.ts` importing `ObservationPlatform` previously via `../observation/index.js` (up once from `integrations/`) now needs `../../kernel/observation.js` (up twice from `capabilities/providers/`, since it's two levels deep now).

- [ ] **Step 3: Find and fix every external importer**

```bash
grep -rln 'execution/tools\.js\|execution/mcp-registry\.js\|integrations/calendar\.js\|integrations/email\.js\|integrations/files\.js\|integrations/github\.js\|integrations/news\.js\|integrations/websearch\.js' src/ tests/ --include="*.ts"
```

For every match, apply the corresponding rename from the Files list above (e.g. `.../execution/tools.js` → `.../capabilities/tools.js`, `.../integrations/github.js` → `.../capabilities/providers/github.js`), adjusting `../` count per Step 2's depth-increase note for the 6 provider files.

- [ ] **Step 4: Run tsc, iterate until clean**

Run: `npx tsc --noEmit`
Expected: eventually zero errors.

- [ ] **Step 5: Run the test suite**

Run: `npm test`
Expected: `89 / 89 Tests Passed`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: move tools/mcp-registry/external providers into src/capabilities/"
```

---

### Task 9: Interaction — voice, TTS, whisper, push, static assets, desktop client

**Files:**
- Delete first: `src/interaction/`'s existing contents (dead `__pycache__` only — confirmed untracked via `git ls-files`)
- Move: `src/cognition/live-voice.ts` → `src/interaction/live-voice.ts`
- Move: `src/integrations/tts.ts`, `whisper.ts`, `push.ts` → `src/interaction/`
- Move: `src/static/` (whole tree) → `src/interaction/static/`
- Move: `src/desktop/app.py` → `src/interaction/desktop/app.py`
- Modify: `src/server.ts` (the static-file-serving path, one line), `package.json` (the `build:css` script, 4 path segments), `tailwind.index.config.js`, `tailwind.admin.config.js` (each file's `content:` path), every importer of the moved `.ts` files

**Interfaces:**
- Consumes: `Groq`/`GoogleGenAI` clients (passed in as parameters, no import path change needed for those types themselves), `ObservationPlatform` (Task 1).
- Produces: `bridgeVoiceSession` (from `live-voice.ts`) keeps its name, now at `src/interaction/live-voice.js`; TTS/whisper/push exports keep their names, now at `src/interaction/*.js`.

This is the task that finally empties `src/integrations/` and `src/desktop/` entirely.

- [ ] **Step 1: Clear dead cache, then move the files**

```bash
rm -rf src/interaction/__pycache__
mkdir -p src/interaction/desktop
git mv src/cognition/live-voice.ts src/interaction/live-voice.ts
git mv src/integrations/tts.ts src/interaction/tts.ts
git mv src/integrations/whisper.ts src/interaction/whisper.ts
git mv src/integrations/push.ts src/interaction/push.ts
git mv src/static src/interaction/static
git mv src/desktop/app.py src/interaction/desktop/app.py
rmdir src/integrations src/desktop
```

- [ ] **Step 2: Fix the moved .ts files' own internal imports**

`live-voice.ts` moves from `cognition/` (one level) to `interaction/` (one level) — same `../` counts, segments updated per already-moved targets. `tts.ts`, `whisper.ts`, `push.ts` move from `integrations/` (one level) to `interaction/` (one level) — same rule, no depth change (unlike Task 8's provider files, since `interaction/` is one level, not two).

- [ ] **Step 3: Update the static-file-serving path in `server.ts`**

Find:

```ts
const staticDir = path.join(process.cwd(), "src", "static");
```

Replace with:

```ts
const staticDir = path.join(process.cwd(), "src", "interaction", "static");
```

Also update the comment at `src/server.ts:91` (`// The frontend (src/static/*.html) is a pre-existing single-file dashboard`) to say `src/interaction/static/*.html` instead, so it doesn't mislead the next reader.

- [ ] **Step 4: Update `package.json`'s `build:css` script**

Find:

```json
    "build:css": "tailwindcss -c tailwind.index.config.js -i ./src/static/css/tailwind-input.css -o ./src/static/css/tailwind-index.css --minify && tailwindcss -c tailwind.admin.config.js -i ./src/static/css/tailwind-input.css -o ./src/static/css/tailwind-admin.css --minify"
```

Replace with:

```json
    "build:css": "tailwindcss -c tailwind.index.config.js -i ./src/interaction/static/css/tailwind-input.css -o ./src/interaction/static/css/tailwind-index.css --minify && tailwindcss -c tailwind.admin.config.js -i ./src/interaction/static/css/tailwind-input.css -o ./src/interaction/static/css/tailwind-admin.css --minify"
```

- [ ] **Step 5: Update the two Tailwind config files**

In `tailwind.index.config.js`, find `content: ["./src/static/index.html"],` and replace with `content: ["./src/interaction/static/index.html"],` (and update the file's opening comment referencing `src/static/index.html` the same way).

In `tailwind.admin.config.js`, find `content: ["./src/static/admin.html"],` and replace with `content: ["./src/interaction/static/admin.html"],` (and update its opening comment the same way).

- [ ] **Step 6: Find and fix every external importer of the moved .ts files**

```bash
grep -rln 'cognition/live-voice\.js\|integrations/tts\.js\|integrations/whisper\.js\|integrations/push\.js' src/ tests/ --include="*.ts"
```

For every match: `.../cognition/live-voice.js` → `.../interaction/live-voice.js`; `.../integrations/tts.js` → `.../interaction/tts.js` (and the same pattern for `whisper.js`, `push.js`).

- [ ] **Step 7: Run tsc, iterate until clean**

Run: `npx tsc --noEmit`
Expected: eventually zero errors.

- [ ] **Step 8: Run the test suite**

Run: `npm test`
Expected: `89 / 89 Tests Passed`.

- [ ] **Step 9: Manually verify the frontend still serves**

Run: `npm run dev` (or restart the running dev process), then `curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/` and confirm `200` — this is the one part of this task a passing test suite doesn't directly cover (no existing test hits the static-file route), since it depends on the `staticDir` path actually resolving on disk, not just compiling.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "refactor: move voice/TTS/whisper/push/static/desktop-client into src/interaction/"
```

---

### Task 10: Cleanup — docs consolidation, dead code, repo hygiene

**Files:**
- Create: `ARCHITECTURE.md`
- Delete: `CONSTITUTION.md`, `DEVELOPMENT_CONSTITUTION.md`, `COGNITIVE_MODEL.md`, `EXECUTION_MODEL.md`, `governance/ECOSYSTEM_MODEL.md`, `governance/ENVIRONMENT_MODEL.md`, `governance/EVOLUTION_MODEL.md`, `governance/INTERACTION_MODEL.md`, `governance/OBSERVATION_MODEL.md`, `governance/core_abstractions.md`
- Delete: `docs/archive/` (all 6 files)
- Delete: `src/bridge/synapse.py`, `src/infrastructure/health.py`
- Delete: leftover dead `__pycache__` under `src/environment/`, `src/voice/`, `src/ecosystem/` (the two the reorg reused, `src/capabilities/` and `src/interaction/`, were already cleared in Tasks 8-9)
- Delete: `bun.lock`, `plugins/my_new_plugin`, `speech.mp3`, `test_audio.mp3`
- Modify: `.gitignore`

**Interfaces:** none — this task touches no `.ts`/`.py` imports.

- [ ] **Step 1: Write `ARCHITECTURE.md`**

Create `ARCHITECTURE.md` at the repo root with this content:

```markdown
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
```

- [ ] **Step 2: Delete the consolidated-away governance docs**

```bash
git rm CONSTITUTION.md DEVELOPMENT_CONSTITUTION.md COGNITIVE_MODEL.md EXECUTION_MODEL.md
git rm governance/ECOSYSTEM_MODEL.md governance/ENVIRONMENT_MODEL.md governance/EVOLUTION_MODEL.md governance/INTERACTION_MODEL.md governance/OBSERVATION_MODEL.md governance/core_abstractions.md
rmdir governance
```

- [ ] **Step 3: Delete `docs/archive/`**

```bash
git rm -r docs/archive
```

- [ ] **Step 4: Delete dead Python scaffolding**

```bash
git rm src/bridge/synapse.py src/infrastructure/health.py
rmdir src/bridge src/infrastructure
```

- [ ] **Step 5: Clear remaining dead `__pycache__` directories**

```bash
rm -rf src/environment src/voice src/ecosystem
```

(Untracked — confirmed via `git ls-files src/environment src/voice src/ecosystem` returning nothing — so no `git rm` needed, a plain `rm -rf` is sufficient and correct.)

- [ ] **Step 6: Remove dead lockfile, dummy plugin, stray media**

```bash
git rm bun.lock
git rm -r plugins/my_new_plugin
git rm speech.mp3 test_audio.mp3
```

- [ ] **Step 7: Add `.gitignore` rules to prevent recurrence**

Find the end of `.gitignore` and add:

```gitignore

# Stray media/audio artifacts that shouldn't land in the repo root
*.mp3
*.wav
```

- [ ] **Step 8: Run tsc and the test suite one final time**

Run: `npx tsc --noEmit`
Expected: zero errors (this task touches no `.ts` imports, so this should already be clean from Task 9 — this is a final confirmation, not expected to find anything new).

Run: `npm test`
Expected: `89 / 89 Tests Passed`.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "docs: consolidate governance docs into ARCHITECTURE.md; remove dead code and repo-hygiene cruft"
```
