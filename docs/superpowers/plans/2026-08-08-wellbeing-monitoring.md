# Proactive Wellbeing Monitoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a scheduled job that notices real, evidence-grounded signs a user might be overworking or stressed (late-hour message timestamps, stress-indicating rapport tone descriptors) and pushes one honest, evidence-citing check-in — never fabricated, never repeated too often.

**Architecture:** `wellbeing-repo.ts` queries the already-real `conversation_history` table for a late-hour activity ratio and tracks per-user check-in timestamps in a new small table. `wellbeing.ts` combines that with already-recorded `rapport_signals` tone descriptors to decide whether a genuine check-in is warranted. `startWellbeingCheckJob` in `scheduler.ts` mirrors `startSelfReflectionJob`'s exact structure.

**Tech Stack:** TypeScript, Postgres (existing migration/repo pattern).

## Global Constraints

- No new LLM call is introduced by this plan — the rapport-signal half of the check reuses `rapport_signals` data that `rapport.ts` already honestly extracted; this plan only scans it with a plain keyword list, it does not add a second extraction pass.
- The late-hour heuristic is UTC-bucket based (23:00–06:00 UTC) since no per-user timezone is tracked anywhere in this codebase — this is a real, honestly-labeled limitation, not a bug to silently paper over; say so in the code comment, don't pretend precision that doesn't exist.
- A check-in message must cite the actual pattern observed (late-hour messaging, or the actual tone language recorded) — never a generic "you seem stressed" with no basis.
- `startWellbeingCheckJob` follows `startSelfReflectionJob`'s exact per-user try/catch isolation — one user's failure must never block another's, and a single job run must never throw.
- Every repo function degrades cleanly (matches every other repo in this codebase) — a Postgres failure means "no signal, don't check in," never a crash.

---

## Task 1: `wellbeing-repo.ts` — storage and activity query

**Files:**
- Create: `src/kernel/state/migrations/010_wellbeing_checkins.ts`
- Create: `src/kernel/state/wellbeing-repo.ts`
- Test: `tests/index.test.ts`

**Interfaces:**
- Consumes: `getPool` (`./db.js`), `ObservationPlatform` (existing).
- Produces:
  - `export async function getLateHourActivityRatio(username: string, days = 7): Promise<number | null>` — fraction (0-1) of this user's messages in the last `days` days that fall in the 23:00–06:00 UTC hour band. Returns `null` (not 0) when Postgres is unreachable OR there are zero messages in the window — the caller must distinguish "no data" from "genuinely zero late-hour activity."
  - `export async function getLastCheckinAt(username: string): Promise<Date | null>` — `null` if never checked in, or if Postgres is unreachable.
  - `export async function recordCheckin(username: string): Promise<void>` — upserts the current timestamp for this user; fire-and-forget, never throws.

- [ ] **Step 1: Read `session-repo.ts` and one existing simple migration completely first**

`src/kernel/state/session-repo.ts` is the real source of `conversation_history` (columns: `username`, `role`, `content`, `created_at`) — read it in full to match its query style exactly. Read the most recent existing migration for the migration-authoring convention.

- [ ] **Step 2: Write the migration**

```typescript
// src/kernel/state/migrations/010_wellbeing_checkins.ts
import type { Migration } from "./runner.js";

// Backs proactive wellbeing monitoring (see
// docs/superpowers/specs/2026-08-08-wellbeing-monitoring-design.md) — one
// row per user, tracking when they last received a wellbeing check-in, so
// a real, persistent signal doesn't produce a check-in every single day.
const migration: Migration = {
  id: "010_wellbeing_checkins",
  description:
    "Create wellbeing_checkins (one row per user, last check-in timestamp) so proactive wellbeing check-ins don't repeat too often.",
  up: async (client) => {
    await client.query(`
      CREATE TABLE wellbeing_checkins (
        username TEXT PRIMARY KEY,
        last_checkin_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
  },
};

export default migration;
```

Register it in `src/kernel/state/migrations/index.ts` following the exact same append-only pattern the most recent migration used.

- [ ] **Step 3: Write the failing tests**

Match `tests/index.test.ts`'s real `registerTest(category, name, fn)` convention.

```typescript
// category: "WellbeingRepo"
registerTest("WellbeingRepo", "getLateHourActivityRatio returns null when Postgres isn't reachable", async () => {
  const { getLateHourActivityRatio } = await import("../src/kernel/state/wellbeing-repo.js");
  const result = await getLateHourActivityRatio("test_user");
  if (result !== null) throw new Error(`expected null when Postgres is unreachable, got ${result}`);
});

registerTest("WellbeingRepo", "getLastCheckinAt returns null when Postgres isn't reachable", async () => {
  const { getLastCheckinAt } = await import("../src/kernel/state/wellbeing-repo.js");
  const result = await getLastCheckinAt("test_user");
  if (result !== null) throw new Error(`expected null when Postgres is unreachable, got ${result}`);
});

registerTest("WellbeingRepo", "recordCheckin degrades cleanly when Postgres isn't reachable", async () => {
  const { recordCheckin } = await import("../src/kernel/state/wellbeing-repo.js");
  await recordCheckin("test_user"); // must not throw
});
```

- [ ] **Step 4: Implement**

```typescript
// src/kernel/state/wellbeing-repo.ts
import { getPool } from "./db.js";
import { ObservationPlatform } from "../observation.js";

const observation = ObservationPlatform.getInstance();

// UTC-bucket heuristic, not timezone-aware — this codebase doesn't track
// per-user timezone anywhere, so "late hour" here means 23:00-06:00 UTC,
// not the user's actual local night. A real, honestly-labeled limitation,
// not a claim of precision this data doesn't support.
const LATE_HOUR_START_UTC = 23;
const LATE_HOUR_END_UTC = 6;

export async function getLateHourActivityRatio(username: string, days = 7): Promise<number | null> {
  try {
    const db = getPool();
    const { rows } = await db.query(
      `SELECT
         COUNT(*) FILTER (WHERE EXTRACT(HOUR FROM created_at) >= $2 OR EXTRACT(HOUR FROM created_at) < $3)::float AS late_count,
         COUNT(*)::float AS total_count
       FROM conversation_history
       WHERE username = $1 AND role = 'user' AND created_at > now() - ($4 * interval '1 day')`,
      [username, LATE_HOUR_START_UTC, LATE_HOUR_END_UTC, days]
    );
    const row = rows[0];
    if (!row || row.total_count === 0) return null;
    return row.late_count / row.total_count;
  } catch (err: any) {
    observation.logTelemetry("warn", "WellbeingRepo", `getLateHourActivityRatio(${username}) failed: ${err.message}`);
    return null;
  }
}

export async function getLastCheckinAt(username: string): Promise<Date | null> {
  try {
    const db = getPool();
    const { rows } = await db.query(`SELECT last_checkin_at FROM wellbeing_checkins WHERE username = $1`, [username]);
    return rows[0] ? new Date(rows[0].last_checkin_at) : null;
  } catch (err: any) {
    observation.logTelemetry("warn", "WellbeingRepo", `getLastCheckinAt(${username}) failed: ${err.message}`);
    return null;
  }
}

export async function recordCheckin(username: string): Promise<void> {
  try {
    const db = getPool();
    await db.query(
      `INSERT INTO wellbeing_checkins (username, last_checkin_at) VALUES ($1, now())
       ON CONFLICT (username) DO UPDATE SET last_checkin_at = now()`,
      [username]
    );
  } catch (err: any) {
    observation.logTelemetry("warn", "WellbeingRepo", `recordCheckin(${username}) failed: ${err.message}`);
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Export `POSTGRES_HOST=localhost POSTGRES_USER=jarvis_user POSTGRES_DB=jarvis INTERNAL_API_KEY=<real value from .env> OAUTH_TOKEN_ENCRYPTION_KEY=<real value from .env>` first. Run `npx tsc --noEmit && npm test`.

- [ ] **Step 6: Commit**

```bash
git add src/kernel/state/migrations/010_wellbeing_checkins.ts src/kernel/state/migrations/index.ts src/kernel/state/wellbeing-repo.ts tests/index.test.ts
git commit -m "feat: add wellbeing check-in storage and late-hour activity query"
```

---

## Task 2: `src/self/wellbeing.ts` — signal assessment

**Files:**
- Create: `src/self/wellbeing.ts`
- Test: `tests/index.test.ts`

**Interfaces:**
- Consumes: `getLateHourActivityRatio`/`getLastCheckinAt` (Task 1), `getRecentRapportSignals` (`src/kernel/state/rapport-repo.js`, already exists on this branch).
- Produces: `export async function assessWellbeingSignal(username: string): Promise<string | null>` — returns a real, evidence-citing check-in message, or `null` if nothing warrants one (including: no real signal, or a check-in already happened recently).

- [ ] **Step 1: Read `rapport-repo.ts`'s `RapportSignal` interface and `getRecentRapportSignals`'s real return shape first**

- [ ] **Step 2: Write the failing tests**

Use dependency injection (matching this session's established pattern, e.g. `shadow-verifier.ts`'s `execFn`) — since this function calls 3 real repo functions, give it an optional deps parameter for testability:

```typescript
// category: "Wellbeing"
registerTest("Wellbeing", "assessWellbeingSignal returns a real message for a high late-hour ratio", async () => {
  const { assessWellbeingSignal } = await import("../src/self/wellbeing.js");
  const result = await assessWellbeingSignal("test_user", {
    getLateHourActivityRatio: async () => 0.6,
    getLastCheckinAt: async () => null,
    getRecentRapportSignals: async () => [],
  });
  if (!result || !result.toLowerCase().includes("late")) {
    throw new Error(`expected a late-hour-citing message, got: ${JSON.stringify(result)}`);
  }
});

registerTest("Wellbeing", "assessWellbeingSignal returns a real message when recent rapport signals show stress language", async () => {
  const { assessWellbeingSignal } = await import("../src/self/wellbeing.js");
  const result = await assessWellbeingSignal("test_user", {
    getLateHourActivityRatio: async () => 0.1,
    getLastCheckinAt: async () => null,
    getRecentRapportSignals: async () => [
      { id: 1, username: "test_user", toneDescriptor: "overwhelmed, exhausted, terse", formalityObserved: 50, createdAt: new Date() },
    ] as any,
  });
  if (!result) throw new Error("expected a real message when recent tone shows stress language");
});

registerTest("Wellbeing", "assessWellbeingSignal returns null for normal activity patterns", async () => {
  const { assessWellbeingSignal } = await import("../src/self/wellbeing.js");
  const result = await assessWellbeingSignal("test_user", {
    getLateHourActivityRatio: async () => 0.05,
    getLastCheckinAt: async () => null,
    getRecentRapportSignals: async () => [
      { id: 1, username: "test_user", toneDescriptor: "focused, task-oriented", formalityObserved: 60, createdAt: new Date() },
    ] as any,
  });
  if (result !== null) throw new Error(`expected null for a normal pattern, got: ${JSON.stringify(result)}`);
});

registerTest("Wellbeing", "assessWellbeingSignal returns null when a check-in happened recently, even with a real signal", async () => {
  const { assessWellbeingSignal } = await import("../src/self/wellbeing.js");
  const result = await assessWellbeingSignal("test_user", {
    getLateHourActivityRatio: async () => 0.8,
    getLastCheckinAt: async () => new Date(), // just now
    getRecentRapportSignals: async () => [],
  });
  if (result !== null) throw new Error(`expected null when a check-in happened recently, got: ${JSON.stringify(result)}`);
});
```

- [ ] **Step 3: Implement**

```typescript
// src/self/wellbeing.ts
import * as wellbeingRepo from "../kernel/state/wellbeing-repo.js";
import * as rapportRepo from "../kernel/state/rapport-repo.js";

// Real, honest thresholds — not tuned against real usage data yet (there
// isn't any), a first reasonable pass: a genuinely unusual amount of
// late-hour messaging, or explicit stress language actually present in
// recently recorded rapport signals. Revisit these numbers once this has
// run against real usage.
const LATE_HOUR_RATIO_THRESHOLD = 0.3;
const MIN_DAYS_BETWEEN_CHECKINS = 3;
const STRESS_KEYWORDS = ["stressed", "overwhelmed", "exhausted", "burnt out", "burned out", "frustrated", "drained"];

export interface WellbeingDeps {
  getLateHourActivityRatio: typeof wellbeingRepo.getLateHourActivityRatio;
  getLastCheckinAt: typeof wellbeingRepo.getLastCheckinAt;
  getRecentRapportSignals: typeof rapportRepo.getRecentRapportSignals;
}

const defaultDeps: WellbeingDeps = {
  getLateHourActivityRatio: wellbeingRepo.getLateHourActivityRatio,
  getLastCheckinAt: wellbeingRepo.getLastCheckinAt,
  getRecentRapportSignals: rapportRepo.getRecentRapportSignals,
};

export async function assessWellbeingSignal(username: string, deps: WellbeingDeps = defaultDeps): Promise<string | null> {
  const lastCheckin = await deps.getLastCheckinAt(username);
  if (lastCheckin) {
    const daysSince = (Date.now() - lastCheckin.getTime()) / (1000 * 60 * 60 * 24);
    if (daysSince < MIN_DAYS_BETWEEN_CHECKINS) return null;
  }

  const lateHourRatio = await deps.getLateHourActivityRatio(username);
  if (lateHourRatio !== null && lateHourRatio >= LATE_HOUR_RATIO_THRESHOLD) {
    return "I've noticed a fair amount of your recent messages have come in late at night — no pressure to respond, just checking in, sir.";
  }

  const recentSignals = await deps.getRecentRapportSignals(username, 5);
  const stressedSignal = recentSignals.find(s =>
    STRESS_KEYWORDS.some(word => s.toneDescriptor.toLowerCase().includes(word))
  );
  if (stressedSignal) {
    return `I've noticed some of our recent conversations have had a "${stressedSignal.toneDescriptor}" tone — just checking in, sir. No need to respond if you'd rather not.`;
  }

  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Export the standard env vars. Run `npx tsc --noEmit && npm test`.

- [ ] **Step 5: Commit**

```bash
git add src/self/wellbeing.ts tests/index.test.ts
git commit -m "feat: add wellbeing signal assessment combining activity pattern and rapport tone"
```

---

## Task 3: Wire into `src/kernel/scheduler.ts` and `src/server.ts`

**Files:**
- Modify: `src/kernel/scheduler.ts`
- Modify: `src/server.ts`

**Interfaces:**
- Consumes: `assessWellbeingSignal` (Task 2), `recordCheckin` (Task 1), `usersRepo.listUsernames` (existing), `pushNotification` (existing, same file).

- [ ] **Step 1: Read `startSelfReflectionJob` in full first**

This is the exact structural template — same file, right above where you're adding the new job.

- [ ] **Step 2: Add the job**

```typescript
export function startWellbeingCheckJob(intervalMs = 24 * 60 * 60 * 1000): NodeJS.Timeout {
  return registerJob("wellbeing-check", intervalMs, async () => {
    const usernames = await usersRepo.listUsernames();
    for (const username of usernames) {
      try {
        const message = await wellbeing.assessWellbeingSignal(username);
        if (!message) continue;
        pushNotification(username, message, "info");
        await wellbeingRepo.recordCheckin(username);
      } catch (err: any) {
        observation.logTelemetry("warn", "Wellbeing", `Failed to assess/checkin for "${username}": ${err.message}`);
      }
    }
  });
}
```

with the corresponding imports (`import * as wellbeing from "../self/wellbeing.js";` and `import * as wellbeingRepo from "./state/wellbeing-repo.js";` — adjust relative paths to this file's actual location; check whether `wellbeingRepo` needs its own import or if it's cleaner to have `wellbeing.ts` itself expose a `recordCheckinAfterNotification` wrapper — use your judgment based on what's cleanest given the real import structure, but keep the actual check-in recording tied to the moment a notification was genuinely sent, not earlier).

- [ ] **Step 3: Wire into `server.ts` startup**

Find where `startSelfReflectionJob` is called at startup and add `scheduler.startWellbeingCheckJob();` alongside it.

- [ ] **Step 4: Typecheck, run tests**

Export the standard env vars. Run `npx tsc --noEmit && npm test`.

- [ ] **Step 5: Manual verification if a real dev server is available**

Start the dev server, manually insert a few late-hour rows into `conversation_history` for a test user (or manually trigger the job function directly via a script/console), confirm a real notification appears via `pushNotification`'s existing retrieval mechanism. If impractical in this sandbox, document that and rely on the automated tests.

- [ ] **Step 6: Commit**

```bash
git add src/kernel/scheduler.ts src/server.ts
git commit -m "feat: wire proactive wellbeing check-ins into the scheduler"
```

---

## Final check

- [ ] Run `npx tsc --noEmit && npm test` end to end.
- [ ] Confirm `assessWellbeingSignal` genuinely returns `null` with no real signal — the single most important behavioral guarantee, re-verify explicitly.
- [ ] Confirm the check-in message always cites the real pattern observed (late-hour ratio or actual tone descriptor text) — read a couple of generated messages and judge honestly whether they're grounded, not generic.
- [ ] Confirm `startWellbeingCheckJob` follows the exact same per-user isolation as `startSelfReflectionJob` — one user's failure can't block another's.
