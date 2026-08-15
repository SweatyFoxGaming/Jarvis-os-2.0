# Event-Driven Adaptation & Shadow Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire `src/adaptation/analyzer.ts`'s quality/architecture/security checks onto the event bus (built in the prior `feat/event-bus-voice-engine` work) so they run reactively on real source-file changes instead of only once daily, and give `jarvis-builder`'s existing ad-hoc sandbox a real trigger so a high-severity finding automatically re-verifies the codebase in isolation (`npm ci && npm test && npx tsc --noEmit`) — without touching the existing human-approval-gated build_requests pipeline.

**Architecture:** Two new event-bus participants, no new infrastructure. (1) `src/adaptation/live-analysis.ts` subscribes to `filesystem:changed`, debounces (trailing-edge, 5s — these checks run a real `tsc` compile and are far more expensive than `eww-bridge.ts`'s 250ms UI debounce), runs the four existing `analyzer.ts` functions, and publishes the aggregate result on a new `adaptation:analysis` topic. (2) `src/executive/shadow-verifier.ts` subscribes to `adaptation:analysis`; when any issue is `severity: "high"`, it calls the *already-existing* `builderClient.execInChatSandbox()` (an ad-hoc, no-DB-row, no-build_request sandbox already used by `run_sandbox_command` in tools.ts) to re-run the test suite in isolation, and publishes the pass/fail result on `builder:shadow-verified`. Both wire into `server.ts` startup the same way the filesystem watcher already does.

**Tech Stack:** TypeScript, the existing `EventBus` singleton, the existing `builder-client.ts` HTTP client to `jarvis-builder`. No new dependencies.

## Global Constraints

- This plan does NOT create, approve, or apply any code change to the running system. `shadow-verifier.ts` only reports pass/fail; it never calls `builderClient.createWorkspace`/the `build_requests` lifecycle, and never touches `coding-agent.ts` or `autonomous_executive.ts`'s human-approval gate. This is a deliberate scope boundary — read the design rationale in `src/executive/shadow-verifier.ts`'s own file-level comment once written.
- `deploy/jarvis-daily-adapt.timer`, `jarvis-backup.timer`, `jarvis-backup-check.timer` are NOT touched by this plan — their periodic cadence is correct by design (each has a code comment saying so) and this plan does not change them.
- The debounce in `live-analysis.ts` must be trailing-edge (same shape as `eww-bridge.ts`'s existing debounce: a burst of N events results in exactly one analysis run after the burst quiets, not N runs and not a reset-on-every-event timer that could starve indefinitely under continuous file activity).
- `execInChatSandbox` takes an arbitrary `username`-shaped key with no auth/session tied to a real user — use a clearly synthetic key (e.g. `"system-anomaly-verifier"`) that cannot collide with a real logged-in user's chat sandbox.
- Every new subscriber must be wired into `server.ts`'s startup sequence and cleanly unsubscribe-able on shutdown, matching the pattern already established for the filesystem watcher (`startFilesystemWatcher` returns `{stop: () => void}`).

---

### Task 1: `src/adaptation/live-analysis.ts` — debounced analyzer subscriber

**Files:**
- Create: `src/adaptation/live-analysis.ts`
- Modify: `src/server.ts` (wire into startup, alongside the existing `startFilesystemWatcher(...)` call)
- Test: `tests/index.test.ts`

**Interfaces:**
- Consumes: `EventBus.getInstance()`, `.subscribe<T>(topic, handler): () => void` (from `src/core/event-bus.ts`); `filesystem:changed` payload shape `{path: string, eventType: "add"|"change"|"unlink"}` (from `src/core/filesystem-watcher.ts`); `analyzeArchitecture()`, `analyzeQuality()`, `analyzePerformance()`, `analyzeSecurity()`, each returning `{score: number, issues: AnalysisIssue[]}` where `AnalysisIssue = {severity: "low"|"medium"|"high", message: string, file?: string}` (from `src/adaptation/analyzer.ts`).
- Produces: `startLiveAnalysis(): {stop: () => void}` — call once at startup. Publishes topic `adaptation:analysis` with payload `{timestamp: number, architecture: AnalysisResult, quality: AnalysisResult, security: AnalysisResult, hasHighSeverity: boolean}` (performance is intentionally excluded — it reads live request telemetry, not source files, so a filesystem-triggered re-run of it is meaningless; it stays on the daily-adaptation cycle only). `hasHighSeverity` is `true` iff any issue across `architecture`/`quality`/`security` has `severity === "high"` — Task 2 subscribes on this exact field.

- [ ] **Step 1: Write the failing test**

```typescript
// In tests/index.test.ts, near the existing EventBus/FilesystemWatcher test blocks
test("LiveAnalysis", "publishes adaptation:analysis after a debounced burst of filesystem:changed events", async () => {
  const { startLiveAnalysis } = await import("../src/adaptation/live-analysis.js");
  const { EventBus } = await import("../src/core/event-bus.js");
  const bus = EventBus.getInstance();

  const received: any[] = [];
  const unsubscribe = bus.subscribe("adaptation:analysis", (payload) => received.push(payload));

  const handle = startLiveAnalysis({ debounceMs: 50 }); // short debounce for the test, not the 5s production default
  try {
    // Simulate a burst: 5 events in quick succession should yield exactly ONE publish.
    for (let i = 0; i < 5; i++) {
      bus.publish("filesystem:changed", { path: `/fake/file${i}.ts`, eventType: "change" });
    }
    await new Promise((resolve) => setTimeout(resolve, 200)); // past the 50ms debounce

    assert(received.length === 1, `expected exactly 1 publish after a debounced burst, got ${received.length}`);
    const payload = received[0];
    assert(typeof payload.timestamp === "number", "payload.timestamp should be a number");
    assert(typeof payload.hasHighSeverity === "boolean", "payload.hasHighSeverity should be a boolean");
    assert(payload.architecture && typeof payload.architecture.score === "number", "payload.architecture should be a real AnalysisResult");
    assert(payload.quality && typeof payload.quality.score === "number", "payload.quality should be a real AnalysisResult");
    assert(payload.security && typeof payload.security.score === "number", "payload.security should be a real AnalysisResult");
    assert(payload.performance === undefined, "payload should NOT include a performance field — it's excluded by design");
  } finally {
    unsubscribe();
    handle.stop();
  }
});
```

Take `{debounceMs: 50}` as an optional constructor-style parameter to `startLiveAnalysis` specifically so this test doesn't have to wait out the real 5000ms production debounce — `startLiveAnalysis(opts?: {debounceMs?: number}): {stop: () => void}`, defaulting `debounceMs` to `5000` when omitted (that's what `server.ts` calls with no args).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx tests/run.ts 2>&1 | grep -A5 "LiveAnalysis"` (or however this repo's `npm test` filters — check `tests/index.test.ts`'s existing `test(...)` call signature and runner invocation pattern used by the EventBus tests already in that file, and mirror it exactly).
Expected: FAIL — `Cannot find module '../src/adaptation/live-analysis.js'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/adaptation/live-analysis.ts
import { EventBus } from "../core/event-bus.js";
import { analyzeArchitecture, analyzeQuality, analyzeSecurity, AnalysisResult } from "./analyzer.js";

export interface LiveAnalysisOptions {
  debounceMs?: number;
}

export function startLiveAnalysis(opts: LiveAnalysisOptions = {}): { stop: () => void } {
  const debounceMs = opts.debounceMs ?? 5000;
  const bus = EventBus.getInstance();

  let timer: NodeJS.Timeout | null = null;

  function runAnalysis() {
    timer = null;
    const architecture: AnalysisResult = analyzeArchitecture();
    const quality: AnalysisResult = analyzeQuality();
    const security: AnalysisResult = analyzeSecurity();

    const hasHighSeverity =
      architecture.issues.some((i) => i.severity === "high") ||
      quality.issues.some((i) => i.severity === "high") ||
      security.issues.some((i) => i.severity === "high");

    bus.publish("adaptation:analysis", {
      timestamp: Date.now(),
      architecture,
      quality,
      security,
      hasHighSeverity,
    });
  }

  const unsubscribe = bus.subscribe("filesystem:changed", () => {
    // Trailing-edge debounce: the first event in a burst arms the timer;
    // later events in the same burst are no-ops (matches eww-bridge.ts's
    // debounce shape) — a continuous stream still flushes every debounceMs
    // instead of the timer being reset/extended and starving forever.
    if (!timer) {
      timer = setTimeout(runAnalysis, debounceMs);
    }
  });

  return {
    stop: () => {
      unsubscribe();
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run the same test command as Step 2.
Expected: PASS.

- [ ] **Step 5: Wire into `src/server.ts` startup**

Find where `startFilesystemWatcher(...)` is called at startup (EB-Task 4's wiring — search for `JARVIS_FILES_DIR` in `server.ts`). Immediately after that block, add:

```typescript
const liveAnalysis = startLiveAnalysis();
```

with the corresponding import (`import { startLiveAnalysis } from "./adaptation/live-analysis.js";` near the other local imports at the top of `server.ts`). No env-var gate is needed — unlike the filesystem watcher, `live-analysis.ts` subscribes to the bus itself and simply does nothing if `filesystem:changed` never fires (e.g. `JARVIS_FILES_DIR` unset), so it's always safe to start unconditionally.

- [ ] **Step 6: Run the full suite**

Run: `npm test` (export `POSTGRES_HOST=localhost POSTGRES_USER=jarvis_user POSTGRES_DB=jarvis INTERNAL_API_KEY=<real value from .env> OAUTH_TOKEN_ENCRYPTION_KEY=<real value from .env>` first — this worktree's `.env` is missing `POSTGRES_HOST`, a known environmental gap unrelated to this task's code).
Expected: all tests pass, including the new one.

- [ ] **Step 7: Commit**

```bash
git add src/adaptation/live-analysis.ts src/server.ts tests/index.test.ts
git commit -m "feat: wire analyzer.ts into the event bus as a debounced filesystem:changed subscriber"
```

---

### Task 2: `src/executive/shadow-verifier.ts` — anomaly-triggered sandbox re-verification

**Files:**
- Create: `src/executive/shadow-verifier.ts`
- Modify: `src/server.ts` (wire into startup, alongside the `startLiveAnalysis()` call from Task 1)
- Test: `tests/index.test.ts`

**Interfaces:**
- Consumes: `EventBus.getInstance().subscribe("adaptation:analysis", handler)` with the payload shape Task 1 produces (`{timestamp, architecture, quality, security, hasHighSeverity}`); `execInChatSandbox(username: string, command: string): Promise<{stdout: string; stderr: string; exitCode: number}>` (from `src/kernel/builder-client.ts`, already exists, already used by `run_sandbox_command` in `tools.ts` — read that call site for the existing error-handling convention, e.g. how it surfaces a `BuilderClientError` when `JARVIS_BUILDER_SECRET` is unset).
- Produces: `startShadowVerifier(): {stop: () => void}`. Publishes topic `builder:shadow-verified` with payload `{timestamp: number, triggeredBy: "adaptation:analysis", passed: boolean, exitCode: number, summary: string}` where `summary` is a short human-readable string (e.g. first ~500 chars of combined stdout+stderr, or `"sandbox unavailable: <reason>"` if `execInChatSandbox` itself throws — this must never crash the process; a failed shadow-verify attempt is itself just a reported fact, not an unhandled rejection).

**A file-level comment this task's implementer MUST include verbatim at the top of `shadow-verifier.ts`** (this is the scope boundary called out in this plan's Global Constraints — do not paraphrase it away):

```typescript
// Deliberately NOT part of the build_requests / human-approval pipeline
// (see coding-agent.ts, autonomous_executive.ts). This module only
// re-runs the existing test suite in an isolated, ad-hoc sandbox
// (execInChatSandbox — no DB row, no build_request, no code change
// proposed or applied) and reports pass/fail. It never creates a
// workspace, never drafts code, never opens a PR. If a real fix is
// ever warranted, that still goes through the existing human-consult
// -> human-approval flow like everything else in this codebase.
```

- [ ] **Step 1: Write the failing test**

```typescript
// In tests/index.test.ts
test("ShadowVerifier", "triggers execInChatSandbox and publishes builder:shadow-verified only when hasHighSeverity is true", async () => {
  const { startShadowVerifier } = await import("../src/executive/shadow-verifier.js");
  const { EventBus } = await import("../src/core/event-bus.js");
  const builderClient = await import("../src/kernel/builder-client.js");
  const bus = EventBus.getInstance();

  let sandboxCalls: { username: string; command: string }[] = [];
  const originalExec = builderClient.execInChatSandbox;
  // @ts-ignore - test-only monkeypatch, matches this file's existing pattern for stubbing kernel clients
  builderClient.execInChatSandbox = async (username: string, command: string) => {
    sandboxCalls.push({ username, command });
    return { stdout: "199/199 passed", stderr: "", exitCode: 0 };
  };

  const received: any[] = [];
  const unsubscribe = bus.subscribe("builder:shadow-verified", (payload) => received.push(payload));
  const handle = startShadowVerifier();

  try {
    // A LOW/MEDIUM-only result must NOT trigger a sandbox run.
    bus.publish("adaptation:analysis", {
      timestamp: Date.now(),
      architecture: { score: 90, issues: [] },
      quality: { score: 90, issues: [{ severity: "low", message: "x" }] },
      security: { score: 90, issues: [] },
      hasHighSeverity: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert(sandboxCalls.length === 0, "a non-high-severity result must not trigger a shadow verify");

    // A HIGH-severity result MUST trigger exactly one sandbox run.
    bus.publish("adaptation:analysis", {
      timestamp: Date.now(),
      architecture: { score: 40, issues: [] },
      quality: { score: 40, issues: [{ severity: "high", message: "tsc error" }] },
      security: { score: 90, issues: [] },
      hasHighSeverity: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert(sandboxCalls.length === 1, `expected exactly 1 sandbox call, got ${sandboxCalls.length}`);
    assert(sandboxCalls[0].username === "system-anomaly-verifier", "must use the synthetic, non-colliding sandbox key");
    assert(sandboxCalls[0].command.includes("npm test"), "must actually re-run the test suite");

    assert(received.length === 1, `expected exactly 1 builder:shadow-verified publish, got ${received.length}`);
    assert(received[0].passed === true, "exitCode 0 should map to passed: true");
  } finally {
    unsubscribe();
    handle.stop();
    // @ts-ignore - restore the real implementation
    builderClient.execInChatSandbox = originalExec;
  }
});
```

Match this test's stubbing mechanism to whatever convention `tests/index.test.ts` already uses elsewhere in this file for stubbing a kernel client (grep the file for an existing example — e.g. how a prior test stubs `groq`/`omniroute`/`builderClient` calls — and follow that exact pattern rather than the monkeypatch sketched above if the codebase already has a cleaner injection point).

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL — `Cannot find module '../src/executive/shadow-verifier.js'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/executive/shadow-verifier.ts
//
// Deliberately NOT part of the build_requests / human-approval pipeline
// (see coding-agent.ts, autonomous_executive.ts). This module only
// re-runs the existing test suite in an isolated, ad-hoc sandbox
// (execInChatSandbox — no DB row, no build_request, no code change
// proposed or applied) and reports pass/fail. It never creates a
// workspace, never drafts code, never opens a PR. If a real fix is
// ever warranted, that still goes through the existing human-consult
// -> human-approval flow like everything else in this codebase.

import { EventBus } from "../core/event-bus.js";
import * as builderClient from "../kernel/builder-client.js";
import { ObservationPlatform } from "../kernel/observation.js";

const SANDBOX_KEY = "system-anomaly-verifier";
const VERIFY_COMMAND = "npm ci && npm test && npx tsc --noEmit";
const SUMMARY_MAX_CHARS = 500;

export function startShadowVerifier(): { stop: () => void } {
  const bus = EventBus.getInstance();
  const observation = ObservationPlatform.getInstance();

  const unsubscribe = bus.subscribe("adaptation:analysis", async (payload: any) => {
    if (!payload?.hasHighSeverity) return;

    try {
      const result = await builderClient.execInChatSandbox(SANDBOX_KEY, VERIFY_COMMAND);
      const combined = (result.stdout + result.stderr).slice(0, SUMMARY_MAX_CHARS);
      bus.publish("builder:shadow-verified", {
        timestamp: Date.now(),
        triggeredBy: "adaptation:analysis",
        passed: result.exitCode === 0,
        exitCode: result.exitCode,
        summary: combined,
      });
    } catch (err: any) {
      observation.logTelemetry("warn", "ShadowVerifier", `shadow verify failed to run: ${err.message}`);
      bus.publish("builder:shadow-verified", {
        timestamp: Date.now(),
        triggeredBy: "adaptation:analysis",
        passed: false,
        exitCode: -1,
        summary: `sandbox unavailable: ${err.message}`,
      });
    }
  });

  return { stop: unsubscribe };
}
```

- [ ] **Step 4: Run test to verify it passes**

Expected: PASS.

- [ ] **Step 5: Wire into `src/server.ts` startup**

Immediately after Task 1's `const liveAnalysis = startLiveAnalysis();` line, add:

```typescript
const shadowVerifier = startShadowVerifier();
```

with the corresponding import. Same unconditional-start reasoning as Task 1 — it does nothing until a real high-severity `adaptation:analysis` event arrives.

- [ ] **Step 6: Run the full suite**

Run: `npm test` (with the same env exports as Task 1's Step 6).
Expected: all tests pass, including both new ones.

- [ ] **Step 7: Commit**

```bash
git add src/executive/shadow-verifier.ts src/server.ts tests/index.test.ts
git commit -m "feat: trigger an isolated sandbox re-verification when live analysis finds a high-severity issue"
```

---

## Final check

- [ ] Run `npx tsc --noEmit && npm test` end to end.
- [ ] Confirm neither new file imports from `coding-agent.ts`, `autonomous_executive.ts`, or any `build_requests`-repo module — `git diff main...HEAD -- src/executive/shadow-verifier.ts src/adaptation/live-analysis.ts` should show zero references to those modules.
- [ ] Confirm `deploy/jarvis-daily-adapt.timer`, `deploy/jarvis-backup.timer`, `deploy/jarvis-backup-check.timer` are untouched (`git diff main...HEAD -- deploy/` should be empty).
- [ ] Manually verify end-to-end if a real `.env` with `JARVIS_BUILDER_SECRET` and a running `jarvis-builder` container are available: start the dev server, touch a source file to introduce a real `tsc` error, confirm `adaptation:analysis` fires within ~5s with `hasHighSeverity: true`, confirm `builder:shadow-verified` fires shortly after with `passed: false`. If no live `jarvis-builder` is reachable in this sandbox, document that the unit/integration tests (with `execInChatSandbox` stubbed) are the verification, same as Plan A's Task 2 chokidar work when live model/hardware wasn't available.
