# Outcome Ledger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Log every tool call Jarvis executes into a new `outcome_ledger` table, flag a curated set of "consequential" actions for follow-up verification, add a tool for the model to record whether the user confirmed an action worked, and feed that signal into the existing confidence calculation.

**Architecture:** One new Postgres table + repo module (`outcome-ledger-repo.ts`), one write hook at the single choke point all tool calls already flow through (`executeTool` in `tools.ts`), one new model-callable tool (`record_action_outcome`, mirroring the existing `record_command_outcome`), and a small merge of two success-rate signals feeding `server.ts`'s existing confidence calculation.

**Tech Stack:** TypeScript, Node.js, Postgres (via the existing hand-rolled migration runner in `src/kernel/state/migrations/`), the project's custom test runner (`tests/index.test.ts`, run via `npm test` → `tsx tests/index.test.ts`).

**Spec:** [docs/superpowers/specs/2026-08-21-outcome-ledger-design.md](../specs/2026-08-21-outcome-ledger-design.md)

## Global Constraints

- No live Postgres connection exists in the `npm test` process — every repo-level test in `tests/index.test.ts` asserts *degrade-cleanly* behavior (a read returns `null`/`[]`, a write returns `false`, nothing ever throws out of a repo function on a connection failure), exactly as `command-proposals-repo.ts`'s existing tests do. Follow that pattern exactly; do not write tests that assume a real database round-trip.
- Migration ids are permanent once added to `ALL_MIGRATIONS` — never renumber or reorder existing entries (001-013). The new migration is `014_outcome_ledger`.
- `executeTool`'s existing external behavior (its exact return shape on every current path: success, per-case validation errors, permission-denied, unknown-tool, MCP-tool, and the catch-all) must be preserved byte-for-byte after this refactor — the outcome-ledger write is a side effect added around the existing logic, never a change to it.
- Every new repo write function must never throw to its caller — wrap the query in try/catch, log a `observation.logTelemetry("warn", ...)` on failure, and return a safe default (`false`/`undefined`), matching `recordCommandOutcome`'s existing style in `command-proposals-repo.ts:108-124`.

---

### Task 1: `outcome_ledger` migration + repo module

**Files:**
- Create: `src/kernel/state/migrations/014_outcome_ledger.ts`
- Modify: `src/kernel/state/migrations/index.ts`
- Create: `src/kernel/state/outcome-ledger-repo.ts`
- Test: `tests/index.test.ts` (new `OutcomeLedger` category, appended after the existing `"CommandOutcomes"` tests block, i.e. after line 1912)

**Interfaces:**
- Produces: `isConsequentialAction(actionName: string): boolean`, `logAction(username: string, actionName: string, actionSummary: string | null, executionOk: boolean): Promise<void>`, `recordActionOutcome(username: string, actionName: string, outcome: "worked" | "not_worked"): Promise<boolean>`, `getRecentActionSuccessRate(username: string): Promise<number | null>` — all exported from `src/kernel/state/outcome-ledger-repo.ts`. Task 2 consumes `isConsequentialAction` and `logAction`. Task 3 consumes `recordActionOutcome`. Task 4 consumes `getRecentActionSuccessRate`.

- [ ] **Step 1: Write the migration**

Create `src/kernel/state/migrations/014_outcome_ledger.ts`:

```typescript
import type { Migration } from "./runner.js";

// Backs the Outcome Ledger (see
// docs/superpowers/specs/2026-08-21-outcome-ledger-design.md), Phase 2 of
// the Verified Autonomy roadmap (docs/architecture/AUTONOMY_VISION.md).
// Logs every tool call executeTool() handles; command_proposals already
// has its own full lifecycle for shell commands and is deliberately left
// alone rather than folded into this table.
const migration: Migration = {
  id: "014_outcome_ledger",
  description:
    "Create outcome_ledger (one row per tool call executeTool() handles, flagged needs_follow_up for a curated 'consequential' subset) so Jarvis's actions outside the command-proposal path can be verified and their success rate fed into the confidence calculation.",
  up: async (client) => {
    await client.query(`
      CREATE TABLE outcome_ledger (
        id SERIAL PRIMARY KEY,
        username TEXT NOT NULL,
        action_name TEXT NOT NULL,
        action_summary TEXT,
        executed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        execution_ok BOOLEAN NOT NULL,
        needs_follow_up BOOLEAN NOT NULL,
        outcome TEXT,
        outcome_recorded_at TIMESTAMPTZ
      );
    `);
    await client.query(`CREATE INDEX outcome_ledger_username_idx ON outcome_ledger(username);`);
    await client.query(`
      CREATE INDEX outcome_ledger_pending_idx ON outcome_ledger(username, action_name)
        WHERE needs_follow_up AND outcome IS NULL;
    `);
  },
};

export default migration;
```

- [ ] **Step 2: Register the migration**

In `src/kernel/state/migrations/index.ts`, add the import and append to the array:

```typescript
import m014 from "./014_outcome_ledger.js";
```

(add this line directly after the existing `import m013 from "./013_webauthn_credentials.js";` line)

```typescript
export const ALL_MIGRATIONS = [m001, m002, m003, m004, m005, m006, m007, m008, m009, m010, m011, m012, m013, m014];
```

(replace the existing `export const ALL_MIGRATIONS = [...]` line with this one, which just appends `m014`)

- [ ] **Step 3: Write the repo module**

Create `src/kernel/state/outcome-ledger-repo.ts`:

```typescript
import { getPool } from "./db.js";
import { ObservationPlatform } from "../observation.js";

const observation = ObservationPlatform.getInstance();

// Actions that mutate something outside Jarvis's own head — where being
// wrong costs the user something they have to notice or undo. Everything
// else still gets logged (execution_ok), just never flagged for a
// "did that work?" follow-up. propose_command/record_command_outcome are
// deliberately absent — command_proposals already has their full lifecycle;
// see docs/superpowers/specs/2026-08-21-outcome-ledger-design.md.
const CONSEQUENTIAL_ACTIONS = new Set([
  "send_email",
  "send_personal_email",
  "github_create_issue",
  "calendar_create_event",
  "write_file",
  "write_vault_note",
  "set_objective",
  "update_objective_status",
]);

export function isConsequentialAction(actionName: string): boolean {
  return CONSEQUENTIAL_ACTIONS.has(actionName);
}

// Never throws — a logging failure must never break the tool call it's
// logging. Fire-and-forget from the caller's perspective.
export async function logAction(
  username: string,
  actionName: string,
  actionSummary: string | null,
  executionOk: boolean
): Promise<void> {
  try {
    const db = getPool();
    await db.query(
      `INSERT INTO outcome_ledger (username, action_name, action_summary, execution_ok, needs_follow_up)
       VALUES ($1, $2, $3, $4, $5)`,
      [username, actionName, actionSummary, executionOk, isConsequentialAction(actionName)]
    );
  } catch (err: any) {
    observation.logTelemetry("warn", "OutcomeLedger", `logAction(${username}, ${actionName}) failed: ${err.message}`);
  }
}

// Resolves against the most recent still-open row for this (username,
// actionName) rather than an id, so the model never has to remember an
// opaque identifier across a conversation that might get compacted — "the
// most recent still-open thing of this type" survives that. A repeat call
// or the user answering twice is a safe no-op, the same guarantee
// command-proposals-repo.ts's recordCommandOutcome gives today.
export async function recordActionOutcome(
  username: string,
  actionName: string,
  outcome: "worked" | "not_worked"
): Promise<boolean> {
  try {
    const db = getPool();
    const { rowCount } = await db.query(
      `UPDATE outcome_ledger SET outcome = $1, outcome_recorded_at = now()
       WHERE id = (
         SELECT id FROM outcome_ledger
         WHERE username = $2 AND action_name = $3 AND needs_follow_up AND outcome IS NULL
         ORDER BY executed_at DESC LIMIT 1
       )`,
      [outcome, username, actionName]
    );
    return (rowCount ?? 0) > 0;
  } catch (err: any) {
    observation.logTelemetry("warn", "OutcomeLedger", `recordActionOutcome(${username}, ${actionName}, ${outcome}) failed: ${err.message}`);
    return false;
  }
}

// Returns null when zero outcomes have ever been recorded — callers must
// treat that as "no data yet," never as "0% success." Windowed to the most
// recent 20 recorded outcomes, mirroring
// command-proposals-repo.ts's getRecentOutcomeSuccessRate.
export async function getRecentActionSuccessRate(): Promise<number | null> {
  try {
    const db = getPool();
    const { rows } = await db.query(
      `SELECT outcome FROM outcome_ledger
       WHERE outcome IS NOT NULL
       ORDER BY outcome_recorded_at DESC
       LIMIT 20`
    );
    if (rows.length === 0) return null;
    const worked = rows.filter((r: { outcome: string }) => r.outcome === "worked").length;
    return worked / rows.length;
  } catch (err: any) {
    observation.logTelemetry("warn", "OutcomeLedger", `getRecentActionSuccessRate() failed: ${err.message}`);
    return null;
  }
}
```

- [ ] **Step 4: Write the tests**

Append to `tests/index.test.ts`, directly after the existing `"CommandOutcomes"` block (after line 1912, before the `// ---------- Identity (Continuity of Self) Tests ----------` comment):

```typescript
// ---------- Outcome Ledger Tests (no live Postgres in this test process) ----------
import { isConsequentialAction, logAction, recordActionOutcome, getRecentActionSuccessRate } from "../src/kernel/state/outcome-ledger-repo.js";

registerTest("OutcomeLedger", "isConsequentialAction flags the 8 curated consequential tools", () => {
  const consequential = ["send_email", "send_personal_email", "github_create_issue", "calendar_create_event", "write_file", "write_vault_note", "set_objective", "update_objective_status"];
  for (const name of consequential) {
    if (!isConsequentialAction(name)) {
      throw new Error(`OutcomeLedger: expected "${name}" to be consequential`);
    }
  }
});

registerTest("OutcomeLedger", "isConsequentialAction does not flag read-only or excluded tools", () => {
  const trivial = ["list_files", "read_file", "search_web", "get_briefing", "list_objectives", "propose_command", "record_command_outcome"];
  for (const name of trivial) {
    if (isConsequentialAction(name)) {
      throw new Error(`OutcomeLedger: expected "${name}" not to be consequential`);
    }
  }
});

registerTest("OutcomeLedger", "logAction never throws when Postgres isn't reachable", async () => {
  await logAction("test_user", "send_email", "to test@example.com", true);
  // Reaching this line without an unhandled rejection is the assertion.
});

registerTest("OutcomeLedger", "recordActionOutcome degrades cleanly when Postgres isn't reachable", async () => {
  const result = await recordActionOutcome("test_user", "send_email", "worked");
  if (result !== false) {
    throw new Error(`OutcomeLedger: expected false with no DB, got: ${result}`);
  }
});

registerTest("OutcomeLedger", "getRecentActionSuccessRate degrades cleanly when Postgres isn't reachable", async () => {
  const result = await getRecentActionSuccessRate();
  if (result !== null) {
    throw new Error(`OutcomeLedger: expected null with no DB, got: ${result}`);
  }
});
```

- [ ] **Step 5: Run the tests**

Run: `npm test 2>&1 | grep -E "OutcomeLedger|Migrations|FAIL|Total"`
Expected: the 5 new `OutcomeLedger` tests pass, and the existing `Migrations` category's `"ALL_MIGRATIONS has unique, non-empty ids..."` test still passes (confirms `m014` was registered correctly with a unique id).

- [ ] **Step 6: Commit**

```bash
git add src/kernel/state/migrations/014_outcome_ledger.ts src/kernel/state/migrations/index.ts src/kernel/state/outcome-ledger-repo.ts tests/index.test.ts
git commit -m "feat: add outcome_ledger table and repo module"
```

---

### Task 2: Wire the write path into `executeTool`

**Files:**
- Modify: `src/capabilities/tools.ts:505-769` (the `executeTool` function)
- Test: `tests/index.test.ts` (new tests in the existing top-level test area near other `executeTool` usage)

**Interfaces:**
- Consumes: `isConsequentialAction`, `logAction` from `src/kernel/state/outcome-ledger-repo.js` (Task 1).
- Produces: no new exports — `executeTool`'s exported name and signature are unchanged; its internal implementation is renamed to `executeToolInner` (not exported) and wrapped.

- [ ] **Step 1: Write the failing test**

`executeTool` is already imported in `tests/index.test.ts` at line 14 (`import { executeTool, getAllToolDeclarations, looksTrivial, looksToolShaped } from "../src/capabilities/tools.js";`). Add these two tests near the existing tool-execution tests (search the file for `registerTest("Tools"` to find that block and add these alongside it):

```typescript
registerTest("Tools", "executeTool still resolves normally for an ungated tool after the outcome-ledger write hook is added", async () => {
  const result = await executeTool("list_constraints", {}, "test_user");
  if (!result.ok) {
    throw new Error(`Tools: expected list_constraints to succeed, got: ${JSON.stringify(result)}`);
  }
});

registerTest("Tools", "executeTool still returns the unknown-tool error shape after the outcome-ledger write hook is added", async () => {
  const result = await executeTool("not_a_real_tool", {}, "test_user");
  if (result.ok || !result.error?.includes("Unknown tool")) {
    throw new Error(`Tools: expected an "Unknown tool" error, got: ${JSON.stringify(result)}`);
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test 2>&1 | grep -A2 "executeTool still resolves\|executeTool still returns"`
Expected: both PASS already (the pre-refactor `executeTool` already behaves this way) — this step is a baseline check, not a red-green cycle, since the refactor is behavior-preserving by design. Confirm both pass before continuing, so any later failure is attributable to the refactor.

- [ ] **Step 3: Rename and wrap `executeTool`**

In `src/capabilities/tools.ts`, change the function signature at line 505 from:

```typescript
export async function executeTool(
  name: string,
  args: Record<string, any>,
  username: string,
  ai: GoogleGenAI | null = null,
  localEndpoint: string | null = null,
  screenContext: { alreadyAttached: boolean; supportsRoundTrip: boolean } = { alreadyAttached: false, supportsRoundTrip: false }
): Promise<ToolCallResult> {
```

to:

```typescript
async function executeToolInner(
  name: string,
  args: Record<string, any>,
  username: string,
  ai: GoogleGenAI | null = null,
  localEndpoint: string | null = null,
  screenContext: { alreadyAttached: boolean; supportsRoundTrip: boolean } = { alreadyAttached: false, supportsRoundTrip: false }
): Promise<ToolCallResult> {
```

(only the `export async function executeTool` line changes, to `async function executeToolInner` — every other line inside the function body, from the `UNGATED_TOOLS` comment through the closing `}` at line 769, is untouched.)

Then, immediately after that closing `}` (i.e. right after what is currently line 769), add the new wrapper and a `summarize()` helper:

```typescript
// Short, per-tool-name human-readable summary of what an action did, for
// the outcome ledger's action_summary column — falls back to the tool name
// alone for tools with no natural one-line summary.
function summarizeAction(name: string, args: Record<string, any>): string {
  switch (name) {
    case "send_email":
    case "send_personal_email":
      return `to ${args.to}: "${args.subject}"`;
    case "github_create_issue":
      return `${args.owner}/${args.repo}: "${args.title}"`;
    case "calendar_create_event":
      return String(args.summary || args.title || "");
    case "write_file":
    case "write_vault_note":
      return String(args.path || args.title || "");
    case "set_objective":
      return String(args.description || "");
    case "update_objective_status":
      return `objective ${args.objectiveId} -> ${args.status}`;
    default:
      return name;
  }
}

export async function executeTool(
  name: string,
  args: Record<string, any>,
  username: string,
  ai: GoogleGenAI | null = null,
  localEndpoint: string | null = null,
  screenContext: { alreadyAttached: boolean; supportsRoundTrip: boolean } = { alreadyAttached: false, supportsRoundTrip: false }
): Promise<ToolCallResult> {
  const result = await executeToolInner(name, args, username, ai, localEndpoint, screenContext);
  await outcomeLedgerRepo.logAction(username, name, summarizeAction(name, args), result.ok);
  return result;
}
```

Add the import at the top of `src/capabilities/tools.ts`, directly after the existing `import * as commandProposalsRepo from "../kernel/state/command-proposals-repo.js";` line (line 19):

```typescript
import * as outcomeLedgerRepo from "../kernel/state/outcome-ledger-repo.js";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test 2>&1 | grep -E "Tools|FAIL|Total"`
Expected: all `Tools`-category tests pass, including the two added in Step 1, and no other category's pass count drops from its pre-Task-2 baseline.

- [ ] **Step 5: Commit**

```bash
git add src/capabilities/tools.ts tests/index.test.ts
git commit -m "feat: log every tool call to the outcome ledger"
```

---

### Task 3: `record_action_outcome` tool

**Files:**
- Modify: `src/capabilities/tools.ts` (three locations: `PERMISSION_BY_TOOL`, `TOOL_DECLARATIONS`, the `executeToolInner` switch, and the `TOOL_TRIGGER_WORDS` exclusion comment)
- Test: `tests/index.test.ts`

**Interfaces:**
- Consumes: `recordActionOutcome` from `src/kernel/state/outcome-ledger-repo.js` (Task 1); `executeTool`/`executeToolInner` from Task 2 (this task adds a new `case` inside `executeToolInner`'s existing `switch`).
- Produces: nothing new consumed by later tasks — this is the terminal tool-facing piece.

- [ ] **Step 1: Add the permission entry**

In `src/capabilities/tools.ts`, in the `PERMISSION_BY_TOOL` map, add this line directly after the existing `record_command_outcome: "system.execute",` entry (around line 89):

```typescript
  record_action_outcome: "system.execute",
```

- [ ] **Step 2: Add the tool declaration**

In `TOOL_DECLARATIONS`, add this entry directly after the existing `record_command_outcome` declaration block (the one ending around line 440, right before the `propose_mcp_server` declaration):

```typescript
  {
    name: "record_action_outcome",
    description:
      "Record whether a previously taken action (like sending an email or saving a note) actually worked, based on what the user told you. Call this only when the user has explicitly said whether it worked — never speculatively.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        actionName: { type: Type.STRING, description: "The tool name of the action being confirmed, e.g. \"send_email\" or \"write_file\"" },
        outcome: { type: Type.STRING, description: "Either \"worked\" or \"not_worked\", based on what the user said" },
      },
      required: ["actionName", "outcome"],
    },
  },
```

- [ ] **Step 3: Add the switch case**

In `executeToolInner`'s `switch` statement (still inside `src/capabilities/tools.ts`, the function renamed in Task 2), add this case directly after the existing `record_command_outcome` case (which ends around line 694, right before the `view_screen` case):

```typescript
      case "record_action_outcome": {
        if (args.outcome !== "worked" && args.outcome !== "not_worked") {
          return { name, ok: false, error: "outcome must be either \"worked\" or \"not_worked\"." };
        }
        const recorded = await outcomeLedgerRepo.recordActionOutcome(username, args.actionName, args.outcome);
        if (!recorded) {
          return { name, ok: false, error: "No matching action found awaiting an outcome for that action name." };
        }
        output = { recorded: true };
        break;
      }
```

- [ ] **Step 4: Update the trigger-words exclusion comment**

In `src/capabilities/tools.ts`, the comment above `TOOL_TRIGGER_WORDS` (around line 772-777) currently reads:

```typescript
// Keyword triggers per tool, not a single flat list — makes it obvious which
// tool a match implies. This is a hand-maintained list, deliberately not
// derived from TOOL_DECLARATIONS: several tools (e.g. propose_command,
// display_content, update_objective_status, record_command_outcome,
// confirm_build_direction) are intentionally absent because they should only
// ever be invoked as a model-driven follow-up, never routed to directly by
// keyword match. If you add a tool that SHOULD be keyword-routable, add its
// entry here too — nothing enforces the two staying in sync.
```

Change the tool list in the third line to include the new tool:

```typescript
// derived from TOOL_DECLARATIONS: several tools (e.g. propose_command,
// display_content, update_objective_status, record_command_outcome,
// record_action_outcome, confirm_build_direction) are intentionally absent
// because they should only ever be invoked as a model-driven follow-up,
```

(this is a comment-only change — `TOOL_TRIGGER_WORDS` itself gets no new entry, since `record_action_outcome` must never be keyword-routed to directly, same as `record_command_outcome`)

- [ ] **Step 5: Write the tests**

Add to `tests/index.test.ts`, alongside the two tests added in Task 2:

```typescript
registerTest("Tools", "record_action_outcome rejects an invalid outcome value", async () => {
  const result = await executeTool("record_action_outcome", { actionName: "send_email", outcome: "maybe" }, "test_user");
  if (result.ok || !result.error?.includes("must be either")) {
    throw new Error(`Tools: expected an "outcome must be..." error, got: ${JSON.stringify(result)}`);
  }
});

registerTest("Tools", "record_action_outcome reports no matching action when nothing is open (or no DB is reachable)", async () => {
  const result = await executeTool("record_action_outcome", { actionName: "send_email", outcome: "worked" }, "test_user");
  if (result.ok || !result.error?.includes("No matching action found")) {
    throw new Error(`Tools: expected a "No matching action found" error, got: ${JSON.stringify(result)}`);
  }
});
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test 2>&1 | grep -E "Tools|FAIL|Total"`
Expected: all `Tools`-category tests pass, including the two new ones.

- [ ] **Step 7: Commit**

```bash
git add src/capabilities/tools.ts tests/index.test.ts
git commit -m "feat: add record_action_outcome tool"
```

---

### Task 4: Confidence integration

**Files:**
- Create: `src/kernel/outcome-confidence.ts`
- Modify: `src/server.ts:1219-1230`
- Test: `tests/index.test.ts` (new tests near the existing `"Confidence"` category, after line ~3057)

**Interfaces:**
- Consumes: `getRecentActionSuccessRate` from `src/kernel/state/outcome-ledger-repo.js` (Task 1).
- Produces: `mergeOutcomeRates(a: number | null, b: number | null): number | null`, exported from `src/kernel/outcome-confidence.ts`. No later task consumes this.

**Important:** `src/server.ts` calls `app.listen(...)` unconditionally at module scope (no `require.main`-style guard) and registers `process.on("SIGINT"/"SIGTERM", ...)` handlers at import time — importing it from the test process would attempt to bind a real port. `mergeOutcomeRates` must live in its own standalone module for exactly this reason: it needs to be importable from `tests/index.test.ts` without ever importing `server.ts` itself.

- [ ] **Step 1: Write the failing test**

Add to `tests/index.test.ts`, directly after the existing `"Confidence"` category's last test (the `"calculateOverallConfidence returns 100 for a fully empty input"` test, ending around line 3057):

```typescript
import { mergeOutcomeRates } from "../src/kernel/outcome-confidence.js";

registerTest("Confidence", "mergeOutcomeRates returns null when neither rate has data", () => {
  const result = mergeOutcomeRates(null, null);
  if (result !== null) {
    throw new Error(`Confidence: expected null with no data, got: ${result}`);
  }
});

registerTest("Confidence", "mergeOutcomeRates uses whichever single rate is present", () => {
  if (mergeOutcomeRates(0.8, null) !== 0.8) {
    throw new Error(`Confidence: expected 0.8 with only the first rate present, got: ${mergeOutcomeRates(0.8, null)}`);
  }
  if (mergeOutcomeRates(null, 0.6) !== 0.6) {
    throw new Error(`Confidence: expected 0.6 with only the second rate present, got: ${mergeOutcomeRates(null, 0.6)}`);
  }
});

registerTest("Confidence", "mergeOutcomeRates averages both rates when both are present", () => {
  const result = mergeOutcomeRates(0.8, 0.6);
  if (result !== 0.7) {
    throw new Error(`Confidence: expected 0.7 averaging 0.8 and 0.6, got: ${result}`);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | grep -A2 "mergeOutcomeRates"`
Expected: FAIL — `src/kernel/outcome-confidence.ts` does not exist yet, so the import throws.

- [ ] **Step 3: Write the pure helper module**

Create `src/kernel/outcome-confidence.ts`:

```typescript
// Averages the command-proposal and action-ledger success rates when both
// have data, falls back to whichever one has data, and to null (meaning
// "no signal yet," per confidence.ts's calculateOverallConfidence contract)
// when neither does. Kept in its own module, separate from server.ts,
// because server.ts calls app.listen() unconditionally at import time and
// must never be imported from the test process.
export function mergeOutcomeRates(commandRate: number | null, actionRate: number | null): number | null {
  if (commandRate !== null && actionRate !== null) return (commandRate + actionRate) / 2;
  if (commandRate !== null) return commandRate;
  if (actionRate !== null) return actionRate;
  return null;
}
```

- [ ] **Step 4: Wire `mergeOutcomeRates` into `server.ts`**

In `src/server.ts`, change lines 1219-1230 from:

```typescript
    const recentOutcomeSuccessRate = await commandProposalsRepo.getRecentOutcomeSuccessRate();
    const calculatedConfidence = session.confidenceModel.calculateOverallConfidence({
      memoryConfidence: memoryHits.length > 0 ? 0.95 : 0.7,
      toolConfidence: toolSuccessRate,
      validationConfidence: success ? 1.0 : 0.4,
      // "Error" (CognitionRouter's own internal catch-all — see
      // labelForProvenance) means no backend answered at all, a genuine
      // internal failure masked as a polite apology; that's worse than
      // Simulated's crude-but-real keyword-matched answer, not equal to it.
      capabilityConfidence: succeededStep === "Error" ? 0.2 : succeededStep === "Simulated" ? 0.5 : succeededStep ? 0.9 : 0.3,
      environmentConfidence: 1.0,
      ...(recentOutcomeSuccessRate !== null ? { outcomeConfidence: recentOutcomeSuccessRate } : {})
    });
```

to:

```typescript
    const [recentCommandOutcomeSuccessRate, recentActionOutcomeSuccessRate] = await Promise.all([
      commandProposalsRepo.getRecentOutcomeSuccessRate(),
      outcomeLedgerRepo.getRecentActionSuccessRate(),
    ]);
    const recentOutcomeSuccessRate = mergeOutcomeRates(recentCommandOutcomeSuccessRate, recentActionOutcomeSuccessRate);
    const calculatedConfidence = session.confidenceModel.calculateOverallConfidence({
      memoryConfidence: memoryHits.length > 0 ? 0.95 : 0.7,
      toolConfidence: toolSuccessRate,
      validationConfidence: success ? 1.0 : 0.4,
      // "Error" (CognitionRouter's own internal catch-all — see
      // labelForProvenance) means no backend answered at all, a genuine
      // internal failure masked as a polite apology; that's worse than
      // Simulated's crude-but-real keyword-matched answer, not equal to it.
      capabilityConfidence: succeededStep === "Error" ? 0.2 : succeededStep === "Simulated" ? 0.5 : succeededStep ? 0.9 : 0.3,
      environmentConfidence: 1.0,
      ...(recentOutcomeSuccessRate !== null ? { outcomeConfidence: recentOutcomeSuccessRate } : {})
    });
```

Add the import at the top of `src/server.ts`, directly after the existing `import * as commandProposalsRepo from "./kernel/state/command-proposals-repo.js";` line (line 45):

```typescript
import * as outcomeLedgerRepo from "./kernel/state/outcome-ledger-repo.js";
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test 2>&1 | grep -E "Confidence|FAIL|Total"`
Expected: all `Confidence`-category tests pass, including the three new ones.

- [ ] **Step 6: Run the full suite**

Run: `npm test 2>&1 | tail -20`
Expected: total pass count is the pre-Task-1 baseline plus the 5 (Task 1) + 2 (Task 2) + 2 (Task 3) + 3 (Task 4) = 12 new tests, with the same pre-existing environment-only failures as before this plan (no new failures, no regressions).

- [ ] **Step 7: Commit**

```bash
git add src/kernel/outcome-confidence.ts src/server.ts tests/index.test.ts
git commit -m "feat: fold the outcome ledger's success rate into confidence scoring"
```
