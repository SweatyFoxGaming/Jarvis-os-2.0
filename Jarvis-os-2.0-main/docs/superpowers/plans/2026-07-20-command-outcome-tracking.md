# Command Outcome Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the loop on approved `command_proposals` — track whether an executed command actually helped (not just whether it exited 0), and feed that signal into `ConfidenceModel`.

**Architecture:** Add two nullable columns to `command_proposals`; two new repo functions (record an outcome, compute a rolling success rate); one new Gemini tool (`record_command_outcome`) gated by the existing `system.execute` capability; one notification fired the moment a command finishes successfully; and a new optional `outcomeConfidence` input threaded through both existing `ConfidenceModel` call sites.

**Tech Stack:** TypeScript, Express, `pg` (node-postgres), `@google/genai` function-calling, the existing `tests/index.test.ts` harness (no test framework — a hand-rolled `registerTest`/sequential-runner).

## Global Constraints

- No new capability grant. `record_command_outcome` is gated by the **existing** `system.execute` capability (same as `propose_command`) — do not add anything to `ALL_CAPABILITIES` in `src/execution/permissions.ts`.
- The outcome-recording write must be scoped `WHERE id = $2 AND status = 'executed' AND outcome IS NULL` exactly — this is the one line that prevents double-recording or recording against a command that never actually succeeded. Do not weaken it.
- Every new Postgres-touching function except none in this plan (`recordCommandOutcome` and `getRecentOutcomeSuccessRate` are both a mutate-existing-row write and a read respectively, and both must degrade to a safe value — `false` / `null` — rather than throw, matching `updateObjectiveStatus`'s established pattern from the standing-objectives feature). There is no `createObjective`-style one-shot write in this plan that's allowed to reject.
- `getRecentOutcomeSuccessRate()` must return `null` when zero outcomes have ever been recorded — never `0` or `1` — so callers can distinguish "no data yet" from a real rate. This is what keeps a cold start neutral.
- `ConfidenceModel.calculateOverallConfidence` must produce **identical output** to its current behavior for any call that omits `outcomeConfidence` (i.e., every call site's behavior is unchanged until real outcome data exists). Do not simply default a 6th input to `1.0` inside a fixed `/6` average — that changes today's scores before any real data exists. See Task 4 for the exact required change.
- Every DB-dependent test runs in `tests/index.test.ts`, which never calls `initDatabase()` — any Postgres-touching code path in that process hits a real connection failure. This is intentional; it's how "degrades cleanly" is verified without a live database.
- Match existing code style exactly: `src/data/command-proposals-repo.ts`'s existing functions for the repo layer, `src/execution/tools.ts`'s `set_objective`/`update_objective_status` cases for the tool layer.

---

### Task 1: Schema + repo functions

**Files:**
- Modify: `src/data/db.ts` (add columns to the `command_proposals` table definition, ~line 244-257)
- Modify: `src/data/command-proposals-repo.ts` (add two functions)
- Test: `tests/index.test.ts`

**Interfaces:**
- Produces: `recordCommandOutcome(id: number, outcome: "worked" | "not_worked"): Promise<boolean>` and `getRecentOutcomeSuccessRate(): Promise<number | null>`, both exported from `src/data/command-proposals-repo.ts`. Task 2's tool layer and Task 4's confidence wiring both call these by name — do not rename them.

- [ ] **Step 1: Add the two new columns to the schema**

In `src/data/db.ts`, find the `command_proposals` table definition:

```ts
    CREATE TABLE IF NOT EXISTS command_proposals (
      id SERIAL PRIMARY KEY,
      command TEXT NOT NULL,
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      requested_by TEXT NOT NULL,
      output TEXT,
      exit_code INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      approved_at TIMESTAMPTZ,
      executed_at TIMESTAMPTZ
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS command_proposals_status_idx ON command_proposals(status);`);
```

Replace it with:

```ts
    CREATE TABLE IF NOT EXISTS command_proposals (
      id SERIAL PRIMARY KEY,
      command TEXT NOT NULL,
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      requested_by TEXT NOT NULL,
      output TEXT,
      exit_code INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      approved_at TIMESTAMPTZ,
      executed_at TIMESTAMPTZ,
      outcome TEXT,
      outcome_recorded_at TIMESTAMPTZ
    );
  `);
  // command_proposals is NOT a new table (unlike objectives in Phase 2) — it
  // already exists on every live deployment, so CREATE TABLE IF NOT EXISTS
  // above is a no-op there and would never actually add these two columns.
  // These ALTER statements are what makes the migration work on an existing
  // database; they're also safe no-ops on a fresh one where the columns
  // above already declared them.
  await db.query(`ALTER TABLE command_proposals ADD COLUMN IF NOT EXISTS outcome TEXT;`);
  await db.query(`ALTER TABLE command_proposals ADD COLUMN IF NOT EXISTS outcome_recorded_at TIMESTAMPTZ;`);
  await db.query(`CREATE INDEX IF NOT EXISTS command_proposals_status_idx ON command_proposals(status);`);
  await db.query(`CREATE INDEX IF NOT EXISTS command_proposals_outcome_idx ON command_proposals(outcome_recorded_at) WHERE outcome IS NOT NULL;`);
```

The partial index only covers the rows `getRecentOutcomeSuccessRate()` will actually scan (Step 3), and costs nothing on the far larger set of rows with no outcome yet.

**This ALTER-TABLE-migration pattern is new to this codebase** — every table added before this (including Phase 2's `objectives`) was brand new, so `CREATE TABLE IF NOT EXISTS` alone was always sufficient. This is the first time a plan adds a column to a table that already exists on the live deployment; the implementer should flag if any other step in this plan makes the same mistake.

- [ ] **Step 2: Add `recordCommandOutcome` to the repo**

In `src/data/command-proposals-repo.ts`, add this function after `recordCommandResult` (the last function in the file):

```ts
// Scoped to status = 'executed' AND outcome IS NULL so this can never
// double-record (a repeated tool call or the user answering twice is a
// safe no-op) and can never attach an outcome to a command that hasn't
// actually succeeded yet.
export async function recordCommandOutcome(
  id: number,
  outcome: "worked" | "not_worked"
): Promise<boolean> {
  try {
    const db = getPool();
    const { rowCount } = await db.query(
      `UPDATE command_proposals SET outcome = $1, outcome_recorded_at = now()
       WHERE id = $2 AND status = 'executed' AND outcome IS NULL`,
      [outcome, id]
    );
    return (rowCount ?? 0) > 0;
  } catch {
    return false;
  }
}
```

- [ ] **Step 3: Add `getRecentOutcomeSuccessRate` to the repo**

Add this function directly after `recordCommandOutcome`:

```ts
// Returns null when zero outcomes have ever been recorded — callers must
// treat that as "no data yet," never as "0% success." Windowed to the most
// recent 20 recorded outcomes so one very old streak doesn't dominate the
// signal forever.
export async function getRecentOutcomeSuccessRate(): Promise<number | null> {
  try {
    const db = getPool();
    const { rows } = await db.query(
      `SELECT outcome FROM command_proposals
       WHERE outcome IS NOT NULL
       ORDER BY outcome_recorded_at DESC
       LIMIT 20`
    );
    if (rows.length === 0) return null;
    const worked = rows.filter((r: { outcome: string }) => r.outcome === "worked").length;
    return worked / rows.length;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Write the degrade-safety tests**

In `tests/index.test.ts`, find the import line for `command-proposals-repo` — there isn't one yet, since no tests exist for this repo today. Add this import near the other repo imports (e.g. next to the `objectives-repo.js` import around line 589):

```ts
import { recordCommandOutcome, getRecentOutcomeSuccessRate } from "../src/data/command-proposals-repo.js";
```

Then add a new test category at the end of the file (after the last `registerTest` call):

```ts
// ---------- Command Outcome Tracking Tests (no live Postgres in this test process) ----------

registerTest("CommandOutcomes", "recordCommandOutcome degrades cleanly when Postgres isn't reachable", async () => {
  const result = await recordCommandOutcome(999999, "worked");
  if (result !== false) {
    throw new Error(`CommandOutcomes: expected false with no DB, got: ${result}`);
  }
});

registerTest("CommandOutcomes", "getRecentOutcomeSuccessRate degrades cleanly when Postgres isn't reachable", async () => {
  const result = await getRecentOutcomeSuccessRate();
  if (result !== null) {
    throw new Error(`CommandOutcomes: expected null with no DB, got: ${result}`);
  }
});
```

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npm test`
Expected: all existing tests plus the 2 new `CommandOutcomes` tests pass.

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/data/db.ts src/data/command-proposals-repo.ts tests/index.test.ts
git commit -m "feat: add command outcome tracking to schema and repo"
```

---

### Task 2: `record_command_outcome` tool

**Files:**
- Modify: `src/execution/tools.ts`
- Test: `tests/index.test.ts`

**Interfaces:**
- Consumes: `commandProposalsRepo.recordCommandOutcome(id: number, outcome: "worked" | "not_worked"): Promise<boolean>` from Task 1 (module already imported in `tools.ts` as `commandProposalsRepo` — no new import needed).
- Produces: a new tool named `record_command_outcome`, callable via `executeTool("record_command_outcome", { commandId, outcome }, username)`.

- [ ] **Step 1: Add the permission mapping**

In `src/execution/tools.ts`, find `PERMISSION_BY_TOOL` (~line 40):

```ts
const PERMISSION_BY_TOOL: Record<string, string> = {
  github_get_repo_or_file: "github.read",
  github_create_issue: "github.issues.create",
  send_email: "email.send",
  speak_text: "tts.speak",
  decompose_plan: "executive.plan",
  calendar_list_events: "calendar.read",
  calendar_create_event: "calendar.write",
  get_briefing: "briefing.read",
  list_files: "files.read",
  read_file: "files.read",
  write_file: "files.write",
  query_knowledge_graph: "knowledge.read",
  reflect_on_self: "identity.read",
  get_news: "news.read",
  search_web: "web.search",
  queue_feature_request: "feature.propose",
  get_security_status: "security.read",
  propose_command: "system.execute",
  view_screen: "screen.view",
  set_objective: "objectives.write",
  list_objectives: "objectives.read",
  update_objective_status: "objectives.write",
};
```

Add one line so it reads:

```ts
const PERMISSION_BY_TOOL: Record<string, string> = {
  github_get_repo_or_file: "github.read",
  github_create_issue: "github.issues.create",
  send_email: "email.send",
  speak_text: "tts.speak",
  decompose_plan: "executive.plan",
  calendar_list_events: "calendar.read",
  calendar_create_event: "calendar.write",
  get_briefing: "briefing.read",
  list_files: "files.read",
  read_file: "files.read",
  write_file: "files.write",
  query_knowledge_graph: "knowledge.read",
  reflect_on_self: "identity.read",
  get_news: "news.read",
  search_web: "web.search",
  queue_feature_request: "feature.propose",
  get_security_status: "security.read",
  propose_command: "system.execute",
  view_screen: "screen.view",
  set_objective: "objectives.write",
  list_objectives: "objectives.read",
  update_objective_status: "objectives.write",
  record_command_outcome: "system.execute",
};
```

`system.execute` already exists in `ALL_CAPABILITIES` (`src/execution/permissions.ts`) — do not add a new capability. Reusing it is deliberate: this tool only closes the loop on something the user already holds a grant for.

- [ ] **Step 2: Add the tool declaration**

In `src/execution/tools.ts`, find the `propose_command` declaration inside `TOOL_DECLARATIONS`:

```ts
  {
    name: "propose_command",
    description:
      "Propose a specific shell command to run on the user's machine. This ONLY creates a proposal for the user to review in the dashboard — it never executes anything. Only call this when you have a concrete, specific command in mind and have explained to the user what it does and why; never propose a command the user hasn't discussed or wouldn't recognize.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        command: { type: Type.STRING, description: "The exact shell command to propose" },
        reason: { type: Type.STRING, description: "Why this command, in plain terms the user can judge before approving" },
      },
      required: ["command", "reason"],
    },
  },
```

Add a new declaration directly after it:

```ts
  {
    name: "propose_command",
    description:
      "Propose a specific shell command to run on the user's machine. This ONLY creates a proposal for the user to review in the dashboard — it never executes anything. Only call this when you have a concrete, specific command in mind and have explained to the user what it does and why; never propose a command the user hasn't discussed or wouldn't recognize.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        command: { type: Type.STRING, description: "The exact shell command to propose" },
        reason: { type: Type.STRING, description: "Why this command, in plain terms the user can judge before approving" },
      },
      required: ["command", "reason"],
    },
  },
  {
    name: "record_command_outcome",
    description:
      "Record whether a previously-executed command actually fixed the user's problem. Call this when the user answers a question about whether an executed command worked (e.g. after Jarvis asked \"did that fix it?\"), using the command's numeric id from the conversation. Never call this speculatively — only when the user has actually told you whether it worked.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        commandId: { type: Type.NUMBER, description: "The command proposal's numeric id, from the notification or earlier conversation" },
        outcome: { type: Type.STRING, description: "Either \"worked\" or \"not_worked\", based on what the user said" },
      },
      required: ["commandId", "outcome"],
    },
  },
```

- [ ] **Step 3: Add the `executeTool` case**

In `src/execution/tools.ts`, find the `propose_command` case inside `executeTool`:

```ts
      case "propose_command": {
        const proposed = await commandProposalsRepo.addCommandProposal(args.command, args.reason, username);
        observation.logAuditEvent(username, "command_proposed", "success", `"${args.command}" (id ${proposed.id})`);
        output = { id: proposed.id, status: proposed.status, message: "Proposed — awaiting your review and approval in the dashboard. Nothing runs until you approve it." };
        break;
      }
```

Add a new case directly after it:

```ts
      case "propose_command": {
        const proposed = await commandProposalsRepo.addCommandProposal(args.command, args.reason, username);
        observation.logAuditEvent(username, "command_proposed", "success", `"${args.command}" (id ${proposed.id})`);
        output = { id: proposed.id, status: proposed.status, message: "Proposed — awaiting your review and approval in the dashboard. Nothing runs until you approve it." };
        break;
      }
      case "record_command_outcome": {
        if (args.outcome !== "worked" && args.outcome !== "not_worked") {
          return { name, ok: false, error: "outcome must be either \"worked\" or \"not_worked\"." };
        }
        const recorded = await commandProposalsRepo.recordCommandOutcome(args.commandId, args.outcome);
        if (!recorded) {
          return { name, ok: false, error: "No matching executed command found awaiting an outcome for that id." };
        }
        output = { recorded: true };
        break;
      }
```

Do **not** add `record_command_outcome` to `TOOL_TRIGGER_WORDS` — this mirrors `update_objective_status`, which also has no entry there. Both tools are only ever reached mid-conversation after Gemini already has the relevant id in context (from a notification or an earlier `list_objectives`/proposal call), not from a fresh user-initiated request a keyword could route.

- [ ] **Step 4: Write the tool tests**

In `tests/index.test.ts`, add these tests in the `"Tools"` category, near the existing `update_objective_status` tests:

```ts
registerTest("Tools", "record_command_outcome denies calls without system.execute grant", async () => {
  const result = await executeTool("record_command_outcome", { commandId: 1, outcome: "worked" }, "ungranted_test_user");
  if (result.ok !== false || !result.error?.toLowerCase().includes("grant")) {
    throw new Error("Tools: record_command_outcome should deny a call with no capability grant");
  }
});

registerTest("Tools", "record_command_outcome rejects an invalid outcome value before touching the DB", async () => {
  const result = await executeTool("record_command_outcome", { commandId: 1, outcome: "sort of" }, "admin");
  if (result.ok !== false || !result.error?.includes("worked")) {
    throw new Error("Tools: record_command_outcome should reject an outcome value that isn't 'worked' or 'not_worked'");
  }
});

registerTest("Tools", "record_command_outcome reports a clean error for a non-existent command id", async () => {
  const result = await executeTool("record_command_outcome", { commandId: 999999, outcome: "worked" }, "admin");
  if (result.ok !== false || !result.error) {
    throw new Error("Tools: record_command_outcome should fail cleanly for a command id that doesn't exist");
  }
});
```

(`"admin"` already holds every capability, including `system.execute`, via the existing backfill — same pattern the `update_objective_status` tests already use.)

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npm test`
Expected: all existing tests plus the 3 new `Tools` tests pass.

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/execution/tools.ts tests/index.test.ts
git commit -m "feat: add record_command_outcome tool"
```

---

### Task 3: Notification wiring

**Files:**
- Modify: `src/server.ts`

**Interfaces:**
- Consumes: `commandProposalsRepo.recordCommandResult(id, output, exitCode): Promise<CommandProposal | null>` (unchanged, already returns the updated row including `status` and `command`); `scheduler.pushNotification(username: string, message: string, type?: Notification["type"]): void` (unchanged, already imported in `server.ts` as `scheduler`).

- [ ] **Step 1: Fire a notification when a command finishes successfully**

In `src/server.ts`, find the `/api/system/ingest/command-result` route:

```ts
app.post("/api/system/ingest/command-result", validateApiKey, async (req: any, res: any) => {
  if (!permissions.hasGrant(req.username, "system.execute")) {
    return res.status(403).json({ error: 'Missing capability grant "system.execute"' });
  }
  const { id, output, exitCode } = req.body;
  if (typeof id !== "number" || typeof exitCode !== "number") {
    return res.status(400).json({ error: "id (number) and exitCode (number) are required" });
  }
  try {
    const updated = await commandProposalsRepo.recordCommandResult(id, output || "", exitCode);
    if (!updated) return res.status(404).json({ error: "Command not found" });
    res.json(updated);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
```

Replace the `try` block with:

```ts
  try {
    const updated = await commandProposalsRepo.recordCommandResult(id, output || "", exitCode);
    if (!updated) return res.status(404).json({ error: "Command not found" });
    // A nonzero exit is already an unambiguous outcome signal — only a
    // successful run is actually ambiguous ("it ran, but did it help?"),
    // so only 'executed' rows get the follow-up question.
    if (updated.status === "executed") {
      scheduler.pushNotification(
        "admin",
        `Ran your command, sir: "${updated.command}". Did that fix it?`,
        "info"
      );
    }
    res.json(updated);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
```

This route only ever operates on the single-user `"admin"` account today (there's no multi-tenant `command_proposals.requested_by`-scoped routing anywhere else in this codebase either) — matching every other scheduler-originated notification in `server.ts`/`scheduler.ts`.

- [ ] **Step 2: Search for any other caller of `recordCommandResult`**

Run: `grep -rn "recordCommandResult" src/` and confirm the only call site is the one just modified. If a second call site exists that this plan didn't anticipate, apply the same `if (updated.status === "executed")` notification there too, and note the extra fix in your report.

- [ ] **Step 3: Run the full suite and typecheck**

Run: `npm test`
Expected: all existing tests still pass (this change has no dedicated new test — `pushNotification`'s side effect isn't exercisable without a running server and a live DB-backed command row, and this codebase's established convention, set by the standing-objectives feature's own scheduler-wiring task, is that a small, clearly-reasoned notification-side-effect addition is verified by the existing suite staying green plus typecheck, not a new test written just to exist).

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/server.ts
git commit -m "feat: notify when an approved command finishes, asking if it worked"
```

---

### Task 4: Confidence model wiring

**Files:**
- Modify: `src/cognition/kernel/confidence.ts`
- Modify: `src/server.ts` (the `/api/chat` handler's confidence call site, ~line 1065)
- Modify: `src/execution/autonomous_executive.ts` (~line 181)
- Test: `tests/index.test.ts`

**Interfaces:**
- Consumes: `commandProposalsRepo.getRecentOutcomeSuccessRate(): Promise<number | null>` from Task 1.
- Produces: `ConfidenceModel.calculateOverallConfidence` gains an `outcomeConfidence` input. Its behavior when `outcomeConfidence` is omitted must be byte-for-byte identical to today's behavior for both existing call sites — see Step 1 for why a naive fixed-divisor change is wrong.

- [ ] **Step 1: Rewrite `ConfidenceModel` to average only over provided inputs**

Read `src/cognition/kernel/confidence.ts` — it currently is:

```ts
export interface ConfidenceInputs {
  memoryConfidence: number;      // 0 - 1.0
  toolConfidence: number;        // 0 - 1.0
  validationConfidence: number;  // 0 - 1.0
  capabilityConfidence: number;  // 0 - 1.0
  environmentConfidence: number; // 0 - 1.0
}

export class ConfidenceModel {
  public calculateOverallConfidence(inputs: Partial<ConfidenceInputs>): number {
    const memory = inputs.memoryConfidence ?? 1.0;
    const tool = inputs.toolConfidence ?? 1.0;
    const validation = inputs.validationConfidence ?? 1.0;
    const capability = inputs.capabilityConfidence ?? 1.0;
    const environment = inputs.environmentConfidence ?? 1.0;

    const avg = (memory + tool + validation + capability + environment) / 5;
    return Math.round(avg * 100);
  }
}
```

Replace the whole file with:

```ts
export interface ConfidenceInputs {
  memoryConfidence: number;      // 0 - 1.0
  toolConfidence: number;        // 0 - 1.0
  validationConfidence: number;  // 0 - 1.0
  capabilityConfidence: number;  // 0 - 1.0
  environmentConfidence: number; // 0 - 1.0
  outcomeConfidence: number;     // 0 - 1.0 — rolling real-world success rate; omit entirely when no outcome data exists yet
}

export class ConfidenceModel {
  // Averages only over inputs the caller actually provided. A naive fixed
  // divisor (e.g. always /6 with a default of 1.0 for a missing input)
  // would shift every existing call site's score the moment this field was
  // added, even before any real outcome data exists — omitting a field
  // from the average entirely, not defaulting it to neutral within a fixed
  // divisor, is what keeps a cold start byte-for-byte identical to today.
  public calculateOverallConfidence(inputs: Partial<ConfidenceInputs>): number {
    const provided = Object.values(inputs).filter((v): v is number => v !== undefined);
    if (provided.length === 0) return 100;
    const avg = provided.reduce((sum, v) => sum + v, 0) / provided.length;
    return Math.round(avg * 100);
  }
}
```

- [ ] **Step 2: Wire the new input into the `/api/chat` call site**

In `src/server.ts`, find:

```ts
    const calculatedConfidence = session.confidenceModel.calculateOverallConfidence({
      memoryConfidence: memoryHits.length > 0 ? 0.95 : 0.7,
      toolConfidence: toolSuccessRate,
      validationConfidence: success ? 1.0 : 0.4,
      capabilityConfidence: succeededStep === "Simulated" ? 0.5 : succeededStep ? 0.9 : 0.3,
      environmentConfidence: 1.0
    });
```

Replace it with:

```ts
    const recentOutcomeSuccessRate = await commandProposalsRepo.getRecentOutcomeSuccessRate();
    const calculatedConfidence = session.confidenceModel.calculateOverallConfidence({
      memoryConfidence: memoryHits.length > 0 ? 0.95 : 0.7,
      toolConfidence: toolSuccessRate,
      validationConfidence: success ? 1.0 : 0.4,
      capabilityConfidence: succeededStep === "Simulated" ? 0.5 : succeededStep ? 0.9 : 0.3,
      environmentConfidence: 1.0,
      ...(recentOutcomeSuccessRate !== null ? { outcomeConfidence: recentOutcomeSuccessRate } : {})
    });
```

`commandProposalsRepo` is already imported in `src/server.ts` (used by the existing command-proposal routes) — no new import needed.

- [ ] **Step 3: Wire the new input into the autonomous-executive call site**

In `src/execution/autonomous_executive.ts`, find:

```ts
    const calculatedConfidence = session.confidenceModel.calculateOverallConfidence({
      memoryConfidence: 1.0,
      toolConfidence: 1.0,
      validationConfidence: 1.0,
      capabilityConfidence: 1.0,
      environmentConfidence: 1.0
    });
```

Replace it with:

```ts
    const recentOutcomeSuccessRate = await commandProposalsRepo.getRecentOutcomeSuccessRate();
    const calculatedConfidence = session.confidenceModel.calculateOverallConfidence({
      memoryConfidence: 1.0,
      toolConfidence: 1.0,
      validationConfidence: 1.0,
      capabilityConfidence: 1.0,
      environmentConfidence: 1.0,
      ...(recentOutcomeSuccessRate !== null ? { outcomeConfidence: recentOutcomeSuccessRate } : {})
    });
```

Add the import at the top of `src/execution/autonomous_executive.ts` (it isn't imported there yet):

```ts
import * as commandProposalsRepo from "../data/command-proposals-repo.js";
```

- [ ] **Step 4: Search for any other caller of `calculateOverallConfidence`**

Run: `grep -rn "calculateOverallConfidence" src/` and confirm exactly these two call sites (`server.ts` and `autonomous_executive.ts`) plus the method definition itself. If a third call site exists that this plan didn't anticipate, wire it the same way and note the extra fix in your report.

- [ ] **Step 5: Write the `ConfidenceModel` unit tests**

`ConfidenceModel` is pure (no I/O), so these tests need no DB and no `executeTool` plumbing. In `tests/index.test.ts`, add this import near the other cognition imports at the top of the file:

```ts
import { ConfidenceModel } from "../src/cognition/kernel/confidence.js";
```

Then add a new test category at the end of the file:

```ts
// ---------- ConfidenceModel Tests (pure, no DB) ----------

registerTest("Confidence", "calculateOverallConfidence matches today's 5-input average when outcomeConfidence is omitted", () => {
  const model = new ConfidenceModel();
  const result = model.calculateOverallConfidence({
    memoryConfidence: 0.8,
    toolConfidence: 1.0,
    validationConfidence: 1.0,
    capabilityConfidence: 0.9,
    environmentConfidence: 1.0
  });
  const expected = Math.round(((0.8 + 1.0 + 1.0 + 0.9 + 1.0) / 5) * 100);
  if (result !== expected) {
    throw new Error(`Confidence: expected ${expected} with outcomeConfidence omitted, got ${result}`);
  }
});

registerTest("Confidence", "calculateOverallConfidence factors outcomeConfidence in when provided", () => {
  const model = new ConfidenceModel();
  const result = model.calculateOverallConfidence({
    memoryConfidence: 0.8,
    toolConfidence: 1.0,
    validationConfidence: 1.0,
    capabilityConfidence: 0.9,
    environmentConfidence: 1.0,
    outcomeConfidence: 0.5
  });
  const expected = Math.round(((0.8 + 1.0 + 1.0 + 0.9 + 1.0 + 0.5) / 6) * 100);
  if (result !== expected) {
    throw new Error(`Confidence: expected ${expected} with outcomeConfidence 0.5, got ${result}`);
  }
});

registerTest("Confidence", "calculateOverallConfidence returns 100 for a fully empty input", () => {
  const model = new ConfidenceModel();
  const result = model.calculateOverallConfidence({});
  if (result !== 100) {
    throw new Error(`Confidence: expected 100 for an empty input, got ${result}`);
  }
});
```

- [ ] **Step 6: Run the full suite and typecheck**

Run: `npm test`
Expected: all existing tests plus the 3 new `Confidence` tests pass.

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/cognition/kernel/confidence.ts src/server.ts src/execution/autonomous_executive.ts tests/index.test.ts
git commit -m "feat: wire command outcomes into ConfidenceModel"
```
