# Self-Health Watchdog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Jarvis periodically checks its own operational health (core dependencies reachable, companion processes running current code) and proactively notifies a human when something's wrong, closing the exact gap that let two real incidents this session go unnoticed until a human happened to look.

**Architecture:** One new scheduled job (`self-health-check`) using the existing `scheduler.registerJob` pattern, reusing `pingDatabase()`/`observation.getHealth()` directly (no route-handler refactor needed — they're already plain importable functions), two new direct reachability checks (voice-daemon socket, llama-cpp HTTP), and a git-SHA staleness comparison against the EWW HUD bridge (requires a small `scripts/deploy-hud.sh` change to stamp a version file, and a small `eww-bridge.ts` change to report it).

**Tech Stack:** TypeScript, Node's `net`/`http` built-ins for reachability checks, `child_process.execSync`/`execFileSync` for `git rev-parse HEAD`, bash for the deploy-script change.

## Global Constraints

- No Docker-socket access is added to the `api` container. `jarvis-builder` remains the sole Docker-socket holder in the stack — this is a deliberate, existing security boundary, not an oversight to "fix."
- Every degraded-check notification must name the SPECIFIC thing that's wrong (which dependency, which process, what SHA mismatch) — never a generic "something's wrong, check logs."
- Cooldown-gate notifications per check-type so a persistent outage doesn't spam a notification every 10 minutes.
- System-level notifications use the literal username `"admin"` — this is the established real convention (`startBriefingJob` already does `pushNotification("admin", ...)`), not a new pattern to invent.
- This watchdog only notifies; it never takes corrective action itself (restarting a service, etc.) — matches every other proactive job in this codebase and the human-approval-before-action philosophy already documented in `src/self/constraints.ts`.
- Electron staleness detection is explicitly out of scope for this plan (different failure mode than the EWW bridge, not a proven problem).

---

## Task 1: `src/self/health-watchdog.ts` — the pure health-check logic

**Files:**
- Create: `src/self/health-watchdog.ts`
- Test: `tests/index.test.ts`

**Interfaces:**
- Consumes: `pingDatabase` (`src/kernel/state/db.js`, real signature `(): Promise<boolean>`), `observation.getHealth()` (`src/kernel/observation.js`, returns `{status: "green"|..., ...}` — read the real shape before using it), `net`/`http` built-ins.
- Produces: `export interface HealthWatchdogDeps { pingDatabase: typeof pingDatabase; getHealth: typeof observation.getHealth; checkSocketReachable(path: string): Promise<boolean>; checkHttpReachable(url: string): Promise<boolean>; }`, `export async function assessSystemHealth(deps?: HealthWatchdogDeps): Promise<{ ok: boolean; problems: string[] }>` — following this codebase's established DI pattern (matches `src/self/wellbeing.ts`'s `WellbeingDeps`/`defaultDeps` shape exactly — read that file first as your template).

- [ ] **Step 1: Read `src/self/wellbeing.ts` completely** — this is your structural template for the DI pattern, the cooldown-gating shape, and the file's overall size/style. Match its conventions.

- [ ] **Step 2: Read the real `pingDatabase` and `observation.getHealth()` implementations completely** (`src/kernel/state/db.ts`, `src/kernel/observation.ts`) to confirm their exact real signatures and return shapes — do not assume from this brief's prose description.

- [ ] **Step 3: Write the failing tests**

```typescript
// category: "HealthWatchdog"
registerTest("HealthWatchdog", "assessSystemHealth reports ok when every dependency is reachable", async () => {
  const { assessSystemHealth } = await import("../src/self/health-watchdog.js");
  const deps = {
    pingDatabase: async () => true,
    getHealth: () => ({ status: "green" } as any),
    checkSocketReachable: async () => true,
    checkHttpReachable: async () => true,
  };
  const result = await assessSystemHealth(deps);
  if (!result.ok || result.problems.length !== 0) {
    throw new Error(`HealthWatchdog: expected ok with no problems, got: ${JSON.stringify(result)}`);
  }
});

registerTest("HealthWatchdog", "assessSystemHealth reports the specific problem when Postgres is unreachable", async () => {
  const { assessSystemHealth } = await import("../src/self/health-watchdog.js");
  const deps = {
    pingDatabase: async () => false,
    getHealth: () => ({ status: "green" } as any),
    checkSocketReachable: async () => true,
    checkHttpReachable: async () => true,
  };
  const result = await assessSystemHealth(deps);
  if (result.ok || !result.problems.some(p => /postgres/i.test(p))) {
    throw new Error(`HealthWatchdog: expected a specific Postgres problem, got: ${JSON.stringify(result)}`);
  }
});

registerTest("HealthWatchdog", "assessSystemHealth reports the specific problem when the voice daemon is unreachable", async () => {
  const { assessSystemHealth } = await import("../src/self/health-watchdog.js");
  const deps = {
    pingDatabase: async () => true,
    getHealth: () => ({ status: "green" } as any),
    checkSocketReachable: async () => false,
    checkHttpReachable: async () => true,
  };
  const result = await assessSystemHealth(deps);
  if (result.ok || !result.problems.some(p => /voice.daemon/i.test(p))) {
    throw new Error(`HealthWatchdog: expected a specific voice-daemon problem, got: ${JSON.stringify(result)}`);
  }
});

registerTest("HealthWatchdog", "assessSystemHealth reports the specific problem when llama-cpp is unreachable", async () => {
  const { assessSystemHealth } = await import("../src/self/health-watchdog.js");
  const deps = {
    pingDatabase: async () => true,
    getHealth: () => ({ status: "green" } as any),
    checkSocketReachable: async () => true,
    checkHttpReachable: async () => false,
  };
  const result = await assessSystemHealth(deps);
  if (result.ok || !result.problems.some(p => /llama/i.test(p))) {
    throw new Error(`HealthWatchdog: expected a specific llama-cpp problem, got: ${JSON.stringify(result)}`);
  }
});

registerTest("HealthWatchdog", "assessSystemHealth reports multiple problems together, not just the first", async () => {
  const { assessSystemHealth } = await import("../src/self/health-watchdog.js");
  const deps = {
    pingDatabase: async () => false,
    getHealth: () => ({ status: "green" } as any),
    checkSocketReachable: async () => false,
    checkHttpReachable: async () => true,
  };
  const result = await assessSystemHealth(deps);
  if (result.ok || result.problems.length < 2) {
    throw new Error(`HealthWatchdog: expected multiple distinct problems, got: ${JSON.stringify(result)}`);
  }
});

registerTest("HealthWatchdog", "assessSystemHealth never throws — a dependency check that itself throws degrades to a reported problem", async () => {
  const { assessSystemHealth } = await import("../src/self/health-watchdog.js");
  const deps = {
    pingDatabase: async () => { throw new Error("simulated failure"); },
    getHealth: () => ({ status: "green" } as any),
    checkSocketReachable: async () => true,
    checkHttpReachable: async () => true,
  };
  const result = await assessSystemHealth(deps);
  if (result.ok || result.problems.length === 0) {
    throw new Error("HealthWatchdog: expected a reported problem from a throwing dependency check, not a thrown exception escaping assessSystemHealth");
  }
});
```

- [ ] **Step 4: Run tests to verify they fail**

Export the standard env vars. Run `npx tsx --env-file=.env tests/index.test.ts`.
Expected: fails — `health-watchdog.ts` doesn't exist yet.

- [ ] **Step 5: Implement `src/self/health-watchdog.ts`**

```typescript
import * as net from "net";
import { pingDatabase } from "../kernel/state/db.js";
import { ObservationPlatform } from "../kernel/observation.js";

const observation = ObservationPlatform.getInstance();

// Real, honest checks -- these mirror what /health already does for
// Postgres (pingDatabase, bounded to 5s internally) plus two new direct
// reachability checks for the voice daemon and llama-cpp, following the
// same "connect and confirm, don't shell out" style. No Docker-socket
// access is used or needed -- see this plan's Global Constraints for why.

const SOCKET_CHECK_TIMEOUT_MS = 3000;
const HTTP_CHECK_TIMEOUT_MS = 3000;

export function checkSocketReachable(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ path });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, SOCKET_CHECK_TIMEOUT_MS);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

export async function checkHttpReachable(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_CHECK_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return res.ok || res.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export interface HealthWatchdogDeps {
  pingDatabase: typeof pingDatabase;
  getHealth: () => { status: string };
  checkSocketReachable: typeof checkSocketReachable;
  checkHttpReachable: typeof checkHttpReachable;
}

const defaultDeps: HealthWatchdogDeps = {
  pingDatabase,
  getHealth: () => observation.getHealth(),
  checkSocketReachable,
  checkHttpReachable,
};

export async function assessSystemHealth(
  deps: HealthWatchdogDeps = defaultDeps
): Promise<{ ok: boolean; problems: string[] }> {
  const problems: string[] = [];

  try {
    const dbOk = await deps.pingDatabase();
    if (!dbOk) problems.push("Postgres is unreachable.");
  } catch (err: any) {
    problems.push(`Postgres health check itself failed: ${err.message}`);
  }

  try {
    const voiceSocketPath = process.env.VOICE_DAEMON_SOCKET || "/tmp/jarvis-voice/voice.sock";
    const voiceOk = await deps.checkSocketReachable(voiceSocketPath);
    if (!voiceOk) problems.push(`Voice daemon is unreachable at ${voiceSocketPath}.`);
  } catch (err: any) {
    problems.push(`Voice daemon health check itself failed: ${err.message}`);
  }

  try {
    const llamaEndpoint = process.env.LOCAL_LLM_ENDPOINT || "";
    if (llamaEndpoint) {
      const llamaOk = await deps.checkHttpReachable(llamaEndpoint);
      if (!llamaOk) problems.push(`llama-cpp is unreachable at ${llamaEndpoint}.`);
    }
  } catch (err: any) {
    problems.push(`llama-cpp health check itself failed: ${err.message}`);
  }

  return { ok: problems.length === 0, problems };
}
```

**IMPORTANT — real value verification required, not copy-paste:** the brief's `LOCAL_LLM_ENDPOINT` env var name and default is a GUESS based on partial research (`kernel.localLlmEndpoint` was traced to a `MindKernel` singleton property, not directly to a specific env var name). Before finalizing this file, grep `src/kernel/` for `MindKernel`'s real definition and confirm the REAL source of `localLlmEndpoint` (env var name, or a default persisted-settings value, or both) — adjust the code above to read from the real source, not the guessed env var name. Document what you found in your report.

- [ ] **Step 6: Run tests to verify they pass**

Export the standard env vars. Run `npx tsx --env-file=.env tests/index.test.ts`.

- [ ] **Step 7: Commit**

```bash
git add src/self/health-watchdog.ts tests/index.test.ts
git commit -m "feat: add assessSystemHealth, real dependency-reachability checks"
```

---

## Task 2: Wire the job into `scheduler.ts` and `server.ts`

**Files:**
- Modify: `src/kernel/scheduler.ts`
- Modify: `src/server.ts`
- Test: `tests/index.test.ts`

**Interfaces:**
- Consumes: `assessSystemHealth` (Task 1).
- Produces: `export function startSelfHealthCheckJob(intervalMs = 10 * 60 * 1000): NodeJS.Timeout`.

- [ ] **Step 1: Read `startWellbeingCheckJob` and `startMcpHealthCheckJob` in `src/kernel/scheduler.ts` completely** — these are your two closest real templates: wellbeing for the cooldown-gating shape, mcp-health-check for the "poll something about my own operational state on a timer" shape. Also read `pushNotification`'s real signature.

- [ ] **Step 2: Implement the cooldown-gated job**

Follow `startWellbeingCheckJob`'s real structure. Key difference from wellbeing: this is system-wide (one check, not per-user), so don't loop over `usersRepo.listUsernames()` — call `assessSystemHealth()` once per tick, notify `"admin"` (matching `startBriefingJob`'s real established convention for system-level notifications — confirmed real, not invented).

Cooldown requirement: do NOT re-notify about the exact same still-open problem set more than once per hour. Track this with a simple in-memory "last notified problems + timestamp" comparison (a `Set<string>` of the last-notified problem strings plus a timestamp, compared each tick — if the CURRENT problem set is a subset of what was already notified within the cooldown window, skip notifying; if a genuinely NEW problem appears even within the cooldown window, notify about it). Keep this simple — an exact-match "did the problem set change" check plus a time-based cooldown is sufficient, don't over-engineer a diffing algorithm.

```typescript
export function startSelfHealthCheckJob(intervalMs = 10 * 60 * 1000): NodeJS.Timeout {
  let lastNotifiedProblems: string[] = [];
  let lastNotifiedAt = 0;
  const NOTIFY_COOLDOWN_MS = 60 * 60 * 1000;

  return registerJob("self-health-check", intervalMs, async () => {
    const { ok, problems } = await assessSystemHealth();
    if (ok) {
      lastNotifiedProblems = [];
      return;
    }

    const sameAsLastNotified =
      problems.length === lastNotifiedProblems.length &&
      problems.every(p => lastNotifiedProblems.includes(p));
    const withinCooldown = Date.now() - lastNotifiedAt < NOTIFY_COOLDOWN_MS;

    if (sameAsLastNotified && withinCooldown) return;

    const message = `Self-health check found ${problems.length} problem(s):\n${problems.map(p => `- ${p}`).join("\n")}`;
    pushNotification("admin", message, "warning");
    lastNotifiedProblems = problems;
    lastNotifiedAt = Date.now();
  });
}
```

- [ ] **Step 3: Wire it into `server.ts`'s startup sequence**

Find where `scheduler.startWellbeingCheckJob()`/`scheduler.startMcpHealthCheckJob()` (or equivalent) are called at startup (grep for one of them) and add `scheduler.startSelfHealthCheckJob();` alongside them, matching the exact same call style.

- [ ] **Step 4: Write a test for the cooldown logic**

Since `startSelfHealthCheckJob` returns a real `NodeJS.Timeout` and the cooldown state lives in a closure, test the cooldown behavior by injecting a short `intervalMs`, mocking `assessSystemHealth`'s underlying deps (or, simpler: temporarily replace the module-level health assessment by testing the observable side effect — check how `tests/index.test.ts` tests other timer-driven jobs like the existing `wellbeing-check`/`mcp-health-check` tests for the established real pattern for testing a `registerJob`-based function, and match it). At minimum: assert two consecutive degraded ticks with the SAME problem set within the cooldown window produce only ONE `pushNotification` call, and a tick with a genuinely different problem set produces a second call even within the cooldown window.

- [ ] **Step 5: Run tests, typecheck**

Export the standard env vars. Run `npx tsc --noEmit && npx tsx --env-file=.env tests/index.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add src/kernel/scheduler.ts src/server.ts tests/index.test.ts
git commit -m "feat: wire the self-health-check job into the scheduler and startup"
```

---

## Task 3: Companion-process staleness detection (deploy-hud.sh + eww-bridge.ts)

**Files:**
- Modify: `scripts/deploy-hud.sh`
- Modify: `src/ipc/eww-bridge.ts`
- Modify: `src/self/health-watchdog.ts` (add the staleness check)
- Modify: `src/kernel/scheduler.ts` (wire the new check into the job)
- Test: `tests/index.test.ts`

**Interfaces:**
- Produces: a `~/jarvis-hud/VERSION` file (plain text, one git SHA) written by `deploy-hud.sh` at deploy time; `eww-bridge.ts` reads it at its own startup and reports it; `checkCompanionStaleness(reportedSha: string | null, realSha: string): { stale: boolean; reason: string }` (or similar — design the exact real interface once you see how `eww-bridge.ts` actually reports its status, described below).

- [ ] **Step 1: Read `scripts/deploy-hud.sh` and `src/ipc/eww-bridge.ts` completely.**

- [ ] **Step 2: Decide how the bridge reports its SHA to the api server**

`eww-bridge.ts` already connects to `/ws/events` (or falls back to polling — check the real current behavior). Two real options, pick based on what you find:
(a) If the bridge already sends any kind of periodic message/heartbeat over its existing connection, add the SHA to that payload.
(b) If it doesn't, add a small new one-off mechanism — e.g. the bridge does a single `fetch('http://<api-host>/api/hud/report-version', {method: 'POST', body: JSON.stringify({sha})})` on its own startup (and maybe on a slow periodic re-report, e.g. hourly, so a long-running bridge process doesn't just report once at boot and never confirm it's still alive) to a new small route you add to `src/interaction/routes/` (or wherever `/api/hud/*` routes already live — check for an existing `hud-routes.ts` file, this session's earlier research found one).

Store the last-reported SHA + timestamp somewhere the health-watchdog job can read it (in-memory on the api server is fine — if the api process restarts, the bridge's next periodic re-report will repopulate it within a bounded time; document this limitation rather than over-engineering persistence for it).

- [ ] **Step 3: Update `scripts/deploy-hud.sh`**

After compiling `eww-bridge.ts` (the existing `npx tsc ...` step), add:
```bash
git -C "$REPO_DIR" rev-parse HEAD > "$DEST_DIR/VERSION"
```
(adjust variable names to match the script's real existing `REPO_DIR`/`DEST_DIR` variables, confirmed in Step 1).

- [ ] **Step 4: Update `eww-bridge.ts`** to read `VERSION` (relative to its own compiled location, e.g. `path.join(__dirname, "VERSION")` or wherever it actually lands post-compile — verify against the real `deploy-hud.sh` output structure) once at startup, and report it per your Step 2 decision. Handle the file not existing (an older, pre-this-change deployment) by reporting `null`/absent rather than crashing.

- [ ] **Step 5: Add the staleness check to `health-watchdog.ts`**

```typescript
export function checkCompanionStaleness(
  reportedSha: string | null,
  reportedAt: number | null,
  realSha: string,
  now: number = Date.now()
): { stale: boolean; reason: string | null } {
  const STALE_GRACE_PERIOD_MS = 30 * 60 * 1000; // don't flag during a deploy in progress
  if (reportedSha === null || reportedAt === null) {
    return { stale: true, reason: "EWW HUD bridge has not reported a version recently -- it may not be running." };
  }
  if (now - reportedAt > STALE_GRACE_PERIOD_MS) {
    return { stale: true, reason: "EWW HUD bridge's last version report is too old -- it may have stopped running." };
  }
  if (reportedSha !== realSha) {
    return { stale: true, reason: `EWW HUD bridge is running commit ${reportedSha.slice(0, 7)}, but the current repo is at ${realSha.slice(0, 7)}.` };
  }
  return { stale: false, reason: null };
}
```

Wire this into `assessSystemHealth` — it needs the real current HEAD (`execFileSync("git", ["rev-parse", "HEAD"], {cwd: <repo-root>}).toString().trim()` — use `execFileSync`, not `execSync` with a shell string, to avoid any shell-injection surface even though the inputs here are fixed/non-user-controlled) and the last-reported bridge SHA/timestamp from wherever Step 2 stored them. Add this as a new field in `HealthWatchdogDeps` (e.g. `getCompanionReport: () => {sha: string | null, reportedAt: number | null}`, `getRealHeadSha: () => string`) so it's injectable/testable like everything else in this file.

- [ ] **Step 6: Write tests** for `checkCompanionStaleness` covering: matching SHA (not stale), mismatched SHA (stale, specific message), never-reported (stale, specific message), stale-by-age (reported long ago, stale). Also extend `assessSystemHealth`'s existing tests to confirm a companion-staleness problem shows up in the `problems` array alongside the dependency-reachability ones.

- [ ] **Step 7: Live verification**

Deploy via `bash scripts/deploy-hud.sh` from this worktree (matching the exact convention established in the ambient-orb-presence plan's Task 6/7) and confirm the `VERSION` file is genuinely written with a real SHA, and that `eww-bridge.ts` genuinely reads and reports it (check via whatever mechanism Step 2 chose — real log output, or a real curl to the new route if you added one).

- [ ] **Step 8: Run tests, typecheck, commit**

Export the standard env vars. Run `npx tsc --noEmit && npx tsx --env-file=.env tests/index.test.ts`.

```bash
git add scripts/deploy-hud.sh src/ipc/eww-bridge.ts src/self/health-watchdog.ts src/kernel/scheduler.ts tests/index.test.ts
git commit -m "feat: detect EWW HUD bridge staleness against the real repo HEAD"
```

---

## Task 4: Final verification sweep

- [ ] **Step 1: Full regression check.** `npx tsc --noEmit` and the full test suite — confirm the pass count is the prior baseline plus exactly the new tests from Tasks 1-3, no regressions.

- [ ] **Step 2: Confirm the "no Docker-socket access" constraint held.** Grep the whole diff for `docker`, `dockerode`, `/var/run/docker.sock` — should be zero hits. This is the plan's most important boundary; verify it directly, don't just assume the earlier tasks respected it.

- [ ] **Step 3: Confirm notification message quality.** Read through every real problem-message string introduced across this plan — confirm each names the SPECIFIC thing that's wrong (per the Global Constraints), not a generic phrase. Fix any that don't.

- [ ] **Step 4: Live end-to-end check if feasible.** If a local dev server can run against this worktree (check whether the Postgres-reachability issue prior plans in this session hit still applies), trigger `assessSystemHealth()` for real once and confirm it returns a real, accurate result against this environment's actual current state (voice-daemon reachable or not, llama-cpp reachable or not, Postgres reachable or not) — report exactly what you observed. If a live check isn't feasible, rely on the unit-level DI tests from Tasks 1-3, which don't require a live server.

- [ ] **Step 5: Commit any final fixes, or state plainly if nothing needed fixing.**
