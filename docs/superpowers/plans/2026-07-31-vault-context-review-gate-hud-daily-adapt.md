# Vault Context, Deterministic Review Gate, HUD Extension, and Daily Adaptation Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close two narrow, real gaps found in already-working subsystems (vault-context for the reflection engine, a deterministic build/test gate before the coding agent's LLM reviewer), extend the already-shipped poll-based HUD with two more fields, and add a human-checkpointed daily adaptation engine that proposes (never autonomously merges code or registers new tools).

**Architecture:** See `/home/ubuntu/.claude/plans/peppy-stirring-meerkat.md` for the full investigation and design rationale (streams 1-3 of an original 5-stream request were found already built; this plan targets only the confirmed gaps, per the human partner's explicit scope decisions). Five tasks, each independently testable.

**Tech Stack:** Node/TypeScript (existing Express backend), systemd `--user` units (matching the already-shipped HUD units, not system-level/root).

## Global Constraints

- `npx tsc --noEmit` and `npm test` must both pass after every task below, before that task's commit.
- The daily adaptation engine must NEVER write code, merge anything, or register a new MCP tool unattended — it writes a report and, at most, kicks off the same already-safe research-then-halt-for-consult entry point a live user's own objectives already go through (`AutonomousExecutive.executeObjective`, which stops at `awaiting_consult` for any objective classified with a coding step).
- All new systemd units are **user-level** (`~/.config/systemd/user/`, installed via `scripts/deploy-daily-adapt.sh`) — no root, no `/etc/systemd/system/`.
- Do not modify the already-working vault indexer, MCP registry, or coding-agent sandbox beyond the single insertion point each task specifies.

---

## File Structure

| File | Change |
|---|---|
| `src/adaptation/reflection.ts` | Modify — query vault for related notes before the Groq reflection call |
| `src/executive/coding-agent.ts` | Modify — deterministic tsc/test gate before `reviewTaskDiff` |
| `src/interaction/routes/hud-routes.ts` | Modify — add `recentNotes`, `activeTask` |
| `src/kernel/state/build-requests-repo.ts` | No change — reuse existing `listBuildRequests(status)` |
| `src/system/eww-adapter.ts` | Modify — push `jarvis_task`/`jarvis_notes` |
| `config/eww/eww.yuck` | Modify — render the two new fields |
| `src/capabilities/providers/obsidian.ts` | Modify — add `"Adaptation"` to `MOC_FOLDERS`, add `writeAdaptationReport` |
| `src/adaptation/daily-adaptation.ts` | Create — the engine itself |
| `src/interaction/routes/adaptation-routes.ts` | Create — `POST /api/adaptation/run` |
| `src/kernel/security.ts` | Modify — add `adaptation.run` capability |
| `src/server.ts` | Modify — mount `adaptationRouter`, call `dailyAdaptation.configureGroq(groq)` |
| `deploy/jarvis-daily-adapt.service` / `.timer` | Create |
| `scripts/deploy-daily-adapt.sh` | Create |

---

### Task 1: Vault-context read for the reflection engine

**Files:**
- Modify: `src/adaptation/reflection.ts`
- Test: `tests/index.test.ts`

**Interfaces:**
- Consumes: `vaultRepo.searchNotes(query: string, limit?: number): Promise<VaultNoteRow[]>` (already exists, `src/kernel/state/vault-repo.ts`).
- Produces: no signature change to `reflectAndLearn` — the prompt content changes internally only.

- [ ] **Step 1: Write the failing test**

Add to `tests/index.test.ts` (new `import { reflectAndLearn } from "../src/adaptation/reflection.js";` and `import * as vaultRepo from "../src/kernel/state/vault-repo.js";` near the other imports — check if either is already imported before adding a duplicate):

```ts
registerTest("Reflection", "reflectAndLearn degrades cleanly when Postgres isn't reachable (vault search failure never blocks the reflection call)", async () => {
  const fakeGroq: any = {
    chat: {
      completions: {
        create: async () => ({
          choices: [{ message: { content: JSON.stringify({
            styleNamingConvention: "", styleTabSize: 0, styleFramework: "", styleArchitecture: "",
            mistakeErrorSignature: "", mistakeFile: "", mistakeRootCause: "", mistakeFix: "",
          }) } }],
        }),
      },
    },
  };
  // No live Postgres in this test harness — vaultRepo.searchNotes will fail
  // internally; reflectAndLearn must still complete without throwing.
  await reflectAndLearn(fakeGroq, "test message", "test reply");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test 2>&1 | grep -E "Reflection|FAILED"`
Expected: FAIL — `reflectAndLearn` doesn't yet import `vaultRepo`, so this test currently just exercises the pre-existing code path; run it once now to confirm it already passes (it should, harmlessly), then re-run after Step 3 to confirm it STILL passes once the new vault-search call is added — this is a regression-lock test, not a strict TDD red-green cycle, since the current code has no vault call yet to fail against.

- [ ] **Step 3: Write the implementation**

In `src/adaptation/reflection.ts`, add the import (alongside the existing `Type`/`Groq`/`toGroqSchema`/`ObservationPlatform`/`LongTermLearningEngine` imports at the top):

```ts
import * as vaultRepo from "../kernel/state/vault-repo.js";
```

Change the body of `reflectAndLearn` from:

```ts
export async function reflectAndLearn(
  groq: Groq | null,
  userMessage: string,
  replyText: string
): Promise<void> {
  if (!groq) return;
  try {
    const response = await groq.chat.completions.create({
      model: "openai/gpt-oss-20b",
      messages: [{
        role: "user",
        content:
          "Analyze this exchange between a user and Jarvis, an AI assistant. " +
          "Only report a coding style preference if the user actually stated or clearly implied one. " +
          "Only report a mistake if a real error/bug and its fix were actually discussed — not a hypothetical. " +
          "Leave any field empty (\"\" or 0) if it doesn't apply; do not invent content to fill the schema.\n\n" +
          `User: ${userMessage}\n\nJarvis: ${replyText.slice(0, 1500)}`,
      }],
```

to:

```ts
export async function reflectAndLearn(
  groq: Groq | null,
  userMessage: string,
  replyText: string
): Promise<void> {
  if (!groq) return;
  try {
    // Best-effort, never blocks the reflection call — a related-notes
    // hint just lets the extraction judge "is this genuinely new" more
    // accurately; it's not load-bearing if the vault is unreachable.
    const relatedNotes = await vaultRepo.searchNotes(userMessage.slice(0, 200), 3).catch(() => []);
    const relatedContext = relatedNotes.length > 0
      ? `\n\nRelated past vault notes (for context — don't repeat what's already captured there):\n${relatedNotes.map(n => `- ${n.title} (${n.path})`).join("\n")}`
      : "";

    const response = await groq.chat.completions.create({
      model: "openai/gpt-oss-20b",
      messages: [{
        role: "user",
        content:
          "Analyze this exchange between a user and Jarvis, an AI assistant. " +
          "Only report a coding style preference if the user actually stated or clearly implied one. " +
          "Only report a mistake if a real error/bug and its fix were actually discussed — not a hypothetical. " +
          "Leave any field empty (\"\" or 0) if it doesn't apply; do not invent content to fill the schema.\n\n" +
          `User: ${userMessage}\n\nJarvis: ${replyText.slice(0, 1500)}${relatedContext}`,
      }],
```

Leave everything else in the function (the `response_format` block, the parsing logic below `const parsed = ...`, and the outer `catch`) completely unchanged.

- [ ] **Step 4: Run to verify it passes**

Run: `npx tsc --noEmit && npm test 2>&1 | grep -E "Reflection|FAILED|TOTALS"`
Expected: clean typecheck, the new test passes, no regressions.

- [ ] **Step 5: Commit**

```bash
git add src/adaptation/reflection.ts tests/index.test.ts
git commit -m "feat: give reflectAndLearn vault context before judging what's genuinely new"
```

---

### Task 2: Deterministic build/test gate before the LLM reviewer

**Files:**
- Modify: `src/executive/coding-agent.ts`
- Test: manual/live-verification (this path needs a real sandboxed workspace round trip — the existing per-task loop already has no unit test harness for its live sandbox interaction, matching how Tasks 6-9 of the reward-system plan handled similar sandbox-dependent logic)

**Interfaces:**
- Consumes: `builderClient.execInWorkspace(buildRequestId: number, command: string): Promise<{stdout: string; stderr: string; exitCode: number}>` (already used throughout this file).
- Produces: no signature change — internal behavior only.

- [ ] **Step 1: Write the implementation**

In `src/executive/coding-agent.ts`, find this exact block (currently at line 356-359):

```ts
        const { files: taskFiles, skipped: taskSkipped } = await extractChangedFiles(buildRequestId, taskBaseSha);
        const verdict = await departments.reviewTaskDiff(task.title, task.description, taskFiles, groq);
        await rewardEventsRepo.recordRewardEvent(buildRequestId, "task_review", sessionModelUsed, category, verdict.approved ? 1 : -1);
        lastFindings = verdict.findings;
```

Change it to:

```ts
        const { files: taskFiles, skipped: taskSkipped } = await extractChangedFiles(buildRequestId, taskBaseSha);
        // A deterministic gate ahead of the LLM reviewer: code that doesn't
        // even compile or pass its own tests shouldn't reach an LLM
        // judgment call at all — this is real, not up to interpretation.
        // Reuses the exact retry-with-feedback path below (rewardEventsRepo
        // recording, lastFindings, the approve/retry branch) unchanged;
        // only the source of `verdict` changes on a verification failure.
        const verifyResult = await builderClient
          .execInWorkspace(buildRequestId, "npx tsc --noEmit && npm test")
          .catch((err: any) => ({ stdout: "", stderr: err.message || String(err), exitCode: -1 }));
        const verdict = verifyResult.exitCode !== 0
          ? {
              approved: false,
              findings: `Deterministic verification failed (exit ${verifyResult.exitCode}) before LLM review:\n${verifyResult.stdout.slice(-2000)}\n${verifyResult.stderr.slice(-2000)}`,
            }
          : await departments.reviewTaskDiff(task.title, task.description, taskFiles, groq);
        await rewardEventsRepo.recordRewardEvent(buildRequestId, "task_review", sessionModelUsed, category, verdict.approved ? 1 : -1);
        lastFindings = verdict.findings;
```

Do not touch anything below this block (the `if (verdict.approved) { ... } else if (fixAttempt < MAX_TASK_FIX_ATTEMPTS) { ... }` branch at lines 361-392) — it already handles both the deterministic-failure verdict and the LLM verdict identically, since both produce the same `{approved, findings}` shape.

- [ ] **Step 2: Run to verify no regressions**

Run: `npx tsc --noEmit && npm test 2>&1 | grep -E "FAILED|TOTALS"`
Expected: clean typecheck, same test total as before (this task adds no new unit tests — the sandbox round-trip it changes needs a real jarvis-builder container, verified live post-merge, matching how earlier sandbox-dependent coding-agent changes in this codebase were verified).

- [ ] **Step 3: Commit**

```bash
git add src/executive/coding-agent.ts
git commit -m "feat: gate the LLM task reviewer on a real tsc/test pass first"
```

---

### Task 3: Extend the poll-based HUD with active task and recent notes

**Files:**
- Modify: `src/interaction/routes/hud-routes.ts`, `src/system/eww-adapter.ts`, `config/eww/eww.yuck`
- Test: `tests/index.test.ts` (route logic only — the eww-adapter/yuck changes are config/host-side, verified live same as the original HUD ship)

**Interfaces:**
- Produces: `GET /api/hud/status` gains `recentNotes: {path: string; title: string}[]` (replaces `lastNote`) and `activeTask: string | null`.

- [ ] **Step 1: Write the failing test**

Add to `tests/index.test.ts`, in the existing `"HudRoutes"` test group (search for `registerTest("HudRoutes"`):

```ts
registerTest("HudRoutes", "deriveHudBadge still exported and unaffected by the response-shape widening", () => {
  // The widened response shape (recentNotes/activeTask) is exercised
  // end-to-end only against a live DB (same reasoning as this route's
  // existing lastNote/thoughtLines fields) — this test just locks in
  // that deriveHudBadge's own contract (already covered by the 5 existing
  // HudRoutes tests) is untouched by this task's route changes.
  if (deriveHudBadge("Idle", false) !== "idle") {
    throw new Error("HudRoutes: deriveHudBadge behavior changed unexpectedly");
  }
});
```

- [ ] **Step 2: Run to verify it passes trivially, then move to implementation**

Run: `npm test 2>&1 | grep -E "HudRoutes|FAILED"` — this should already pass (it's a regression lock on an existing function's contract, not new logic).

- [ ] **Step 3: Widen the route**

In `src/interaction/routes/hud-routes.ts`, add the import (alongside the existing `getSession`/`ObservationPlatform`/`vaultRepo`/`deriveHudBadge` imports):

```ts
import * as buildRequestsRepo from "../../kernel/state/build-requests-repo.js";
```

Change the handler body from:

```ts
    const traces = observation.getDecisionTraces();
    const thoughtLines = traces.map(t => t.reasoning).filter(Boolean).slice(-3);

    let lastNote: { path: string; title: string } | null = null;
    try {
      const notes = await vaultRepo.listNotes(1);
      if (notes[0]) lastNote = { path: notes[0].path, title: notes[0].title };
    } catch {
      // Degrade cleanly — no live Postgres shouldn't break the rest of the HUD.
    }

    res.json({
      badge,
      statusLabel: state.executiveStatus,
      thoughtLines,
      lastNote,
    });
```

to:

```ts
    const traces = observation.getDecisionTraces();
    const thoughtLines = traces.map(t => t.reasoning).filter(Boolean).slice(-3);

    let recentNotes: { path: string; title: string }[] = [];
    try {
      const notes = await vaultRepo.listNotes(3);
      recentNotes = notes.map(n => ({ path: n.path, title: n.title }));
    } catch {
      // Degrade cleanly — no live Postgres shouldn't break the rest of the HUD.
    }

    // No user-scoped, multi-status query exists on build-requests-repo —
    // two small calls plus a filter, rather than adding one for a single
    // HUD field. Coding and researching are mutually exclusive statuses
    // for a given build request, so concatenating is safe.
    let activeTask: string | null = null;
    try {
      const [coding, researching] = await Promise.all([
        buildRequestsRepo.listBuildRequests("coding"),
        buildRequestsRepo.listBuildRequests("researching"),
      ]);
      const mine = [...coding, ...researching].find(r => r.requested_by === hudUsername);
      if (mine) activeTask = mine.objective;
    } catch {
      // Degrade cleanly — no live Postgres shouldn't break the rest of the HUD.
    }

    res.json({
      badge,
      statusLabel: state.executiveStatus,
      thoughtLines,
      recentNotes,
      activeTask,
    });
```

Update the outer `catch` block's fallback response from `res.status(500).json({ badge: "error", statusLabel: "Unavailable", thoughtLines: [], lastNote: null, error: "Failed to load HUD status." });` to `res.status(500).json({ badge: "error", statusLabel: "Unavailable", thoughtLines: [], recentNotes: [], activeTask: null, error: "Failed to load HUD status." });`.

- [ ] **Step 4: Update the eww-adapter**

In `src/system/eww-adapter.ts`, find the success-path `ewwUpdate({...})` call (currently):

```ts
    ewwUpdate({
      jarvis_badge: data.badge || "idle",
      jarvis_status: JSON.stringify(data.statusLabel || ""),
      // A real newline, not the two-character "\n" escape sequence — the
      // latter would survive JSON.stringify as a literal backslash-n
      // instead of a line break, so yuck's :wrap label would render the
      // text "\n" between thoughts rather than actually wrapping them.
      jarvis_thought: JSON.stringify((data.thoughtLines || []).join("\n")),
      jarvis_note: JSON.stringify(data.lastNote ? data.lastNote.title : "None yet"),
    });
```

Change to:

```ts
    ewwUpdate({
      jarvis_badge: data.badge || "idle",
      jarvis_status: JSON.stringify(data.statusLabel || ""),
      // A real newline, not the two-character "\n" escape sequence — the
      // latter would survive JSON.stringify as a literal backslash-n
      // instead of a line break, so yuck's :wrap label would render the
      // text "\n" between thoughts rather than actually wrapping them.
      jarvis_thought: JSON.stringify((data.thoughtLines || []).join("\n")),
      jarvis_task: JSON.stringify(data.activeTask || "None"),
      jarvis_notes: JSON.stringify((data.recentNotes || []).map((n: any) => n.title).join("\n") || "None yet"),
    });
```

Update the two error-path `ewwUpdate({...})` calls (the `!res.ok` branch and the outer `catch`) to replace their `jarvis_note: JSON.stringify("")` field with `jarvis_task: JSON.stringify("Unknown"), jarvis_notes: JSON.stringify("")` (matching the new field names — `jarvis_note` no longer exists as a variable name anywhere after this task).

- [ ] **Step 5: Update the yuck config**

In `config/eww/eww.yuck`, change:

```lisp
(defvar jarvis_badge "idle")
(defvar jarvis_status "Idle")
(defvar jarvis_thought "")
(defvar jarvis_note "None yet")
```

to:

```lisp
(defvar jarvis_badge "idle")
(defvar jarvis_status "Idle")
(defvar jarvis_thought "")
(defvar jarvis_task "None")
(defvar jarvis_notes "None yet")
```

Change:

```lisp
    (box :class "hud-section" :orientation "v" :space-evenly false
      (label :class "hud-label" :text "LAST NOTE")
      (label :class "hud-note" :wrap true :limit-width 42 :text jarvis_note))))
```

to:

```lisp
    (box :class "hud-section" :orientation "v" :space-evenly false
      (label :class "hud-label" :text "ACTIVE TASK")
      (label :class "hud-note" :wrap true :limit-width 42 :text jarvis_task))
    (box :class "hud-section" :orientation "v" :space-evenly false
      (label :class "hud-label" :text "RECENT NOTES")
      (label :class "hud-note" :wrap true :limit-width 42 :text jarvis_notes))))
```

No `eww.scss` changes needed — reuses the existing `.hud-section`/`.hud-label`/`.hud-note` classes.

- [ ] **Step 6: Run to verify it passes**

Run: `npx tsc --noEmit && npm test 2>&1 | grep -E "HudRoutes|FAILED|TOTALS"`
Expected: clean typecheck, no regressions.

- [ ] **Step 7: Commit**

```bash
git add src/interaction/routes/hud-routes.ts src/system/eww-adapter.ts config/eww/eww.yuck tests/index.test.ts
git commit -m "feat: add active task and recent notes to the HUD"
```

---

### Task 4: Daily adaptation engine core logic

**Files:**
- Create: `src/adaptation/daily-adaptation.ts`
- Modify: `src/capabilities/providers/obsidian.ts`
- Test: `tests/index.test.ts`

**Interfaces:**
- Consumes: `objectivesRepo.listActiveObjectives(username)`, `analyzer.analyzeArchitecture/analyzeQuality/analyzePerformance/analyzeSecurity()`, `buildRequestsRepo.getLatestAwaitingConsult(username)`, `buildRequestsRepo.getLatestPendingRewardGate(username)`, `AutonomousExecutive.getInstance()`, `getSession(username)`, `scheduler.pushNotification`.
- Produces: `export function configureGroq(client: Groq | null): void`, `export async function runDailyAdaptation(username?: string): Promise<{ ok: boolean; reportPath: string; candidateObjectiveStarted: boolean }>`.

- [ ] **Step 1: Write the failing test**

Add to `tests/index.test.ts` (new imports: `import * as dailyAdaptation from "../src/adaptation/daily-adaptation.js";`):

```ts
registerTest("DailyAdaptation", "runDailyAdaptation degrades cleanly (ok: false, no throw) when Postgres isn't reachable", async () => {
  dailyAdaptation.configureGroq(null);
  const result = await dailyAdaptation.runDailyAdaptation("test_user_no_db");
  if (result.ok !== false) {
    throw new Error(`DailyAdaptation: expected ok: false with no DB, got: ${JSON.stringify(result)}`);
  }
  if (result.candidateObjectiveStarted !== false) {
    throw new Error("DailyAdaptation: candidateObjectiveStarted must be false when nothing could run");
  }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test 2>&1 | grep -E "DailyAdaptation|FAILED"`
Expected: FAIL — `Cannot find module '../src/adaptation/daily-adaptation.js'`.

- [ ] **Step 3: Extend obsidian.ts with the Adaptation MOC folder and a report writer**

In `src/capabilities/providers/obsidian.ts`, change:

```ts
const MOC_FOLDERS = ["Briefings", "Coding", "Reflections", "Research"] as const;
```

to:

```ts
const MOC_FOLDERS = ["Adaptation", "Briefings", "Coding", "Reflections", "Research"] as const;
```

Add a new exported function, right after `writeResearchNote` (following its exact structure):

```ts
export async function writeAdaptationReport(
  dateStr: string,
  reflectionText: string,
  capabilityGaps: string[],
  candidateObjective: string
): Promise<void> {
  if (!process.env.OBSIDIAN_VAULT_DIR) {
    observation.logTelemetry("info", "Interaction", "Skipped writing adaptation report — OBSIDIAN_VAULT_DIR not configured.");
    return;
  }
  const lines: string[] = [
    `# Daily Adaptation — ${dateStr}`,
    "",
    reflectionText,
    "",
    "## Capability Gaps",
    "",
    ...(capabilityGaps.length > 0 ? capabilityGaps.map(g => `- ${g}`) : ["- None identified today."]),
    "",
    "## Candidate Next Objective",
    "",
    candidateObjective || "(none identified today)",
    "",
  ];
  await createNote(
    `Adaptation/${dateStr}`,
    lines.join("\n"),
    withMocFrontmatter("Adaptation", { type: "adaptation-report", created: new Date().toISOString() })
  );
  await ensureLinkedInMoc("Adaptation", `Adaptation/${dateStr}`);
}
```

- [ ] **Step 4: Write daily-adaptation.ts**

```ts
// src/adaptation/daily-adaptation.ts
//
// A human-checkpointed daily engine: it reads goals, analyzes real system
// signals, and writes a report proposing capability gaps and a candidate
// next objective — it never writes code and never registers a new MCP
// tool itself. If it identifies a candidate objective, the most it does
// is call the SAME entry point a live user's own objectives already go
// through (AutonomousExecutive.executeObjective), which halts at
// awaiting_consult for any objective classified with a coding step —
// the existing human-confirmation gate is never bypassed.
import Groq from "groq-sdk";
import { Type } from "@google/genai";
import { toGroqSchema } from "../runtime/groq-client.js";
import { ObservationPlatform } from "../kernel/observation.js";
import * as objectivesRepo from "../kernel/state/objectives-repo.js";
import * as buildRequestsRepo from "../kernel/state/build-requests-repo.js";
import * as analyzer from "./analyzer.js";
import * as obsidian from "../capabilities/providers/obsidian.js";
import { getSession } from "../cognition/session.js";
import { pushNotification } from "../kernel/scheduler.js";
import { AutonomousExecutive } from "../executive/autonomous_executive.js";

const observation = ObservationPlatform.getInstance();

let configuredGroq: Groq | null = null;
export function configureGroq(client: Groq | null): void {
  configuredGroq = client;
}

const ADAPTATION_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    reflectionText: { type: Type.STRING, description: "A short, honest written reflection on the current state of the project given the objectives and analysis signals below — 2-4 sentences." },
    capabilityGaps: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Concrete, specific capability or tooling gaps this analysis suggests — empty array if none stand out." },
    candidateObjective: { type: Type.STRING, description: "One concrete, actionable next objective phrased as an imperative starting with 'Implement:' or 'Build:' (so it's classified as coding work and requires human direction confirmation before any code is touched), or \"\" if nothing concrete stands out today." },
  },
  required: ["reflectionText", "capabilityGaps", "candidateObjective"],
};

export async function runDailyAdaptation(username = "admin"): Promise<{ ok: boolean; reportPath: string; candidateObjectiveStarted: boolean }> {
  const dateStr = new Date().toISOString().slice(0, 10);
  const reportPath = `Adaptation/${dateStr}`;
  try {
    const objectives = await objectivesRepo.listActiveObjectives(username);
    const analysis = {
      architecture: analyzer.analyzeArchitecture(),
      quality: analyzer.analyzeQuality(),
      performance: analyzer.analyzePerformance(),
      security: analyzer.analyzeSecurity(),
    };

    let reflectionText = "No Groq client configured — unable to generate a written reflection today.";
    let capabilityGaps: string[] = [];
    let candidateObjective = "";

    if (configuredGroq) {
      const issuesSummary = Object.entries(analysis)
        .map(([name, result]) => `${name}: score ${result.score}, ${result.issues.length} issue(s)${result.issues.length ? ` (${result.issues.slice(0, 3).map(i => i.message).join("; ")})` : ""}`)
        .join("\n");
      const objectivesSummary = objectives.length > 0
        ? objectives.map(o => `- ${o.description}`).join("\n")
        : "(no active objectives)";

      const response = await configuredGroq.chat.completions.create({
        model: "openai/gpt-oss-20b",
        messages: [{
          role: "user",
          content:
            "You are Jarvis's own daily self-adaptation reflection. Given the current active objectives and real, computed system-analysis signals below, " +
            "write a short honest reflection, list any concrete capability gaps you notice, and propose exactly one candidate next objective if something " +
            "concrete stands out — leave it empty if nothing does. Do not invent problems that aren't supported by the signals.\n\n" +
            `Active objectives:\n${objectivesSummary}\n\nAnalysis signals:\n${issuesSummary}`,
        }],
        response_format: {
          type: "json_schema",
          json_schema: { name: "daily_adaptation", schema: toGroqSchema(ADAPTATION_SCHEMA), strict: true },
        },
      });
      const parsed = JSON.parse(response.choices[0]?.message?.content || "{}");
      reflectionText = typeof parsed.reflectionText === "string" ? parsed.reflectionText : reflectionText;
      capabilityGaps = Array.isArray(parsed.capabilityGaps) ? parsed.capabilityGaps : [];
      candidateObjective = typeof parsed.candidateObjective === "string" ? parsed.candidateObjective : "";
    }

    await obsidian.writeAdaptationReport(dateStr, reflectionText, capabilityGaps, candidateObjective);

    let candidateObjectiveStarted = false;
    if (candidateObjective) {
      // Same double-check executeObjectiveLocked itself does before opening
      // a new build request — don't even attempt a call that would just
      // return early, and don't disturb a build the user is already mid-way
      // through confirming/gating.
      const [alreadyAwaiting, alreadyGated] = await Promise.all([
        buildRequestsRepo.getLatestAwaitingConsult(username),
        buildRequestsRepo.getLatestPendingRewardGate(username),
      ]);
      if (!alreadyAwaiting && !alreadyGated) {
        const session = await getSession(username);
        await AutonomousExecutive.getInstance().executeObjective(candidateObjective, session, username);
        candidateObjectiveStarted = true;
      }
    }

    pushNotification(
      username,
      `Daily adaptation ran, sir — wrote today's report to the vault${candidateObjectiveStarted ? ", and started researching a candidate next objective (I'll consult you before any code changes)." : "."}`,
      "info"
    );

    return { ok: true, reportPath, candidateObjectiveStarted };
  } catch (err: any) {
    observation.logTelemetry("warn", "Adaptation", `runDailyAdaptation failed: ${err.message}`);
    return { ok: false, reportPath, candidateObjectiveStarted: false };
  }
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx tsc --noEmit && npm test 2>&1 | grep -E "DailyAdaptation|FAILED|TOTALS"`
Expected: clean typecheck, the new test passes, no regressions.

- [ ] **Step 6: Commit**

```bash
git add src/adaptation/daily-adaptation.ts src/capabilities/providers/obsidian.ts tests/index.test.ts
git commit -m "feat: add the daily adaptation engine (report + human-gated candidate objective)"
```

---

### Task 5: Trigger route, capability, and systemd deployment

**Files:**
- Create: `src/interaction/routes/adaptation-routes.ts`, `deploy/jarvis-daily-adapt.service`, `deploy/jarvis-daily-adapt.timer`, `scripts/deploy-daily-adapt.sh`
- Modify: `src/kernel/security.ts`, `src/server.ts`
- Test: `tests/index.test.ts` (capability list only — the route/systemd pieces are live-verified, matching the HUD ship's own pattern)

This task is executed directly by the controller (not dispatched to a fresh implementer) for the systemd/deploy-script portion, same reasoning as the container-ownership and HUD-deploy tasks in prior plans: it involves live-host verification (installing a real user-level systemd timer, confirming it fires correctly) that a fresh subagent can't do against this specific host. The route/capability/server-mount code portion is a normal SDD task.

- [ ] **Step 1: Add the capability**

In `src/kernel/security.ts`, add `"adaptation.run",` to `ALL_CAPABILITIES` (after `"hud.read",`), with the comment: `// Triggers the daily adaptation engine — reads/analyzes/proposes, never writes code or registers tools unattended.`

- [ ] **Step 2: Write the route**

```ts
// src/interaction/routes/adaptation-routes.ts
import { Router } from "express";
import { validateApiKey } from "../../kernel/auth-middleware.js";
import { requireCapability } from "../../kernel/security.js";
import * as dailyAdaptation from "../../adaptation/daily-adaptation.js";

export const adaptationRouter = Router();

adaptationRouter.post("/api/adaptation/run", validateApiKey, requireCapability("adaptation.run"), async (req: any, res: any) => {
  try {
    const result = await dailyAdaptation.runDailyAdaptation(req.username);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ ok: false, error: "Failed to run the daily adaptation engine." });
  }
});
```

- [ ] **Step 3: Mount the router and configure Groq**

In `src/server.ts`, add `import { adaptationRouter } from "./interaction/routes/adaptation-routes.js";` alongside the other route imports, and `app.use(adaptationRouter);` alongside `app.use(hudRouter);`. Also add `import * as dailyAdaptation from "./adaptation/daily-adaptation.js";` and, right after the existing `briefing.configureGroq(groq);` line (in the Groq client initialization block), add `dailyAdaptation.configureGroq(groq);`.

- [ ] **Step 4: Run to verify no regressions**

Run: `npx tsc --noEmit && npm test 2>&1 | grep -E "FAILED|TOTALS"`
Expected: clean typecheck, same total as before (no new tests in this step — Task 4 already covered the capability's core logic).

- [ ] **Step 5: Commit the code portion**

```bash
git add src/interaction/routes/adaptation-routes.ts src/kernel/security.ts src/server.ts
git commit -m "feat: add POST /api/adaptation/run to trigger the daily adaptation engine"
```

- [ ] **Step 6 (controller, live): write the systemd units and deploy script**

`deploy/jarvis-daily-adapt.service`:
```ini
[Unit]
Description=Jarvis OS daily adaptation engine trigger
After=network-online.target

[Service]
Type=oneshot
EnvironmentFile=-%h/.config/jarvis-daily-adapt.env
ExecStart=/usr/bin/curl -fsS -X POST -H "X-API-Key: ${JARVIS_API_KEY}" http://localhost:3000/api/adaptation/run
```

`deploy/jarvis-daily-adapt.timer`:
```ini
[Unit]
Description=Run the Jarvis daily adaptation engine at 03:00 daily

[Timer]
OnCalendar=*-*-* 03:00:00
Persistent=true

[Install]
WantedBy=timers.target
```

`scripts/deploy-daily-adapt.sh` (mirror `scripts/deploy-hud.sh`'s env-file bootstrapping/validation structure exactly):
```bash
#!/usr/bin/env bash
set -euo pipefail
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

mkdir -p "${HOME}/.config/systemd/user"
cp "$REPO_DIR/deploy/jarvis-daily-adapt.service" "${HOME}/.config/systemd/user/jarvis-daily-adapt.service"
cp "$REPO_DIR/deploy/jarvis-daily-adapt.timer" "${HOME}/.config/systemd/user/jarvis-daily-adapt.timer"

ENV_FILE="${HOME}/.config/jarvis-daily-adapt.env"
if [ ! -f "$ENV_FILE" ]; then
  echo "JARVIS_API_KEY=" > "$ENV_FILE"
  echo "Created $ENV_FILE — fill in JARVIS_API_KEY (an existing Jarvis API key with the adaptation.run grant) before the timer's first real fire."
fi
chmod 600 "$ENV_FILE"

if ! grep -q '^JARVIS_API_KEY=.\+' "$ENV_FILE"; then
  echo "ERROR: JARVIS_API_KEY is not set in $ENV_FILE — fill it in with a real API key (one granted adaptation.run), then re-run this script." >&2
  exit 1
fi

systemctl --user daemon-reload
systemctl --user enable --now jarvis-daily-adapt.timer

echo "Deployed. Check schedule: systemctl --user list-timers jarvis-daily-adapt.timer"
echo "Manually trigger once for testing: systemctl --user start jarvis-daily-adapt.service"
```

Make both new files executable where applicable (`chmod +x scripts/deploy-daily-adapt.sh`) and commit:

```bash
git add deploy/jarvis-daily-adapt.service deploy/jarvis-daily-adapt.timer scripts/deploy-daily-adapt.sh
git commit -m "feat: add the daily adaptation engine's systemd --user timer and deploy script"
```

- [ ] **Step 7 (controller, live verification):**
  - Deploy the branch (push, PR, CI, merge, pull on the live host, rebuild/redeploy the `api` container — same sequence as every prior ship this session).
  - Run `bash scripts/deploy-daily-adapt.sh` on the live host with a real API key (the existing internal admin key, same one used for the HUD's own live verification).
  - Manually trigger once: `systemctl --user start jarvis-daily-adapt.service`, confirm success via `systemctl --user status jarvis-daily-adapt.service`.
  - Confirm a real `Adaptation/YYYY-MM-DD.md` note appears in the vault, linked from a new `Adaptation MOC.md`.
  - Confirm the timer is correctly scheduled: `systemctl --user list-timers jarvis-daily-adapt.timer`.
  - If a candidate objective was proposed, confirm it stopped at `awaiting_consult` (check via the existing dashboard/objectives listing) rather than touching any code — this is the check that actually matters for safety.

---
