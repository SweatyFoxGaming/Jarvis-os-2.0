# Standing Objectives Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Goals a user states in conversation ("help me train for a marathon by October") persist across sessions and get proactively checked in on via the existing hourly briefing job, instead of being forgotten the moment the conversation ends.

**Architecture:** A new `src/data/objectives-repo.ts` owns the `objectives` table (matching the existing `feature-requests-repo.ts` pattern exactly — plain parameterized-query CRUD, no intermediate business-logic layer, since there's none needed beyond what `briefing.ts` already does for scoring). Three new chat tools (`set_objective`, `list_objectives`, `update_objective_status`) call it directly, gated behind two new capabilities. `briefing.ts` gains a new signal type; `scheduler.ts`'s existing hourly job marks objectives as checked-in after actually notifying about them.

**Tech Stack:** TypeScript (existing `tools.ts`/`briefing.ts`/`scheduler.ts` patterns), `pg` (existing `getPool()` pattern from `src/data/db.ts`).

## Global Constraints

- Every write path must be per-user-isolated: `updateObjectiveStatus` must never let one username modify a row belonging to another (matches the project's standing security priority — see `docs/superpowers/specs/2026-07-20-standing-objectives-design.md`'s "Scope decisions" section).
- `set_objective`/`update_objective_status` are gated behind capability grants (`objectives.write`), `list_objectives` behind `objectives.read` — not left ungated. `display_content` is the one existing exception and it's ungated specifically because it has zero lasting effect, which doesn't apply here.
- `last_checked_at` is a DB column, not the existing in-memory `seenBriefingItemIds` novelty tracker in `scheduler.ts` — a container restart must not immediately re-surface every active objective (that in-memory set resets to empty on every restart, which is fine for email/GitHub but wrong here).
- No auto-expiry past `target_date`, no dashboard panel, no per-objective custom check-in cadence — all explicitly out of scope for this pass per the design spec.
- This project's test suite (`tests/index.test.ts`, run via `npm test`) never calls `initDatabase()`, so any Postgres-dependent code path in an automated test will hit a real connection failure (`getPool()` resolves the Docker-network hostname `postgres`, unreachable outside it) — every DB-dependent function must degrade to a safe return value in that case rather than throwing, matching the existing convention (see `buildIdentityContext degrades cleanly when Postgres isn't reachable` in `tests/index.test.ts`).

---

### Task 1: `objectives` table + `objectives-repo.ts`

**Files:**
- Modify: `src/data/db.ts` (`createSchema()`)
- Create: `src/data/objectives-repo.ts`
- Test: `tests/index.test.ts`

**Interfaces:**
- Produces:
  - `export interface ObjectiveRow { id: number; username: string; description: string; target_date: string | null; status: "active" | "completed" | "abandoned"; created_at: Date; updated_at: Date; last_checked_at: Date | null; }`
  - `export async function createObjective(username: string, description: string, targetDateISO: string | null): Promise<ObjectiveRow>`
  - `export async function listActiveObjectives(username: string): Promise<ObjectiveRow[]>`
  - `export async function updateObjectiveStatus(username: string, id: number, status: "completed" | "abandoned"): Promise<boolean>` — `true` if a row was actually updated, `false` if no matching active row for that username/id (wrong user, wrong id, or already resolved), or if Postgres is unreachable.
  - `export async function collectDueObjectives(username: string): Promise<ObjectiveRow[]>` — active objectives where `last_checked_at IS NULL OR last_checked_at < now() - interval '3 days'`, OR `target_date <= now() + interval '3 days'` (a looming deadline surfaces even if recently mentioned). Returns `[]` (not a throw) if Postgres is unreachable.
  - `export async function markCheckedIn(ids: number[]): Promise<void>` — no-ops silently on an empty array or a DB failure (fire-and-forget from the caller's perspective, matching how `sessionRepo.appendMessage(...).catch(() => {})` is already used elsewhere in this codebase).

- [ ] **Step 1: Add the table to `createSchema()`**

In `src/data/db.ts`, inside `createSchema()`, add this block (anywhere among the existing `await db.query(...)` calls — e.g. right after the `briefings` table):

```ts
  await db.query(`
    CREATE TABLE IF NOT EXISTS objectives (
      id SERIAL PRIMARY KEY,
      username TEXT NOT NULL,
      description TEXT NOT NULL,
      target_date DATE,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_checked_at TIMESTAMPTZ
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS objectives_username_status_idx ON objectives(username, status);`);
```

- [ ] **Step 2: Write the failing tests**

Add to `tests/index.test.ts`, in a new `"Objectives"` category (place it near the other data-layer tests, e.g. right after the `"Files"` category tests):

```ts
import { createObjective, listActiveObjectives, updateObjectiveStatus, collectDueObjectives, markCheckedIn } from "../src/data/objectives-repo.js";

// ---------- Objectives Tests (no live Postgres in this test process) ----------
registerTest("Objectives", "createObjective degrades cleanly when Postgres isn't reachable", async () => {
  try {
    await createObjective("test_user", "run a marathon", null);
    throw new Error("Objectives: expected createObjective to reject without a live Postgres connection");
  } catch (err: any) {
    if (err.message?.includes("expected createObjective to reject")) throw err;
    // Any other thrown error (connection refused/DNS failure) is the expected
    // behavior in this no-DB test process — createObjective is a genuine
    // write with no sensible fallback value, so it's allowed to reject; the
    // read-side functions below are the ones required to degrade silently.
  }
});

registerTest("Objectives", "listActiveObjectives degrades cleanly when Postgres isn't reachable", async () => {
  const result = await listActiveObjectives("test_user");
  if (!Array.isArray(result) || result.length !== 0) {
    throw new Error(`Objectives: expected an empty array with no DB, got: ${JSON.stringify(result)}`);
  }
});

registerTest("Objectives", "updateObjectiveStatus degrades cleanly when Postgres isn't reachable", async () => {
  const result = await updateObjectiveStatus("test_user", 999999, "completed");
  if (result !== false) {
    throw new Error(`Objectives: expected false with no DB, got: ${result}`);
  }
});

registerTest("Objectives", "collectDueObjectives degrades cleanly when Postgres isn't reachable", async () => {
  const result = await collectDueObjectives("test_user");
  if (!Array.isArray(result) || result.length !== 0) {
    throw new Error(`Objectives: expected an empty array with no DB, got: ${JSON.stringify(result)}`);
  }
});

registerTest("Objectives", "markCheckedIn never throws, even with no DB or an empty list", async () => {
  await markCheckedIn([]);
  await markCheckedIn([999999]);
  // Reaching this line without an unhandled rejection is the assertion.
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test 2>&1 | grep -i objectives`
Expected: an import/module-resolution error (`../src/data/objectives-repo.js` doesn't exist yet) — the whole test file fails to load, not just these 5 tests, since the import is at the top of the file.

- [ ] **Step 4: Implement `src/data/objectives-repo.ts`**

```ts
import { getPool } from "./db.js";

export interface ObjectiveRow {
  id: number;
  username: string;
  description: string;
  target_date: string | null;
  status: "active" | "completed" | "abandoned";
  created_at: Date;
  updated_at: Date;
  last_checked_at: Date | null;
}

export async function createObjective(
  username: string,
  description: string,
  targetDateISO: string | null
): Promise<ObjectiveRow> {
  const db = getPool();
  const { rows } = await db.query(
    `INSERT INTO objectives (username, description, target_date)
     VALUES ($1, $2, $3) RETURNING *`,
    [username, description, targetDateISO]
  );
  return rows[0];
}

export async function listActiveObjectives(username: string): Promise<ObjectiveRow[]> {
  try {
    const db = getPool();
    const { rows } = await db.query(
      `SELECT * FROM objectives WHERE username = $1 AND status = 'active'
       ORDER BY target_date ASC NULLS LAST, created_at ASC`,
      [username]
    );
    return rows;
  } catch {
    return [];
  }
}

export async function updateObjectiveStatus(
  username: string,
  id: number,
  status: "completed" | "abandoned"
): Promise<boolean> {
  try {
    const db = getPool();
    const { rowCount } = await db.query(
      `UPDATE objectives SET status = $1, updated_at = now()
       WHERE id = $2 AND username = $3 AND status = 'active'`,
      [status, id, username]
    );
    return (rowCount ?? 0) > 0;
  } catch {
    return false;
  }
}

export async function collectDueObjectives(username: string): Promise<ObjectiveRow[]> {
  try {
    const db = getPool();
    const { rows } = await db.query(
      `SELECT * FROM objectives
       WHERE username = $1 AND status = 'active'
         AND (
           last_checked_at IS NULL
           OR last_checked_at < now() - interval '3 days'
           OR target_date <= now() + interval '3 days'
         )
       ORDER BY target_date ASC NULLS LAST, created_at ASC`,
      [username]
    );
    return rows;
  } catch {
    return [];
  }
}

export async function markCheckedIn(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  try {
    const db = getPool();
    await db.query(`UPDATE objectives SET last_checked_at = now() WHERE id = ANY($1::int[])`, [ids]);
  } catch {
    // Best-effort — a failed check-in stamp just means this objective may
    // surface again slightly sooner than intended, never a crash.
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test 2>&1 | grep -i objectives`
Expected: all 5 new `[Category: Objectives]` lines show `✅ [PASSED]`.

- [ ] **Step 6: Run the full suite and typecheck**

Run: `npm test 2>&1 | tail -6` — expect `36 / 36 Tests Passed` (31 existing + 5 new).
Run: `npx tsc --noEmit` — expect no output.

- [ ] **Step 7: Commit**

```bash
git add src/data/db.ts src/data/objectives-repo.ts tests/index.test.ts
git commit -m "feat: add objectives table and objectives-repo.ts"
```

---

### Task 2: Tool declarations, permission gating, `executeTool` cases

**Files:**
- Modify: `src/execution/permissions.ts` (`ALL_CAPABILITIES`)
- Modify: `src/execution/tools.ts` (`PERMISSION_BY_TOOL`, `TOOL_DECLARATIONS`, `executeTool`, `TOOL_TRIGGER_WORDS`)
- Test: `tests/index.test.ts`

**Interfaces:**
- Consumes: `createObjective`, `listActiveObjectives`, `updateObjectiveStatus` from Task 1 (`src/data/objectives-repo.js`).
- Produces: no new exports — this only wires existing repo functions into the tool-calling surface.

- [ ] **Step 1: Add the two capabilities**

In `src/execution/permissions.ts`, add to `ALL_CAPABILITIES` (after `"screen.view",` and before `"system.execute",`):

```ts
  "screen.view",
  "objectives.read",
  "objectives.write",
  "system.execute",
] as const;
```

- [ ] **Step 2: Add the permission mappings**

In `src/execution/tools.ts`, add to `PERMISSION_BY_TOOL` (anywhere, e.g. right after `view_screen: "screen.view",`):

```ts
  view_screen: "screen.view",
  set_objective: "objectives.write",
  list_objectives: "objectives.read",
  update_objective_status: "objectives.write",
};
```

- [ ] **Step 3: Add the import**

In `src/execution/tools.ts`, add near the other `import * as ... from "../data/..."`-style imports:

```ts
import * as objectivesRepo from "../data/objectives-repo.js";
```

- [ ] **Step 4: Add the tool declarations**

In `src/execution/tools.ts`, add to `TOOL_DECLARATIONS` (anywhere in the array, e.g. right after the `view_screen` entry, before the closing `];`):

```ts
  {
    name: "set_objective",
    description: "Record a standing goal the user wants Jarvis to track and proactively follow up on over time (e.g. \"help me train for a marathon by October\", \"I want to get better at guitar\"). Only call this for something the user actually wants tracked across future conversations, not a one-off question.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        description: { type: Type.STRING, description: "A clear, short description of the goal" },
        targetDateISO: { type: Type.STRING, description: "Optional ISO 8601 date (YYYY-MM-DD) the user wants to hit, if they mentioned one" },
      },
      required: ["description"],
    },
  },
  {
    name: "list_objectives",
    description: "List the user's currently active standing objectives. Use this when the user asks what goals they're tracking, or before calling update_objective_status if you don't already know the objective's id from earlier in this conversation.",
    parameters: {
      type: Type.OBJECT,
      properties: {},
    },
  },
  {
    name: "update_objective_status",
    description: "Mark a standing objective as completed or abandoned. Call list_objectives first if you don't already know the objective's numeric id.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        objectiveId: { type: Type.NUMBER, description: "The objective's id, from list_objectives" },
        status: { type: Type.STRING, description: "Either \"completed\" or \"abandoned\"" },
      },
      required: ["objectiveId", "status"],
    },
  },
];
```

- [ ] **Step 5: Add the `executeTool` cases**

Add these cases to the `switch (name)` block (anywhere among the others, e.g. right after the `view_screen` case, before `default:`):

```ts
      case "set_objective":
        output = await objectivesRepo.createObjective(username, args.description, args.targetDateISO || null);
        break;
      case "list_objectives":
        output = { objectives: await objectivesRepo.listActiveObjectives(username) };
        break;
      case "update_objective_status": {
        const updated = await objectivesRepo.updateObjectiveStatus(username, args.objectiveId, args.status);
        if (!updated) {
          return { name, ok: false, error: "No matching active objective found for that id." };
        }
        output = { updated: true };
        break;
      }
```

- [ ] **Step 6: Add routing trigger words**

In `TOOL_TRIGGER_WORDS`, add (anywhere in the object):

```ts
  set_objective: ["help me", "i want to", "track this goal", "keep me accountable", "my goal is"],
  list_objectives: ["what am i tracking", "my goals", "my objectives", "what are my goals"],
```

- [ ] **Step 7: Write the failing test**

Add to `tests/index.test.ts`, in the `"Tools"` category (near the other capability-denial tests):

```ts
registerTest("Tools", "set_objective denies calls without objectives.write grant", async () => {
  const result = await executeTool("set_objective", { description: "test goal" }, "ungranted_test_user");
  if (result.ok !== false || !result.error?.toLowerCase().includes("grant")) {
    throw new Error("Tools: set_objective should deny a call with no capability grant");
  }
});

registerTest("Tools", "update_objective_status reports a clear error for a non-existent objective", async () => {
  const result = await executeTool("update_objective_status", { objectiveId: 999999, status: "completed" }, "admin");
  if (result.ok !== false || !result.error) {
    throw new Error("Tools: update_objective_status should fail cleanly for an id that doesn't exist");
  }
});
```

- [ ] **Step 8: Run tests to verify they fail, then pass**

Run: `npm test 2>&1 | grep -i "objective\|set_objective"`
Expected before implementation: fails (unknown tool / no `objectives.write` entry).
Then implement Steps 1-6 above, and run again.
Expected after: both new lines `✅ [PASSED]`, plus the 5 `[Category: Objectives]` tests from Task 1 still passing (`update_objective_status reports a clear error` now legitimately exercises the repo's no-DB-degrades-to-false path from Task 1, wrapped in the tool-layer's error message).

- [ ] **Step 9: Run the full suite and typecheck**

Run: `npm test 2>&1 | tail -6` — expect `38 / 38 Tests Passed` (36 from Task 1 + 2 new).
Run: `npx tsc --noEmit` — expect no output.

- [ ] **Step 10: Commit**

```bash
git add src/execution/permissions.ts src/execution/tools.ts tests/index.test.ts
git commit -m "feat: add set_objective/list_objectives/update_objective_status tools"
```

---

### Task 3: Briefing integration

**Files:**
- Modify: `src/execution/briefing.ts` (`PrioritizedItem`, `RawSignals`, `collectSignals`, `prioritizeSignals`, `generateBriefing`)
- Modify: `src/execution/tools.ts` (`get_briefing` case — one-line update for the new `generateBriefing` signature)
- Test: `tests/index.test.ts`

**Interfaces:**
- Consumes: `objectivesRepo.collectDueObjectives` (Task 1).
- Produces: `generateBriefing(ai, username)` — signature gains a required `username: string` second parameter. `collectSignals(username)` likewise. Task 4 (scheduler) calls `generateBriefing(ai, "admin")` and reads `result.items.filter(i => i.source === "objective")` to know which ids to mark checked-in.

- [ ] **Step 1: Extend `PrioritizedItem` and `RawSignals`**

In `src/execution/briefing.ts`:

```ts
export interface PrioritizedItem {
  id: string; // stable across runs (email UID / GitHub notification id / objective id) — lets a caller dedup against what it already notified about
  source: "email" | "github" | "objective";
  urgency: "high" | "medium" | "low";
  summary: string;
  ageHours?: number;
}
```

```ts
export interface RawSignals {
  emails: any[];
  githubNotifications: any[];
  objectives: import("../data/objectives-repo.js").ObjectiveRow[];
  emailError?: string;
  githubError?: string;
  objectivesError?: string;
}
```

- [ ] **Step 2: Add the import**

Add near the other imports in `src/execution/briefing.ts`:

```ts
import * as objectivesRepo from "../data/objectives-repo.js";
```

- [ ] **Step 3: Thread `username` through `collectSignals`**

Current:
```ts
export async function collectSignals(): Promise<RawSignals> {
  const signals: RawSignals = { emails: [], githubNotifications: [] };

  try {
    signals.emails = await emailIntegration.fetchRecentMessages(10);
  } catch (err: any) {
    signals.emailError = err.message || String(err);
  }

  try {
    signals.githubNotifications = await github.getNotifications();
  } catch (err: any) {
    signals.githubError = err.message || String(err);
  }

  return signals;
}
```

Replace with:
```ts
export async function collectSignals(username: string): Promise<RawSignals> {
  const signals: RawSignals = { emails: [], githubNotifications: [], objectives: [] };

  try {
    signals.emails = await emailIntegration.fetchRecentMessages(10);
  } catch (err: any) {
    signals.emailError = err.message || String(err);
  }

  try {
    signals.githubNotifications = await github.getNotifications();
  } catch (err: any) {
    signals.githubError = err.message || String(err);
  }

  try {
    signals.objectives = await objectivesRepo.collectDueObjectives(username);
  } catch (err: any) {
    signals.objectivesError = err.message || String(err);
  }

  return signals;
}
```

- [ ] **Step 4: Score objectives in `prioritizeSignals`**

Add this loop to `prioritizeSignals` (right after the existing GitHub `for` loop, before the `const rank = ...` line):

```ts
  const now = Date.now();
  for (const obj of signals.objectives) {
    const daysUntilDue = obj.target_date
      ? (new Date(obj.target_date).getTime() - now) / 86_400_000
      : undefined;
    const urgent = daysUntilDue !== undefined && daysUntilDue <= 3; // includes overdue (negative values)
    items.push({
      id: `objective:${obj.id}`,
      source: "objective",
      urgency: urgent ? "high" : "medium",
      summary: obj.target_date
        ? `Standing goal: "${obj.description}" (target: ${obj.target_date})`
        : `Standing goal: "${obj.description}"`,
    });
  }
```

- [ ] **Step 5: Thread `username` through `generateBriefing`**

Current:
```ts
export async function generateBriefing(ai: GoogleGenAI | null): Promise<{ text: string; itemCount: number; items: PrioritizedItem[] }> {
  const signals = await collectSignals();
  const items = prioritizeSignals(signals);
  const errors = [signals.emailError, signals.githubError].filter(Boolean) as string[];
  const text = await synthesizeBriefing(ai, items, errors);
  return { text, itemCount: items.length, items };
}
```

Replace with:
```ts
export async function generateBriefing(ai: GoogleGenAI | null, username: string): Promise<{ text: string; itemCount: number; items: PrioritizedItem[] }> {
  const signals = await collectSignals(username);
  const items = prioritizeSignals(signals);
  const errors = [signals.emailError, signals.githubError, signals.objectivesError].filter(Boolean) as string[];
  const text = await synthesizeBriefing(ai, items, errors);
  return { text, itemCount: items.length, items };
}
```

- [ ] **Step 6: Update the one other caller — the `get_briefing` tool**

In `src/execution/tools.ts`, the `get_briefing` case currently reads:
```ts
      case "get_briefing": {
        const result = await briefing.generateBriefing(briefing.getConfiguredAi());
        output = { text: result.text, itemCount: result.itemCount };
        break;
      }
```

Replace with:
```ts
      case "get_briefing": {
        const result = await briefing.generateBriefing(briefing.getConfiguredAi(), username);
        output = { text: result.text, itemCount: result.itemCount };
        break;
      }
```

(`username` is already `executeTool`'s own parameter, in scope at this point — no new import needed.)

- [ ] **Step 7: Write the failing test**

Add to `tests/index.test.ts`, in a new `"Briefing"` category (or alongside the Objectives tests):

```ts
import { prioritizeSignals } from "../src/execution/briefing.js";

registerTest("Briefing", "prioritizeSignals scores a near-due objective as high urgency", () => {
  const soon = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10); // tomorrow
  const items = prioritizeSignals({
    emails: [],
    githubNotifications: [],
    objectives: [{
      id: 1, username: "admin", description: "finish the report", target_date: soon,
      status: "active", created_at: new Date(), updated_at: new Date(), last_checked_at: null,
    }],
  });
  const obj = items.find(i => i.id === "objective:1");
  if (!obj || obj.urgency !== "high") {
    throw new Error(`Briefing: expected a near-due objective to score "high", got: ${JSON.stringify(obj)}`);
  }
});

registerTest("Briefing", "prioritizeSignals scores a distant objective as medium urgency", () => {
  const distant = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10); // 30 days out
  const items = prioritizeSignals({
    emails: [],
    githubNotifications: [],
    objectives: [{
      id: 2, username: "admin", description: "get better at guitar", target_date: distant,
      status: "active", created_at: new Date(), updated_at: new Date(), last_checked_at: null,
    }],
  });
  const obj = items.find(i => i.id === "objective:2");
  if (!obj || obj.urgency !== "medium") {
    throw new Error(`Briefing: expected a distant objective to score "medium", got: ${JSON.stringify(obj)}`);
  }
});

registerTest("Briefing", "prioritizeSignals scores an objective with no target date as medium urgency", () => {
  const items = prioritizeSignals({
    emails: [],
    githubNotifications: [],
    objectives: [{
      id: 3, username: "admin", description: "get better at guitar", target_date: null,
      status: "active", created_at: new Date(), updated_at: new Date(), last_checked_at: null,
    }],
  });
  const obj = items.find(i => i.id === "objective:3");
  if (!obj || obj.urgency !== "medium") {
    throw new Error(`Briefing: expected an undated objective to score "medium", got: ${JSON.stringify(obj)}`);
  }
});
```

- [ ] **Step 8: Run tests to verify they fail, then pass**

Run: `npm test 2>&1 | grep -i briefing`
Expected before implementation: fails (`RawSignals` has no `objectives` field yet — TypeScript compile error surfaces as a runtime import/parse failure under `tsx`).
Implement Steps 1-6, then run again.
Expected after: all 3 new `[Category: Briefing]` lines `✅ [PASSED]`.

- [ ] **Step 9: Run the full suite and typecheck**

Run: `npm test 2>&1 | tail -6` — expect `41 / 41 Tests Passed` (38 from Task 2 + 3 new).
Run: `npx tsc --noEmit` — expect no output.

- [ ] **Step 10: Commit**

```bash
git add src/execution/briefing.ts src/execution/tools.ts tests/index.test.ts
git commit -m "feat: score standing objectives as a briefing signal type"
```

---

### Task 4: Scheduler check-in wiring

**Files:**
- Modify: `src/execution/scheduler.ts` (`startBriefingJob`)

**Interfaces:**
- Consumes: `generateBriefing(ai, username)` (Task 3), `objectivesRepo.markCheckedIn(ids)` (Task 1).
- Produces: no new exports — this only adds one call to the existing job.

- [ ] **Step 1: Add the import**

In `src/execution/scheduler.ts`, add near the other imports:

```ts
import * as objectivesRepo from "../data/objectives-repo.js";
```

- [ ] **Step 2: Update the one `generateBriefing` call site and add the check-in stamp**

Current:
```ts
export function startBriefingJob(ai: GoogleGenAI | null, intervalMs = 60 * 60 * 1000): NodeJS.Timeout {
  return registerJob("proactive-briefing", intervalMs, async () => {
    const result = await briefing.generateBriefing(ai);
    try {
      await briefingRepo.saveBriefing(result.text, result.itemCount, result.items);
    } catch (err: any) {
      observation.logTelemetry("warn", "Briefing", `Failed to persist briefing: ${err.message}`);
    }

    const freshItems = result.items.filter(i => !seenBriefingItemIds.has(i.id));
    seenBriefingItemIds = new Set(result.items.map(i => i.id));

    if (freshItems.length > 0) {
      const freshText = await briefing.synthesizeBriefing(ai, freshItems, []);
      pushNotification("admin", freshText, freshItems.some(i => i.urgency === "high") ? "warning" : "info");
    }
  });
}
```

Replace with:
```ts
export function startBriefingJob(ai: GoogleGenAI | null, intervalMs = 60 * 60 * 1000): NodeJS.Timeout {
  return registerJob("proactive-briefing", intervalMs, async () => {
    const result = await briefing.generateBriefing(ai, "admin");
    try {
      await briefingRepo.saveBriefing(result.text, result.itemCount, result.items);
    } catch (err: any) {
      observation.logTelemetry("warn", "Briefing", `Failed to persist briefing: ${err.message}`);
    }

    const freshItems = result.items.filter(i => !seenBriefingItemIds.has(i.id));
    seenBriefingItemIds = new Set(result.items.map(i => i.id));

    if (freshItems.length > 0) {
      const freshText = await briefing.synthesizeBriefing(ai, freshItems, []);
      pushNotification("admin", freshText, freshItems.some(i => i.urgency === "high") ? "warning" : "info");
    }

    // Stamp last_checked_at for every objective this run actually surfaced
    // (whether or not it was "fresh" by the in-memory tracker above — an
    // objective only appears here at all because objectives-repo.ts's own
    // collectDueObjectives() already decided it was due, so every
    // appearance here is a real check-in worth recording).
    const objectiveIds = result.items
      .filter(i => i.source === "objective")
      .map(i => Number(i.id.split(":")[1]));
    await objectivesRepo.markCheckedIn(objectiveIds);
  });
}
```

- [ ] **Step 3: Run the full suite and typecheck**

Run: `npm test 2>&1 | tail -6` — expect `41 / 41 Tests Passed` (no new automated tests in this task — the job's actual timer/scheduling behavior has no automated test framework wrapping it in this codebase, matching how `startBriefingJob` itself was originally verified only manually/live).
Run: `npx tsc --noEmit` — expect no output.

- [ ] **Step 4: Manual/live verification**

This is the one part of the feature that can't be automated (matches this codebase's existing convention — see `docs/superpowers/plans/2026-07-20-always-on-desktop-presence.md`'s Global Constraints for the same reasoning applied to Electron):

1. Start a real chat conversation and say something like "help me train for a marathon by October 15th" — confirm Gemini calls `set_objective` (check server logs for `tool_call` audit entries, or just confirm the reply acknowledges tracking the goal).
2. Query Postgres directly to confirm the row exists: `docker exec jarvis-postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT id, description, target_date, status, last_checked_at FROM objectives;"`
3. Restart the `api` container (`docker compose restart api` is NOT sufficient per this project's own documented gotcha — env/code changes need `docker compose up -d`, but a plain container restart to test persistence is fine here since no code changed) and confirm the row is still there via the same query — proves `last_checked_at` durability doesn't depend on in-memory state.
4. Manually trigger the briefing job early (or wait for the real hourly interval) and confirm the objective surfaces in a real notification if its `target_date` is close, or force this by setting the row's `target_date` directly in Postgres to tomorrow and re-running: `docker exec jarvis-postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "UPDATE objectives SET target_date = CURRENT_DATE + 1 WHERE id = <id>;"`, then confirm `last_checked_at` gets stamped after the next job run.
5. Say "I finished the marathon" in conversation — confirm Gemini calls `list_objectives` then `update_objective_status`, and confirm via the same `psql` query that `status` is now `'completed'` and the objective no longer appears in a fresh `collectDueObjectives` result (i.e., stops surfacing in future briefings).

- [ ] **Step 5: Commit**

```bash
git add src/execution/scheduler.ts
git commit -m "feat: mark standing objectives checked-in after the hourly briefing surfaces them"
```

---

## Self-Review

**Spec coverage:** Task 1 covers the data model and repo functions. Task 2 covers the three chat tools, capability gating, and trigger words. Task 3 covers the briefing signal integration, urgency scoring, and the `get_briefing` call-site fix caught during the spec's own self-review. Task 4 covers the scheduler check-in stamp and the manual verification the design doc's Testing section calls for. All "Out of scope" items (auto-expiry, dashboard panel, per-objective cadence) are correctly absent from every task.

**Placeholder scan:** No TBD/TODO; every step has exact code or an exact command with expected output.

**Type consistency:** `ObjectiveRow` (Task 1) is used identically in Task 3's `RawSignals.objectives` field and in the Task 3 tests' inline objects — same field names (`target_date`, `last_checked_at`, snake_case matching the DB column names directly, no camelCase mapping layer, consistent with how the rest of this codebase's repo files return raw `rows[0]`/`rows` without a translation step). `updateObjectiveStatus`'s return type (`Promise<boolean>`, Task 1) matches exactly how Task 2's `executeTool` case checks `if (!updated)`. `markCheckedIn(ids: number[])` (Task 1) matches exactly how Task 4 constructs `objectiveIds` as `number[]` via `.map(i => Number(i.id.split(":")[1]))`.
