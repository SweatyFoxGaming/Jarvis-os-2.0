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
// hourly on its own (see eww-bridge.ts), independent of any server-side
// event, so a restart only ever leaves this blind for at most that long. Not
// worth Postgres persistence for a value that repairs itself within an hour.
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
    const line = fs
      .readFileSync(packedRefsPath, "utf8")
      .split("\n")
      .find(l => l.trim().endsWith(` ${ref}`));
    if (line) return line.trim().split(/\s+/)[0];
  }
  throw new Error(`Could not resolve ref "${ref}" to a commit SHA under ${commonDir}.`);
}

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

export interface HealthWatchdogDeps {
  pingDatabase: typeof pingDatabase;
  getHealth: typeof observation.getHealth;
  checkSocketReachable: typeof checkSocketReachable;
  checkHttpReachable: typeof checkHttpReachable;
  getCompanionReport: () => { sha: string | null; reportedAt: number | null };
  getRealHeadSha: () => string;
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
): Promise<{ ok: boolean; problems: string[] }> {
  const problems: string[] = [];

  try {
    const dbOk = await deps.pingDatabase();
    if (!dbOk) problems.push("Postgres is unreachable.");
  } catch (err: any) {
    problems.push(`Postgres health check itself failed: ${err.message}`);
  }

  try {
    // "green" is the only fully-healthy status ObservationPlatform.getHealth()
    // reports today (src/kernel/observation.ts) — "yellow" means it's running
    // in a degraded/simulated mode (currently: no GEMINI_API_KEY configured,
    // so cloud calls are simulated rather than real). Anything other than
    // "green" is a real, reportable problem, not just informational.
    const health = deps.getHealth();
    if (health.status !== "green") {
      problems.push(`ObservationPlatform reports degraded status: ${health.status}.`);
    }
  } catch (err: any) {
    problems.push(`ObservationPlatform health check itself failed: ${err.message}`);
  }

  try {
    const voiceSocketPath = process.env.VOICE_DAEMON_SOCKET || "/tmp/jarvis-voice/voice.sock";
    const voiceOk = await deps.checkSocketReachable(voiceSocketPath);
    if (!voiceOk) problems.push(`Voice daemon is unreachable at ${voiceSocketPath}.`);
  } catch (err: any) {
    problems.push(`Voice daemon health check itself failed: ${err.message}`);
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
      if (!llamaOk) problems.push(`llama-cpp is unreachable at ${llamaEndpoint}.`);
    }
  } catch (err: any) {
    problems.push(`llama-cpp health check itself failed: ${err.message}`);
  }

  try {
    const { sha: reportedSha, reportedAt } = deps.getCompanionReport();
    const realSha = deps.getRealHeadSha();
    const { stale, reason } = checkCompanionStaleness(reportedSha, reportedAt, realSha);
    if (stale && reason) problems.push(reason);
  } catch (err: any) {
    problems.push(`EWW HUD bridge staleness check itself failed: ${err.message}`);
  }

  return { ok: problems.length === 0, problems };
}
