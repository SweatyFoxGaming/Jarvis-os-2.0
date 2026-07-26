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
// anything. Number.isSafeInteger, not Number.isInteger: the latter accepts
// values like 1e100, which would make either limit effectively unbounded.
function positiveIntegerEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

// A dedicated error type so server.ts can tell "the sandbox cap is full, try
// again later" apart from a genuine internal failure and answer with the
// right status code instead of a flat 500 for both.
export class WorkspaceCapacityError extends Error {}

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
// reaper ever removes them and exhaust host disk.
const MAX_CONCURRENT_WORKSPACES = positiveIntegerEnv(process.env.JARVIS_SANDBOX_MAX_CONCURRENT, 5);

// The actual admission gate — checked and reserved synchronously (no
// `await` between the check and the add below), which is what makes this
// race-free despite jarvis-builder having no database to hold a real
// distributed lock in: it's a single Node process, so nothing else can
// interleave between those two lines. An earlier version checked a live
// `docker ps` count instead, which only closed the race by "a container or
// two" — a burst of near-simultaneous requests could all observe the same
// pre-reservation count and all proceed together, since none of them had
// actually claimed a slot yet.
//
// Reconciled against real Docker state at startup (reconcileWorkspaceReservations
// below) rather than trusting this to always start empty: a jarvis-builder
// restart doesn't destroy already-running sandbox containers, so starting
// this Set empty after a restart would let the cap be exceeded by however
// many requests arrive before the 24h reaper eventually catches up.
const reservedWorkspaceIds = new Set<number>();

// False until reconcileWorkspaceReservations() below completes successfully
// — createWorkspace() refuses everything while this is false. An
// undercounted reservation set (from a partially-failed reconciliation) is
// not "safely conservative," it's actively unsafe: it can admit MORE
// workspaces than the real number of already-existing containers should
// allow. Failing closed here, not open, matches how this file already
// treats other boot-time failures (see ensureSandboxImage's caller in
// server.ts) — a single-operator service where "block until a restart" is
// an acceptable response to Docker being unreachable at startup.
let reservationsReady = false;

export function areReservationsReady(): boolean {
  return reservationsReady;
}

export async function reconcileWorkspaceReservations(): Promise<void> {
  try {
    const { stdout } = await execFileAsync(
      "docker",
      ["ps", "-a", "--filter", "label=jarvis-sandbox=true", "--format", "{{.ID}}"],
      { timeout: 10_000 }
    );
    const ids = stdout.trim().split("\n").filter(Boolean);
    const results = await Promise.allSettled(
      ids.map(async (id) => {
        const { stdout: label } = await execFileAsync(
          "docker",
          ["inspect", "--format", '{{index .Config.Labels "jarvis-build-request-id"}}', id],
          { timeout: 10_000 }
        );
        const buildRequestId = Number(label.trim());
        // A missing/invalid label or a duplicate of one already seen must
        // also fail reconciliation, not just get silently skipped — either
        // one means a real container exists that this Set can't correctly
        // represent (a Set collapses two containers sharing one id into a
        // single reservation), which is exactly the kind of undercount that
        // would let the cap admit more than it should.
        if (!Number.isSafeInteger(buildRequestId) || buildRequestId <= 0) {
          throw new Error(`container ${id} has a missing/invalid jarvis-build-request-id label: ${JSON.stringify(label.trim())}`);
        }
        if (reservedWorkspaceIds.has(buildRequestId)) {
          throw new Error(`duplicate jarvis-build-request-id label ${buildRequestId} on container ${id}`);
        }
        reservedWorkspaceIds.add(buildRequestId);
      })
    );
    const failed = results.filter((r) => r.status === "rejected").length;
    if (failed > 0) {
      throw new Error(`${failed}/${ids.length} container inspections failed or had unusable/duplicate labels`);
    }
    reservationsReady = true;
  } catch (err: any) {
    console.error(
      `[jarvis-builder] Workspace reservation reconciliation failed: ${err.message}. ` +
        "Workspace creation is blocked until this succeeds — restart the service to retry."
    );
  }
}

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

export async function createWorkspace(buildRequestId: number, baseBranch: string): Promise<WorkspaceHandle> {
  assertSafeBranchName(baseBranch);

  if (!reservationsReady) {
    throw new WorkspaceCapacityError(
      "Refusing to create a new sandbox workspace: reservation reconciliation hasn't completed " +
        "(or failed) yet — check jarvis-builder's startup logs."
    );
  }

  // A second call for an id that's already reserved must be rejected
  // outright, before touching the Set at all — without this, two
  // overlapping createWorkspace calls for the same buildRequestId (e.g. an
  // upstream retry after builder-client.ts's own 30-minute request timeout
  // fires while the original call is actually still running server-side)
  // would both share one Set entry, since Set.add() on an already-present
  // value is a no-op. If either call's own attempt then failed, its catch
  // block below would delete that shared entry — releasing the reservation
  // for what might actually be the OTHER call's live, still-existing
  // workspace.
  if (reservedWorkspaceIds.has(buildRequestId)) {
    throw new WorkspaceCapacityError(
      `Refusing to create a new sandbox workspace: build request #${buildRequestId} already has one reserved or in progress.`
    );
  }

  // Checked and reserved before any git fetch/clone or disk work happens
  // below, so a request that's going to be refused doesn't first do several
  // seconds of wasted git/disk work only to fail at the docker run step —
  // and, more importantly, so two near-simultaneous requests can't both
  // observe room under the cap and both proceed (see reservedWorkspaceIds's
  // own comment above).
  if (reservedWorkspaceIds.size >= MAX_CONCURRENT_WORKSPACES) {
    throw new WorkspaceCapacityError(
      `Refusing to create a new sandbox workspace: ${reservedWorkspaceIds.size} already exist ` +
        `(limit ${MAX_CONCURRENT_WORKSPACES}, override with JARVIS_SANDBOX_MAX_CONCURRENT). ` +
        "Approve or reject a pending build request to free one up, or wait for the reaper."
    );
  }
  reservedWorkspaceIds.add(buildRequestId);

  // Declared outside the try block so the catch below can reference them
  // for cleanup of whatever got created before the failure.
  const dir = workspaceDir(buildRequestId);
  const stagingDir = `${dir}.staging`;
  const branch = branchName(buildRequestId);
  const container = containerName(buildRequestId);

  try {
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
    // Explicit timeouts below (matching the pattern already used for the
    // docker probe calls): without one, a hung `git fetch` against a
    // slow/unreachable remote, or a stuck `docker run`, would leave this
    // execFileAsync promise pending forever — neither the success return
    // nor the catch below would ever fire, so the reservation added above
    // would never be released. Enough stuck requests over time would
    // permanently exhaust MAX_CONCURRENT_WORKSPACES until a restart, the
    // exact failure mode this whole capacity design otherwise guards
    // against. `execFile`'s timeout option kills the child process
    // (SIGTERM) once elapsed, which reliably makes the promise reject.
    await execFileAsync("git", ["fetch", "origin", baseBranch], { cwd: REPO_HOST_PATH, timeout: 60_000 });

    // -B resets the branch to origin/baseBranch's current tip if it already
    // exists (e.g. a prior attempt for this same build request), rather than
    // failing outright.
    await execFileAsync("git", ["worktree", "add", "-B", branch, stagingDir, `origin/${baseBranch}`], {
      cwd: REPO_HOST_PATH,
      timeout: 30_000,
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
    await execFileAsync("git", ["clone", stagingDir, dir], { timeout: 60_000 });

    // The clone above is owned by whatever uid this (jarvis-builder) process
    // runs as (root) — the sandbox container below runs as its image's
    // built-in non-root `node` user (uid/gid 1000) instead, so without this
    // it couldn't write to its own bind-mounted workspace at all.
    await execFileAsync("chown", ["-R", "1000:1000", dir], { timeout: 30_000 });

    await execFileAsync("git", ["worktree", "remove", "--force", stagingDir], { cwd: REPO_HOST_PATH, timeout: 30_000 }).catch(() => {});
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
    await execFileAsync("git", ["branch", "-D", branch], { cwd: REPO_HOST_PATH, timeout: 30_000 }).catch(() => {});

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
      // exception per this feature's design spec, not an oversight.
      //
      // Investigated as part of a later security review (no --network flag
      // needed): no explicit --network is passed here, so this container
      // lands on Docker's plain default `bridge` network — a different,
      // non-routed network from `jarvis-os_default`, the compose-generated
      // network postgres/jarvis-builder/llama-cpp/whisper-cpp actually run
      // on (none of those publish a port to the host). Live-verified: a
      // container on the default bridge cannot reach jarvis-postgres at
      // all (connection times out). This is Compose-network isolation
      // specifically, not deployment-wide unreachability, though: `api`
      // and `tts` DO publish ports to the host (docker-compose.yml's
      // `ports:` entries), so they remain reachable from the default
      // bridge via the host's own gateway IP — live-verified the same way.
      // Reaching `api` this way still requires a valid X-API-Key the
      // sandbox has no way to obtain (it starts with a clean environment,
      // no credentials, by this same file's own design above), so this
      // isn't an open path to the main app, just a narrower isolation
      // boundary than "every other service" would suggest. Unrestricted
      // internet egress (DNS and raw IP both work fine) remains the one
      // risk still genuinely open. Closing that needs either --network
      // none (which breaks the npm/pip access above) or a real
      // allowlisting egress proxy — new infrastructure (a forward proxy, a
      // curated domain allowlist, careful verification that legitimate
      // coding-agent traffic still works) deliberately out of scope here,
      // not a flag this call can set safely on its own.
      //
      // What these cap-drop/security-opt/pids-limit flags remove is
      // privilege this "free reign" shell never legitimately needs
      // regardless of network policy: root-equivalent capabilities,
      // privilege escalation via setuid binaries, and an unbounded
      // process/fork count.
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges:true",
      "--pids-limit", "512",
      "--label", "jarvis-sandbox=true",
      "--label", `jarvis-build-request-id=${buildRequestId}`,
      "-v", `${dir}:/workspace`,
      "-w", "/workspace",
      SANDBOX_IMAGE,
      "sleep", "infinity",
    ], { timeout: 30_000 });

    return { buildRequestId, branch, containerName: container };
  } catch (err) {
    // A failure anywhere above can still have left real on-disk artifacts
    // behind — the clone directory, the registered staging worktree, or
    // the scaffolding branch created for it — none of which should stick
    // around for a failed attempt the way they do for the happy path
    // (which needs the clone). Left in place, a retry for the same
    // buildRequestId would fail immediately at `git worktree add`/
    // `git clone` because the destination already exists, permanently
    // wedging that build request until someone manually clears the
    // directory. Each is independently best-effort (`.catch(() => {})`):
    // none of these existing is itself an error worth reporting over the
    // original failure, and `rm -rf`/`git worktree remove` on a path that
    // was never created is already a safe no-op regardless of how far
    // creation got before failing.
    await execFileAsync("git", ["worktree", "remove", "--force", stagingDir], { cwd: REPO_HOST_PATH, timeout: 30_000 }).catch(() => {});
    await execFileAsync("git", ["branch", "-D", branch], { cwd: REPO_HOST_PATH, timeout: 30_000 }).catch(() => {});
    await execFileAsync("rm", ["-rf", stagingDir], { timeout: 30_000 }).catch(() => {});

    // docker run's own 30s timeout above only SIGTERMs the CLI process —
    // it doesn't guarantee the daemon aborted an in-flight create/start.
    // Under exactly the kind of daemon contention a burst of concurrent
    // createWorkspace calls (up to MAX_CONCURRENT_WORKSPACES) could cause,
    // a real container can end up running server-side even though this
    // promise rejected. Confirm it's actually gone (or never existed)
    // before touching the bind-mounted directory OR releasing the
    // reservation — same rule destroyWorkspace/the reaper already follow.
    // An orphaned-but-real container should stay counted against the cap
    // (undercounting it here would be the exact bug already fixed
    // elsewhere in this file) rather than be silently forgotten; the
    // reaper's own age-based pass operates on real `docker ps` state
    // directly; it'll find and clean this container up once it's old
    // enough regardless of what this function believed happened.
    const removed = await removeContainerConfirmed(container);
    if (removed) {
      await execFileAsync("rm", ["-rf", dir], { timeout: 30_000 }).catch(() => {});
      reservedWorkspaceIds.delete(buildRequestId);
    } else {
      console.error(
        `[jarvis-builder] createWorkspace for build request #${buildRequestId} failed, but its container ` +
          "may have been created anyway (docker run's own timeout doesn't guarantee the daemon aborted) — " +
          "keeping its reservation and workspace directory intact; the reaper will find and remove it once it's old enough."
      );
    }
    throw err;
  }
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

// Only reports success if the container is actually confirmed gone —
// swallowing `docker rm -f`'s error unconditionally (the previous version)
// would still release a build request's reservation even if removal
// genuinely failed (a Docker daemon hiccup, a permission issue), leaving a
// container that may still be running uncounted against the cap. "No such
// container" is Docker's own long-stable wording for "it already doesn't
// exist" — the one failure mode that's still safe to treat as removed,
// since destroyWorkspace is deliberately called defensively more than once
// for the same id by several call sites in the main app.
async function removeContainerConfirmed(nameOrId: string): Promise<boolean> {
  try {
    await execFileAsync("docker", ["rm", "-f", nameOrId], { timeout: 10_000 });
    return true;
  } catch (err: any) {
    return String(err?.stderr || err?.message || "").includes("No such container");
  }
}

export async function destroyWorkspace(buildRequestId: number): Promise<void> {
  const dir = workspaceDir(buildRequestId);
  const container = containerName(buildRequestId);

  const removed = await removeContainerConfirmed(container);
  if (removed) {
    // `dir` is a plain `git clone`, not a registered worktree of
    // REPO_HOST_PATH, so `git worktree remove` doesn't apply here — a plain
    // recursive delete is all that's needed to reclaim the disk. `worktree
    // prune` below is still useful as a safety net for any staging worktree
    // (see createWorkspace) that failed to clean up. Gated on `removed`:
    // `dir` is bind-mounted into the container at /workspace — if removal
    // genuinely failed (not just "already gone"), the container might
    // still be alive and using that directory, and deleting it out from
    // under a live container would corrupt its filesystem rather than
    // just misaccount a reservation.
    await execFileAsync("rm", ["-rf", dir]).catch(() => {});
    await execFileAsync("git", ["worktree", "prune"], { cwd: REPO_HOST_PATH }).catch(() => {});
    // Idempotent (Set.delete on an absent id is a harmless no-op), so this
    // is safe even though several call sites in the main app call
    // destroyWorkspace defensively more than once for the same id.
    reservedWorkspaceIds.delete(buildRequestId);
  } else {
    console.error(
      `[jarvis-builder] Failed to remove container ${container} for build request #${buildRequestId} — ` +
        "keeping its reservation and workspace directory intact, since the container may still be alive and using it."
    );
  }
}

export function startReaper(): void {
  setInterval(async () => {
    try {
      const { stdout } = await execFileAsync(
        "docker",
        ["ps", "-a", "--filter", "label=jarvis-sandbox=true", "--format", "{{.ID}}"],
        { timeout: 10_000 }
      );
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
            const { stdout: inspected } = await execFileAsync(
              "docker",
              ["inspect", "--format", '{{.Created}} {{index .Config.Labels "jarvis-build-request-id"}}', id],
              { timeout: 10_000 }
            );
            const [createdAt, buildRequestId] = inspected.trim().split(/\s+/);
            const createdMs = Date.parse((createdAt || "").trim());
            if (!isNaN(createdMs) && now - createdMs > MAX_CONTAINER_LIFETIME_MS) {
              const removed = await removeContainerConfirmed(id);
              // Only ever derived from the label, and only when it's a plain
              // integer — never an arbitrary string interpolated into a path.
              if (buildRequestId && /^\d+$/.test(buildRequestId)) {
                if (removed) {
                  // Gated on `removed`, same reasoning as destroyWorkspace:
                  // this directory is bind-mounted into the container, so
                  // deleting it while removal is unconfirmed risks
                  // corrupting a container that might still be alive.
                  await execFileAsync("rm", ["-rf", workspaceDir(Number(buildRequestId))]).catch(() => {});
                  reservedWorkspaceIds.delete(Number(buildRequestId));
                }
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
