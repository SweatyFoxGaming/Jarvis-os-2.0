import * as net from "net";
import * as fs from "fs";
import * as path from "path";
import { pingDatabase } from "../kernel/state/db.js";
import { ObservationPlatform } from "../kernel/observation.js";
import { MindKernel } from "./kernel.js";
import { assertSafeEgressUrl, normalizeLocalLlmUrl } from "../kernel/egress.js";

const observation = ObservationPlatform.getInstance();

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

let companionReportedSha: string | null = null;
let companionReportedAt: number | null = null;

export function recordCompanionVersionReport(sha: string): void {
  companionReportedSha = sha;
  companionReportedAt = Date.now();
}

export function getCompanionVersionReport(): { sha: string | null; reportedAt: number | null } {
  return { sha: companionReportedSha, reportedAt: companionReportedAt };
}

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
    return head;
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

export const STALE_GRACE_PERIOD_MS = 30 * 60 * 1000;
export const MISMATCH_GRACE_PERIOD_MS = 30 * 60 * 1000;

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
    const firstObservedAt =
      tracked && tracked.reportedSha === reportedSha ? tracked.firstObservedAt : now;
    mismatchTracker.set({ reportedSha, realSha, firstObservedAt });
    if (now - firstObservedAt < MISMATCH_GRACE_PERIOD_MS) {
      return { stale: false, reason: null };
    }
    return { stale: true, reason: `EWW HUD bridge is running commit ${reportedSha.slice(0, 7)}, but the current repo is at ${realSha.slice(0, 7)}.` };
  }
  mismatchTracker.set(null);
  return { stale: false, reason: null };
}

export type HealthCheckKey =
  | "postgres"
  | "observation-platform"
  | "voice-daemon"
  | "local-llm"
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
    const localLlmEndpoint = MindKernel.getInstance().localLlmEndpoint;
    if (localLlmEndpoint) {
      const normalizedUrl = normalizeLocalLlmUrl(localLlmEndpoint);
      assertSafeEgressUrl(normalizedUrl);
      const localLlmOk = await deps.checkHttpReachable(normalizedUrl);
      if (!localLlmOk) {
        problems.push({
          key: "local-llm",
          message: `Local LLM (llama-cpp) is unreachable at ${localLlmEndpoint}.`,
        });
      }
    }
  } catch (err: any) {
    problems.push({ key: "local-llm", message: `Local LLM health check itself failed: ${err.message}` });
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