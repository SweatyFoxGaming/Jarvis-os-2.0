import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

// Must match the real host filesystem path this repo is checked out at —
// see this plan's Global Constraints for why a mismatch here breaks every
// sandbox container.
const REPO_HOST_PATH = process.env.JARVIS_REPO_HOST_PATH || "/mnt/jarvis_home/llm";
const WORKSPACES_DIR = `${REPO_HOST_PATH}/.jarvis-build-workspaces`;
const SANDBOX_IMAGE = "jarvis-sandbox:latest";

// Number(x) || fallback silently lets a negative value through (Number("-1")
// || fallback evaluates to -1, since -1 is truthy) — used for both env vars
// below so neither can be misconfigured into a bound that doesn't bound
// anything.
function positiveIntegerEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

// Defense-in-depth backstop, independent of whatever wall-clock budget the
// agentic loop enforces on itself — catches the case where that loop hangs
// or crashes without calling destroyWorkspace. Deliberately much larger than
// a coding session's own budget: this clock starts at createWorkspace, but a
// workspace must survive all the way through the *human* approval checkpoint
// (approve-code re-verifies against this exact container), and a human can
// legitimately take far longer than an hour to review. Reaping a workspace
// that's merely awaiting approval permanently burns the build request, so
// 24h — still a backstop, not a session budget. Override with
// JARVIS_SANDBOX_MAX_LIFETIME_MS if a deployment needs a different bound.
const MAX_CONTAINER_LIFETIME_MS = positiveIntegerEnv(process.env.JARVIS_SANDBOX_MAX_LIFETIME_MS, 24 * 60 * 60 * 1000);

// Nothing previously bounded how many sandbox containers (each a full
// `git clone` of this repo plus a running container) could exist at once —
// the 24h reaper above only cleans up OLD ones, so ordinary sequential use
// (not any kind of attack) could accumulate workspaces faster than the
// reaper ever removes them and exhaust host disk. This is a plain
// check-then-create guard, not a database-backed atomic lock (jarvis-builder
// has no database of its own to hold one in) — a tight race between two
// near-simultaneous createWorkspace calls could momentarily exceed this by
// one or two. That's an acceptable gap for what this actually defends
// against (accumulation over time from repeated normal use, not a
// concurrent-burst exploit) — a real per-user concurrency limit already
// exists a layer up, in Postgres, for how many build/coding sessions a
// single user can have running at once.
const MAX_CONCURRENT_WORKSPACES = positiveIntegerEnv(process.env.JARVIS_SANDBOX_MAX_CONCURRENT, 5);

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

// Rejects anything that could be parsed by git as a flag (e.g. a leading
// `-`, which enables argument-injection primitives like `--upload-pack=...`)
// rather than a plain ref name. A real branch name never needs characters
// outside this set.
function assertSafeBranchName(baseBranch: string): void {
  if (baseBranch.startsWith("-") || !/^[A-Za-z0-9._/-]+$/.test(baseBranch)) {
    throw new Error(`Refusing to use unsafe baseBranch value: ${JSON.stringify(baseBranch)}`);
  }
}

// Same label filter the reaper uses — counts every sandbox container
// currently known to Docker regardless of status (a stopped-but-not-yet-
// removed one still holds its workspace clone on disk), not just running
// ones.
async function countLiveWorkspaces(): Promise<number> {
  const { stdout } = await execFileAsync("docker", [
    "ps", "-a",
    "--filter", "label=jarvis-sandbox=true",
    "--format", "{{.ID}}",
  ]);
  return stdout.trim().split("\n").filter(Boolean).length;
}

export async function createWorkspace(buildRequestId: number, baseBranch: string): Promise<WorkspaceHandle> {
  assertSafeBranchName(baseBranch);

  // Checked before any git fetch/clone or disk work happens below, so a
  // request that's going to be refused doesn't first do several seconds of
  // wasted git/disk work only to fail at the docker run step.
  const liveCount = await countLiveWorkspaces();
  if (liveCount >= MAX_CONCURRENT_WORKSPACES) {
    throw new Error(
      `Refusing to create a new sandbox workspace: ${liveCount} already exist ` +
        `(limit ${MAX_CONCURRENT_WORKSPACES}, override with JARVIS_SANDBOX_MAX_CONCURRENT). ` +
        "Approve or reject a pending build request to free one up, or wait for the reaper."
    );
  }

  const dir = workspaceDir(buildRequestId);
  const stagingDir = `${dir}.staging`;
  const branch = branchName(buildRequestId);
  const container = containerName(buildRequestId);

  // Git 2.35+ refuses to operate on a repo it doesn't consider "owned" by
  // the current process's UID (the "dubious ownership" safe-directory
  // check added after CVE-2022-24765). The bind-mounted repo keeps the
  // HOST's file ownership, but this container process runs as a different
  // UID, so every git call below would otherwise fail. Scoped to exactly
  // this one known repo path (not `*`, which would blanket-trust any
  // bind-mounted path). `--add` is idempotent, so re-running this on every
  // call is harmless and avoids depending on some other startup step
  // having already run it.
  await execFileAsync("git", ["config", "--global", "--add", "safe.directory", REPO_HOST_PATH]);

  await execFileAsync("mkdir", ["-p", WORKSPACES_DIR]);
  await execFileAsync("git", ["fetch", "origin", baseBranch], { cwd: REPO_HOST_PATH });

  // -B resets the branch to origin/baseBranch's current tip if it already
  // exists (e.g. a prior attempt for this same build request), rather than
  // failing outright.
  await execFileAsync("git", ["worktree", "add", "-B", branch, stagingDir, `origin/${baseBranch}`], {
    cwd: REPO_HOST_PATH,
  });

  // Sandbox containers must never get write access to this repo's shared
  // .git (refs/objects covering every branch, including main) — a linked
  // worktree's .git is just a pointer into that shared directory, so
  // mounting it directly would let the "free reign" sandbox corrupt the
  // host repo's real refs (e.g. `git branch -D main`) no matter what
  // command it happened to run. Cloning the staging worktree gives the
  // sandbox its own fully independent .git (hardlinked objects, separate
  // refs/HEAD) that only this build can ever touch; the staging worktree
  // is discarded immediately after.
  await execFileAsync("git", ["clone", stagingDir, dir]);

  // The clone above is owned by whatever uid this (jarvis-builder) process
  // runs as (root) — the sandbox container below runs as its image's
  // built-in non-root `node` user (uid/gid 1000) instead, so without this
  // it couldn't write to its own bind-mounted workspace at all.
  await execFileAsync("chown", ["-R", "1000:1000", dir]);

  await execFileAsync("git", ["worktree", "remove", "--force", stagingDir], { cwd: REPO_HOST_PATH }).catch(() => {});
  // `git worktree add -B` above created a real local branch in
  // REPO_HOST_PATH's own repo (not just the staging checkout) —
  // `worktree remove` only unregisters the staging directory, it never
  // deletes that branch. The branch was only scaffolding for the staging
  // worktree: the sandbox's clone above already has everything it needs,
  // so leaving it registered in REPO_HOST_PATH would permanently pollute
  // the real repo's branch list on every build request, forever. `-D`
  // (force) is safe here since the branch's commits already live in the
  // sandbox clone's own history — this repo's own branch pointer doesn't
  // need to be "merged" to be deleted.
  await execFileAsync("git", ["branch", "-D", branch], { cwd: REPO_HOST_PATH }).catch(() => {});

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
    // Network access stays on deliberately — package-registry access
    // (npm/pip/etc. during the coding phase) is an accepted, explicit
    // exception per this feature's design spec, not an oversight; a
    // fully locked-down egress boundary is a separate, larger follow-up
    // (an allowlisting proxy), not something a flag here can do safely.
    // What these flags remove is privilege this "free reign" shell never
    // legitimately needs regardless of network policy: root-equivalent
    // capabilities, privilege escalation via setuid binaries, and an
    // unbounded process/fork count.
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges:true",
    "--pids-limit", "512",
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
  // `dir` is a plain `git clone`, not a registered worktree of
  // REPO_HOST_PATH, so `git worktree remove` doesn't apply here — a plain
  // recursive delete is all that's needed to reclaim the disk. `worktree
  // prune` below is still useful as a safety net for any staging worktree
  // (see createWorkspace) that failed to clean up.
  await execFileAsync("rm", ["-rf", dir]).catch(() => {});
  await execFileAsync("git", ["worktree", "prune"], { cwd: REPO_HOST_PATH }).catch(() => {});
}

export function startReaper(): void {
  setInterval(async () => {
    try {
      const { stdout } = await execFileAsync("docker", [
        "ps", "-a",
        "--filter", "label=jarvis-sandbox=true",
        "--format", "{{.ID}}",
      ]);
      const now = Date.now();
      const ids = stdout.trim().split("\n").filter(Boolean);

      // `docker ps --format {{.CreatedAt}}` is locale/timezone-dependent
      // (e.g. `2026-07-24 18:53:15 +0200 SAST`) and Node's Date.parse
      // silently fails on non-standard timezone abbreviations like `SAST`,
      // which would make this safety-net reaper never remove anything
      // without any error or log. `docker inspect --format {{.Created}}`
      // instead returns RFC3339 UTC, which Date.parse always handles.
      // The build-request-id label (set at `docker run` time) comes back in
      // the same inspect call so the on-disk workspace clone can be removed
      // alongside the container — removing only the container would leak the
      // clone directory's disk forever, which the approval checkpoint makes
      // a routine path rather than a rare one.
      // Each container is checked independently so one bad/slow ID can't
      // stop the rest of the pass from being reaped.
      await Promise.allSettled(
        ids.map(async (id) => {
          try {
            const { stdout: inspected } = await execFileAsync("docker", [
              "inspect",
              "--format",
              '{{.Created}} {{index .Config.Labels "jarvis-build-request-id"}}',
              id,
            ]);
            const [createdAt, buildRequestId] = inspected.trim().split(/\s+/);
            const createdMs = Date.parse((createdAt || "").trim());
            if (!isNaN(createdMs) && now - createdMs > MAX_CONTAINER_LIFETIME_MS) {
              await execFileAsync("docker", ["rm", "-f", id]).catch(() => {});
              // Only ever derived from the label, and only when it's a plain
              // integer — never an arbitrary string interpolated into a path.
              if (buildRequestId && /^\d+$/.test(buildRequestId)) {
                await execFileAsync("rm", ["-rf", workspaceDir(Number(buildRequestId))]).catch(() => {});
              }
            }
          } catch {
            // Best-effort per-container — a failure here (e.g. the
            // container vanished between `ps` and `inspect`) shouldn't
            // stop other containers from being checked.
          }
        })
      );
    } catch {
      // Best-effort — a failed reaper pass just tries again next interval.
    }
  }, 5 * 60 * 1000);
}
