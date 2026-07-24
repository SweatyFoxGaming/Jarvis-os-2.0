import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

// Must match the real host filesystem path this repo is checked out at —
// see this plan's Global Constraints for why a mismatch here breaks every
// sandbox container.
const REPO_HOST_PATH = process.env.JARVIS_REPO_HOST_PATH || "/mnt/jarvis_home/llm";
const WORKSPACES_DIR = `${REPO_HOST_PATH}/.jarvis-build-workspaces`;
const SANDBOX_IMAGE = "jarvis-sandbox:latest";

// Defense-in-depth backstop, independent of whatever wall-clock budget the
// (separate, later) agentic loop enforces on itself — catches the case
// where that loop hangs or crashes without calling destroyWorkspace.
const MAX_CONTAINER_LIFETIME_MS = 60 * 60 * 1000;

function workspaceDir(buildRequestId: number): string {
  return `${WORKSPACES_DIR}/br-${buildRequestId}`;
}

function containerName(buildRequestId: number): string {
  return `jarvis-sandbox-br-${buildRequestId}`;
}

function branchName(buildRequestId: number): string {
  return `jarvis/build-request-${buildRequestId}`;
}

export interface WorkspaceHandle {
  buildRequestId: number;
  branch: string;
  containerName: string;
}

// Builds the shared sandbox image once, the first time it's needed —
// subsequent calls are a fast no-op (`docker image inspect` succeeding).
export async function ensureSandboxImage(): Promise<void> {
  try {
    await execFileAsync("docker", ["image", "inspect", SANDBOX_IMAGE]);
    return;
  } catch {
    // Not found yet — fall through and build it.
  }
  await execFileAsync("docker", ["build", "-f", "sandbox.Dockerfile", "-t", SANDBOX_IMAGE, "."], {
    cwd: "/app",
  });
}

export async function createWorkspace(buildRequestId: number, baseBranch: string): Promise<WorkspaceHandle> {
  const dir = workspaceDir(buildRequestId);
  const branch = branchName(buildRequestId);
  const container = containerName(buildRequestId);

  await execFileAsync("mkdir", ["-p", WORKSPACES_DIR]);
  await execFileAsync("git", ["fetch", "origin", baseBranch], { cwd: REPO_HOST_PATH });

  // -B resets the branch to origin/baseBranch's current tip if it already
  // exists (e.g. a prior attempt for this same build request), rather than
  // failing outright.
  await execFileAsync("git", ["worktree", "add", "-B", branch, dir, `origin/${baseBranch}`], {
    cwd: REPO_HOST_PATH,
  });

  // Deliberately no `-e`/`--env-file` here: the sandbox container starts
  // with a clean environment, no GitHub credentials, no production
  // secrets — per this feature's design spec, the free-reign coding phase
  // has no path to anything beyond its own bind-mounted worktree. Don't
  // "fix" this by passing env vars through without re-reading that spec.
  await execFileAsync("docker", [
    "run", "-d",
    "--name", container,
    "--cpus", "1",
    "--memory", "1g",
    "--label", "jarvis-sandbox=true",
    "--label", `jarvis-build-request-id=${buildRequestId}`,
    "-v", `${dir}:/workspace`,
    "-w", "/workspace",
    SANDBOX_IMAGE,
    "sleep", "infinity",
  ]);

  return { buildRequestId, branch, containerName: container };
}

export async function execInWorkspace(
  buildRequestId: number,
  command: string
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const container = containerName(buildRequestId);
  try {
    // The outer execFile call takes an argument array — no outer shell
    // parses `command`, so there's no injection risk against jarvis-builder
    // itself. `sh -c` intentionally interprets `command` as shell code
    // inside the sandbox container — that's the "free reign" primitive by
    // design, not a bug.
    const { stdout, stderr } = await execFileAsync("docker", ["exec", container, "sh", "-c", command], {
      maxBuffer: 10 * 1024 * 1024,
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (err: any) {
    // A non-zero exit code (a failing test, a typo'd command) is a normal,
    // expected outcome here, not a real error — surfaced as a result.
    return {
      stdout: err.stdout || "",
      stderr: err.stderr || err.message || String(err),
      exitCode: typeof err.code === "number" ? err.code : 1,
    };
  }
}

export async function destroyWorkspace(buildRequestId: number): Promise<void> {
  const dir = workspaceDir(buildRequestId);
  const container = containerName(buildRequestId);

  await execFileAsync("docker", ["rm", "-f", container]).catch(() => {});
  await execFileAsync("git", ["worktree", "remove", "--force", dir], { cwd: REPO_HOST_PATH }).catch(() => {});
  await execFileAsync("git", ["worktree", "prune"], { cwd: REPO_HOST_PATH }).catch(() => {});
}

export function startReaper(): void {
  setInterval(async () => {
    try {
      const { stdout } = await execFileAsync("docker", [
        "ps", "-a",
        "--filter", "label=jarvis-sandbox=true",
        "--format", "{{.ID}}\t{{.CreatedAt}}",
      ]);
      const now = Date.now();
      for (const line of stdout.trim().split("\n").filter(Boolean)) {
        const [id, createdAt] = line.split("\t");
        const createdMs = Date.parse(createdAt);
        if (!isNaN(createdMs) && now - createdMs > MAX_CONTAINER_LIFETIME_MS) {
          await execFileAsync("docker", ["rm", "-f", id]).catch(() => {});
        }
      }
    } catch {
      // Best-effort — a failed reaper pass just tries again next interval.
    }
  }, 5 * 60 * 1000);
}
