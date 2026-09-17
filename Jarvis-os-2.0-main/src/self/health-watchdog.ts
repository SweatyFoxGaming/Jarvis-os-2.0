import * as net from "net";
import * as fs from "fs";
import * as path from "path";
import { pingDatabase } from "../kernel/state/db.js";
import { ObservationPlatform } from "../kernel/observation.js";
import { MindKernel } from "./kernel.js";

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
    // Any response at all (including 4xx) means something is actually
    // listening and answering HTTP on the other end — reachability is what
    // this check is for, not endpoint correctness. Only a genuine 5xx or a
    // failed/timed-out fetch (network unreachable, connection refused, DNS
    // failure) counts as unreachable.
    return res.ok || res.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// ---------- Companion (EWW HUD bridge) staleness detection ----------
//
// This is the second real health signal from the design spec, and the exact
// incident class that motivated this whole watchdog: the HUD bridge
// (src/ipc/eww-bridge.ts, deployed via scripts/deploy-hud.sh) silently kept
// running weeks-old compiled JS on the live host earlier this session until
// a human happened to notice. deploy-hud.sh now stamps a VERSION file (the
// deployed git SHA) next to the compiled bridge; the bridge reads it once at
// its own startup and self-reports it to POST /api/hud/report-version (see
// src/interaction/routes/hud-routes.ts), which calls
// recordCompanionVersionReport below. assessSystemHealth compares that
// last-reported SHA against the real current repo HEAD (readRepoHeadSha)
// every tick.

// In-memory only, deliberately: if the api process restarts, this resets to
// null/null. checkCompanionStaleness correctly treats that the same as "the
// bridge hasn't reported yet" (a real, reportable problem) -- but it's
// self-healing, not a permanent gap: the bridge re-reports its version
// every 5 minutes on its own AND on every WebSocket (re)connect (see
// eww-bridge.ts), independent of any server-side event, so a restart only
// ever leaves this blind for a few minutes -- well inside
// STALE_GRACE_PERIOD_MS below, so a restart alone can't produce a false
// "may have stopped running". Not worth Postgres persistence for a value
// that repairs itself that fast.
let companionReportedSha: string | null = null;
let companionReportedAt: number | null = null;

export function recordCompanionVersionReport(sha: string): void {
  companionReportedSha = sha;
  companionReportedAt = Date.now();
}

export function getCompanionVersionReport(): { sha: string | null; reportedAt: number | null } {
  return { sha: companionReportedSha, reportedAt: companionReportedAt };
}

// Resolves the real .git directory for repoRoot, following the "gitdir:"
// pointer file a git *worktree* checkout uses in place of a real .git
// directory (this repo's own dev worktrees are exactly this shape -- see
// .claude/worktrees/*/.git), and further following that worktree gitdir's
// own "commondir" pointer to find where refs/HEAD-history are actually
// shared from (a worktree's own private gitdir does NOT contain
// refs/heads/* -- only the common dir does).
function resolveGitDirs(repoRoot: string): { gitDir: string; commonDir: string } {
  const gitPath = path.join(repoRoot, ".git");
  const stat = fs.statSync(gitPath);
  let gitDir: string;
  if (stat.isDirectory()) {
    gitDir = gitPath;
  } else {
    const content = fs.readFileSync(gitPath, "utf8").trim();
    const match = content.match(/^gitdir:\s*(.+)$/);
    if (!match) throw new Error(`Unrecognized .git file at ${gitPath}`);
    gitDir = path.resolve(repoRoot, match[1]);
  }
  const commondirPath = path.join(gitDir, "commondir");
  const commonDir = fs.existsSync(commondirPath)
    ? path.resolve(gitDir, fs.readFileSync(commondirPath, "utf8").trim())
    : gitDir;
  return { gitDir, commonDir };
}

// Reads the real current commit SHA directly from git's own plumbing files,
// equivalent to `git rev-parse HEAD` -- deliberately NOT shelling out to a
// `git` binary. Verified against the real production container
// (jarvis-os-api, Alpine-based, see Dockerfile): git is not installed there
// (only python3/pip/bash/ffmpeg), so execFileSync("git", ...) would throw
// ENOENT on every single tick in production, permanently reporting a false
// "companion staleness check itself failed" problem forever -- exactly the
// kind of noisy, useless check this plan exists to avoid. This has no
// dependency on PATH or an installed git binary, in dev or in production.
// packed-refs lines are "<sha> <full-ref-name>", one pair per line, plus
// "#"-prefixed comment/header lines and (for annotated tags) "^"-prefixed
// peeled-object lines. The ref field is parsed as an explicit whitespace-
// delimited field and compared EXACTLY, rather than relying on a suffix/
// endsWith check against " " + ref -- git ref names can't contain spaces,
// so that would happen to be equivalent for well-formed input, but exact
// field parsing is more explicit about the actual line format and doesn't
// depend on that invariant holding.
export function findPackedRefSha(packedRefsContent: string, ref: string): string | null {
  for (const rawLine of packedRefsContent.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("^")) continue;
    const [sha, name] = line.split(/\s+/);
    if (name === ref && sha) return sha;
  }
  return null;
}

export function readRepoHeadSha(repoRoot: string = process.cwd()): string {
  const { gitDir, commonDir } = resolveGitDirs(repoRoot);
  const head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
  if (!head.startsWith("ref:")) {
    return head; // Detached HEAD: the HEAD file holds the SHA directly.
  }
  const ref = head.slice(4).trim();
  const refPath = path.join(commonDir, ref);
  if (fs.existsSync(refPath)) {
    return fs.readFileSync(refPath, "utf8").trim();
  }
  const packedRefsPath = path.join(commonDir, "packed-refs");
  if (fs.existsSync(packedRefsPath)) {
    const sha = findPackedRefSha(fs.readFileSync(packedRefsPath, "utf8"), ref);
    if (sha) return sha;
  }
  throw new Error(`Could not resolve ref "${ref}" to a commit SHA under ${commonDir}.`);
}

// Two distinct 30-minute windows, deliberately the same length but NOT the
// same concept:
//   - STALE_GRACE_PERIOD_MS: how old the bridge's last heartbeat may get
//     before "it may have stopped running" is a fair conclusion. The bridge
//     re-reports every 5 minutes (VERSION_REPORT_INTERVAL_MS in
//     eww-bridge.ts) and additionally on every WebSocket (re)connect, so a
//     healthy bridge stays ~6 heartbeats inside this window; only a genuine
//     multi-attempt failure can cross it.
//   - MISMATCH_GRACE_PERIOD_MS: how long a reported-SHA-vs-real-HEAD
//     mismatch must PERSIST before it's a real staleness signal rather than
//     a deploy that's simply still in flight. Required by the design spec:
//     "A mismatch persisting past a grace period (to avoid false-positives
//     during a deploy in progress) is a real, actionable staleness signal."
//     Without it, every single commit to the deployment checkout instantly
//     flagged the HUD as stale before the bridge had any chance to redeploy.
// They're separate constants (not one shared one) because they answer
// different questions and could reasonably diverge later.
export const STALE_GRACE_PERIOD_MS = 30 * 60 * 1000;
export const MISMATCH_GRACE_PERIOD_MS = 30 * 60 * 1000;

// Cross-tick state for the mismatch grace period. checkCompanionStaleness
// is called once per 10-minute watchdog tick and has to remember when a
// mismatch was FIRST seen, so it needs state that outlives a single call --
// same in-memory, self-healing shape (and same rationale) as
// recordCompanionVersionReport's store above: an api restart just resets the
// clock, costing at most one extra grace period before a real mismatch is
// flagged. Exposed as an injectable tracker rather than read/written
// directly so tests can simulate "30 minutes have passed" without waiting
// and without leaking state between tests, matching this file's existing
// HealthWatchdogDeps injection pattern.
export interface CompanionMismatchState {
  reportedSha: string;
  realSha: string;
  firstObservedAt: number;
}

export interface CompanionMismatchTracker {
  get(): CompanionMismatchState | null;
  set(state: CompanionMismatchState | null): void;
}

let companionMismatch: CompanionMismatchState | null = null;

export const defaultCompanionMismatchTracker: CompanionMismatchTracker = {
  get: () => companionMismatch,
  set: (state) => { companionMismatch = state; },
};

export function createCompanionMismatchTracker(
  initial: CompanionMismatchState | null = null
): CompanionMismatchTracker {
  let state = initial;
  return { get: () => state, set: (next) => { state = next; } };
}

export function checkCompanionStaleness(
  reportedSha: string | null,
  reportedAt: number | null,
  realSha: string,
  now: number = Date.now(),
  mismatchTracker: CompanionMismatchTracker = defaultCompanionMismatchTracker
): { stale: boolean; reason: string | null } {
  if (reportedSha === null || reportedAt === null) {
    mismatchTracker.set(null);
    return { stale: true, reason: "EWW HUD bridge has not reported a version recently -- it may not be running." };
  }
  if (now - reportedAt > STALE_GRACE_PERIOD_MS) {
    mismatchTracker.set(null);
    return { stale: true, reason: "EWW HUD bridge's last version report is too old -- it may have stopped running." };
  }
  if (reportedSha !== realSha) {
    const tracked = mismatchTracker.get();
    // The timer restarts when the BRIDGE's reported SHA changes (a fresh
    // deploy genuinely just happened, so it has earned a fresh grace
    // window), but NOT when the repo's real HEAD moves while the bridge
    // stays put. That second case is the same unresolved problem -- the
    // bridge is still behind, in fact further behind -- and resetting on it
    // would mean a repo committed to more often than once per grace period
    // could never flag staleness at all, which is exactly the incident this
    // check exists to catch.
    const firstObservedAt =
      tracked && tracked.reportedSha === reportedSha ? tracked.firstObservedAt : now;
    mismatchTracker.set({ reportedSha, realSha, firstObservedAt });
    if (now - firstObservedAt < MISMATCH_GRACE_PERIOD_MS) {
      // Still inside the deploy-in-progress tolerance window: real, but not
      // yet actionable, so not reported.
      return { stale: false, reason: null };
    }
    return { stale: true, reason: `EWW HUD bridge is running commit ${reportedSha.slice(0, 7)}, but the current repo is at ${realSha.slice(0, 7)}.` };
  }
  // Mismatch resolved (the bridge caught up): drop the tracking so a later,
  // unrelated mismatch starts its own fresh grace period rather than
  // inheriting a stale "first observed" timestamp.
  mismatchTracker.set(null);
  return { stale: false, reason: null };
}

// A problem carries a STABLE per-check identity (`key`) alongside its
// human-readable `message`. The key never varies with the specific failure
// detail; the message always names the specific thing that's wrong (a
// Global Constraint of this plan). Callers that need to recognise "this is
// the same problem I already reported" -- notably scheduler.ts's
// cooldown-gating -- compare keys, never messages: the companion-staleness
// message interpolates short SHAs, so the identical underlying problem
// ("the HUD is stale") produced a brand-new string every time repo HEAD
// moved, which defeated the cooldown entirely and re-notified on every tick.
export type HealthCheckKey =
  | "postgres"
  | "observation-platform"
  | "voice-daemon"
  | "llama-cpp"
  | "companion-staleness";

export interface HealthProblem {
  key: HealthCheckKey;
  message: string;
}

export interface HealthAssessment {
  ok: boolean;
  problems: HealthProblem[];
}

export interface HealthWatchdogDeps {
  pingDatabase: typeof pingDatabase;
  getHealth: typeof observation.getHealth;
  checkSocketReachable: typeof checkSocketReachable;
  checkHttpReachable: typeof checkHttpReachable;
  getCompanionReport: () => { sha: string | null; reportedAt: number | null };
  getRealHeadSha: () => string;
  // Optional, injected only by tests: real callers want the real clock and
  // the real process-wide mismatch tracker (the grace period is meaningless
  // if every tick gets a fresh tracker).
  now?: () => number;
  companionMismatchTracker?: CompanionMismatchTracker;
}

const defaultDeps: HealthWatchdogDeps = {
  pingDatabase,
  getHealth: () => observation.getHealth(),
  checkSocketReachable,
  checkHttpReachable,
  getCompanionReport: getCompanionVersionReport,
  getRealHeadSha: () => readRepoHeadSha(),
};

export async function assessSystemHealth(
  deps: HealthWatchdogDeps = defaultDeps
): Promise<HealthAssessment> {
  const problems: HealthProblem[] = [];

  try {
    const dbOk = await deps.pingDatabase();
    if (!dbOk) problems.push({ key: "postgres", message: "Postgres is unreachable." });
  } catch (err: any) {
    problems.push({ key: "postgres", message: `Postgres health check itself failed: ${err.message}` });
  }

  try {
    // "green" is the only fully-healthy status ObservationPlatform.getHealth()
    // reports today (src/kernel/observation.ts) — "yellow" means it's running
    // in a degraded/simulated mode (currently: no GEMINI_API_KEY configured,
    // so cloud calls are simulated rather than real). Anything other than
    // "green" is a real, reportable problem, not just informational.
    const health = deps.getHealth();
    if (health.status !== "green") {
      problems.push({ key: "observation-platform", message: `ObservationPlatform reports degraded status: ${health.status}.` });
    }
  } catch (err: any) {
    problems.push({ key: "observation-platform", message: `ObservationPlatform health check itself failed: ${err.message}` });
  }

  try {
    const voiceSocketPath = process.env.VOICE_DAEMON_SOCKET || "/tmp/jarvis-voice/voice.sock";
    const voiceOk = await deps.checkSocketReachable(voiceSocketPath);
    if (!voiceOk) problems.push({ key: "voice-daemon", message: `Voice daemon is unreachable at ${voiceSocketPath}.` });
  } catch (err: any) {
    problems.push({ key: "voice-daemon", message: `Voice daemon health check itself failed: ${err.message}` });
  }

  try {
    // localLlmEndpoint is NOT an env var: it's MindKernel's persisted-settings
    // system setting (Postgres system_settings.local_llm_endpoint, hydrated at
    // boot by MindKernel.hydrateFromDb(), live-editable via /api/settings —
    // see src/self/kernel.ts). Every other call site in this codebase
    // (server.ts, voice-session.ts, cognition-router.ts, settings-routes.ts)
    // reads it the same way, off the MindKernel singleton, never off
    // process.env. Reading a guessed LOCAL_LLM_ENDPOINT env var here would
    // silently check an always-empty URL and make this whole check useless.
    const llamaEndpoint = MindKernel.getInstance().localLlmEndpoint;
    if (llamaEndpoint) {
      const llamaOk = await deps.checkHttpReachable(llamaEndpoint);
      if (!llamaOk) problems.push({ key: "llama-cpp", message: `llama-cpp is unreachable at ${llamaEndpoint}.` });
    }
  } catch (err: any) {
    problems.push({ key: "llama-cpp", message: `llama-cpp health check itself failed: ${err.message}` });
  }

  try {
    const { sha: reportedSha, reportedAt } = deps.getCompanionReport();
    const realSha = deps.getRealHeadSha();
    const { stale, reason } = checkCompanionStaleness(
      reportedSha,
      reportedAt,
      realSha,
      (deps.now ?? Date.now)(),
      deps.companionMismatchTracker ?? defaultCompanionMismatchTracker
    );
    if (stale && reason) problems.push({ key: "companion-staleness", message: reason });
  } catch (err: any) {
    problems.push({ key: "companion-staleness", message: `EWW HUD bridge staleness check itself failed: ${err.message}` });
  }

  return { ok: problems.length === 0, problems };
}
