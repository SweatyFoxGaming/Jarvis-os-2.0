# Agentic Coding Department — jarvis-builder Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the foundational infrastructure for Jarvis's agentic coding department — a new, minimal `jarvis-builder` service that holds the only Docker-socket access in the stack, and can create, run commands in, and destroy an isolated per-build-request sandbox (a git worktree bind-mounted into a resource-bounded, network-scoped Docker container).

**Architecture:** A new sibling top-level project (`jarvis-builder/`, alongside the existing `desktop-electron/`) with its own `package.json`/`Dockerfile`, exposing a narrow internal-only HTTP API (create/exec/destroy a workspace) gated by a shared secret, reachable only from `jarvis-os-api` over the internal Docker network. A second, trivial Dockerfile (`sandbox.Dockerfile`) defines the image used for the ephemeral per-build-request sandbox containers themselves. A new client module in the main app (`src/kernel/builder-client.ts`) wraps calls to this service. This plan is infrastructure only — no LLM/agentic loop yet; that's a later plan, per this feature's design spec.

**Tech Stack:** Express + `tsx` (mirroring the main app's own pattern), Node's `child_process` for `git`/`docker` CLI invocations (no new Docker-client npm dependency — consistent with this codebase's existing preference for plain, dependency-free integrations), Docker Compose.

## Global Constraints

- `jarvis-builder` is the *only* service in this stack with `/var/run/docker.sock` access. Neither `jarvis-os-api` nor any per-build-request sandbox container ever gets it. No privileged containers, no host-escape-capable configuration, anywhere.
- `jarvis-builder` contains no LLM/chat/business logic — only workspace (worktree + sandbox container) lifecycle. Keeping its own code surface small is the point, given the privilege it holds.
- `jarvis-builder`'s repo bind-mount must use the *identical* path on both sides (`${JARVIS_REPO_HOST_PATH}:${JARVIS_REPO_HOST_PATH}`), not remapped like `api`'s `.:/app` — Docker always resolves `-v` bind-mount sources against the real host filesystem, never the calling container's own view of a path, so a mismatched path here would make every sandbox container fail to start.
- Every non-health-check route on `jarvis-builder` requires the `X-Builder-Secret` header to match `JARVIS_BUILDER_SECRET` — a deliberate second layer beyond "only reachable on the internal Docker network."
- Each sandbox container is resource-bounded (`--cpus 1 --memory 1g`) and labeled (`jarvis-sandbox=true`, `jarvis-build-request-id=<id>`) so a background reaper can find and force-remove anything left running past a safety-net lifetime, independent of whatever the (later, separate) agentic loop's own timeout logic does.
- `npm test`/`npx tsc --noEmit` in the main repo must stay green after every task (this plan adds one new sibling project, `jarvis-builder/`, with its own independent `tsc`/test story — it is not part of the main repo's `npm test` run).

---

### Task 1: Scaffold the `jarvis-builder` service

**Files:**
- Create: `jarvis-builder/package.json`
- Create: `jarvis-builder/tsconfig.json`
- Create: `jarvis-builder/server.ts`
- Create: `jarvis-builder/Dockerfile`

**Interfaces:**
- Produces: a runnable Express app listening on port 4100, with a `GET /health` route (no auth) and a shared-secret auth middleware applied to everything else — Task 3 adds the actual workspace routes behind that middleware.

- [ ] **Step 1: Create `jarvis-builder/package.json`**

```bash
mkdir -p jarvis-builder
```

```json
{
  "name": "jarvis-builder",
  "version": "1.0.0",
  "description": "Minimal internal service holding the only Docker-socket access in this stack — creates, execs into, and destroys per-build-request sandbox containers for the agentic coding department. No LLM/chat/business logic lives here, on purpose: the smaller this service's own code surface, the smaller the blast radius of the one thing in this stack that can control the host's Docker daemon.",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "tsx server.ts",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "express": "^4.19.2"
  },
  "devDependencies": {
    "tsx": "^4.23.1",
    "typescript": "^5.6.0",
    "@types/express": "^4.17.21",
    "@types/node": "^20.14.0"
  }
}
```

- [ ] **Step 2: Create `jarvis-builder/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true
  }
}
```

- [ ] **Step 3: Create `jarvis-builder/server.ts` — health check + auth middleware only for now**

```typescript
import express from "express";

const app = express();
app.use(express.json());

const SECRET = process.env.JARVIS_BUILDER_SECRET;
if (!SECRET || SECRET.length < 16) {
  console.error("[jarvis-builder] JARVIS_BUILDER_SECRET is not set (or too short) — refusing to start.");
  process.exit(1);
}

// Every route below this line requires the shared secret — this service
// sits on the internal Docker network only (never published to the host),
// but the secret is a deliberate second layer: this is the one process in
// the whole stack with access to the host's Docker socket, so it doesn't
// get to rely on network placement alone.
app.use((req, res, next) => {
  if (req.path === "/health") return next();
  const provided = req.headers["x-builder-secret"];
  if (provided !== SECRET) {
    return res.status(401).json({ error: "Missing or invalid X-Builder-Secret header." });
  }
  next();
});

app.get("/health", (_req, res) => {
  res.json({ status: "up" });
});

const PORT = 4100;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`[jarvis-builder] listening on port ${PORT}`);
});
```

- [ ] **Step 4: Create `jarvis-builder/Dockerfile`**

```dockerfile
FROM node:20-alpine

# git: for workspace.ts's `git worktree` calls (Task 2).
# docker-cli: for its `docker run`/`exec`/`rm` calls — talks to the socket
# bind-mounted in via docker-compose.yml (Task 4), not a nested daemon.
RUN apk add --no-cache git docker-cli bash

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

CMD ["npm", "start"]
```

- [ ] **Step 5: Install dependencies and verify the app starts**

Run: `cd jarvis-builder && npm install`
Expected: installs cleanly, no errors.

Run: `cd jarvis-builder && npx tsc --noEmit`
Expected: no errors.

Run (manual, requires a terminal): `cd jarvis-builder && JARVIS_BUILDER_SECRET=$(openssl rand -hex 32) npm start`
Expected: prints `[jarvis-builder] listening on port 4100` and doesn't exit. In another terminal, `curl -s http://localhost:4100/health` returns `{"status":"up"}`; `curl -s http://localhost:4100/workspaces` (no route yet, but no auth header either) returns a 401 from the auth middleware, not a 404 — confirming the middleware runs before route matching for anything past `/health`. Stop the process (Ctrl-C) once confirmed.

- [ ] **Step 6: Commit**

```bash
git add jarvis-builder/package.json jarvis-builder/tsconfig.json jarvis-builder/server.ts jarvis-builder/Dockerfile
git commit -m "feat: scaffold the jarvis-builder service (health check + shared-secret auth)"
```

---

### Task 2: Sandbox image and workspace lifecycle logic

**Files:**
- Create: `jarvis-builder/sandbox.Dockerfile`
- Create: `jarvis-builder/workspace.ts`

**Interfaces:**
- Consumes: `JARVIS_REPO_HOST_PATH` env var (falls back to `/mnt/jarvis_home/llm` if unset).
- Produces: `createWorkspace(buildRequestId, baseBranch): Promise<WorkspaceHandle>`, `execInWorkspace(buildRequestId, command): Promise<{stdout, stderr, exitCode}>`, `destroyWorkspace(buildRequestId): Promise<void>`, `ensureSandboxImage(): Promise<void>`, `startReaper(): void` — Task 3's routes call the first three directly; Task 3's server startup calls `ensureSandboxImage`/`startReaper` once.

- [ ] **Step 1: Create `jarvis-builder/sandbox.Dockerfile`**

This is the image used for every per-build-request sandbox container — deliberately minimal (Node + git + bash; `npm`/`npx` already ship with the Node base image). No app code is copied into it; the actual repository content arrives entirely via the bind-mounted worktree at `/workspace`.

```dockerfile
FROM node:20-alpine

RUN apk add --no-cache git bash

WORKDIR /workspace
```

- [ ] **Step 2: Create `jarvis-builder/workspace.ts`**

```typescript
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
```

- [ ] **Step 3: Typecheck**

Run: `cd jarvis-builder && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add jarvis-builder/sandbox.Dockerfile jarvis-builder/workspace.ts
git commit -m "feat: add sandbox image and workspace (worktree + container) lifecycle logic"
```

---

### Task 3: Wire the workspace routes into the server

**Files:**
- Modify: `jarvis-builder/server.ts`

**Interfaces:**
- Consumes: `createWorkspace`, `execInWorkspace`, `destroyWorkspace`, `ensureSandboxImage`, `startReaper` (from Task 2).
- Produces: `POST /workspaces`, `POST /workspaces/:id/exec`, `DELETE /workspaces/:id` — Task 5's client module (in the main app) calls these.

- [ ] **Step 1: Add the three routes and startup calls**

In `jarvis-builder/server.ts`, this section currently reads:

```typescript
app.get("/health", (_req, res) => {
  res.json({ status: "up" });
});

const PORT = 4100;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`[jarvis-builder] listening on port ${PORT}`);
});
```

Replace it with:

```typescript
app.get("/health", (_req, res) => {
  res.json({ status: "up" });
});

app.post("/workspaces", async (req, res) => {
  const { buildRequestId, baseBranch } = req.body || {};
  if (typeof buildRequestId !== "number" || !Number.isInteger(buildRequestId) || buildRequestId <= 0) {
    return res.status(400).json({ error: "buildRequestId must be a positive integer." });
  }
  if (typeof baseBranch !== "string" || !baseBranch.trim()) {
    return res.status(400).json({ error: "baseBranch is required." });
  }
  try {
    const workspace = await createWorkspace(buildRequestId, baseBranch.trim());
    res.json(workspace);
  } catch (err: any) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

app.post("/workspaces/:id/exec", async (req, res) => {
  const buildRequestId = Number(req.params.id);
  const { command } = req.body || {};
  if (!Number.isInteger(buildRequestId) || buildRequestId <= 0) {
    return res.status(400).json({ error: "Invalid workspace id." });
  }
  if (typeof command !== "string" || !command.trim()) {
    return res.status(400).json({ error: "command is required." });
  }
  try {
    const result = await execInWorkspace(buildRequestId, command);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

app.delete("/workspaces/:id", async (req, res) => {
  const buildRequestId = Number(req.params.id);
  if (!Number.isInteger(buildRequestId) || buildRequestId <= 0) {
    return res.status(400).json({ error: "Invalid workspace id." });
  }
  try {
    await destroyWorkspace(buildRequestId);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

const PORT = 4100;
app.listen(PORT, "0.0.0.0", async () => {
  console.log(`[jarvis-builder] listening on port ${PORT}`);
  await ensureSandboxImage();
  startReaper();
});
```

Also add the import at the top of the file, right after `import express from "express";`:

```typescript
import { createWorkspace, execInWorkspace, destroyWorkspace, ensureSandboxImage, startReaper } from "./workspace.js";
```

- [ ] **Step 2: Typecheck**

Run: `cd jarvis-builder && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add jarvis-builder/server.ts
git commit -m "feat: wire workspace create/exec/destroy routes into jarvis-builder"
```

---

### Task 4: Wire `jarvis-builder` into docker-compose and `.env`

**Files:**
- Modify: `docker-compose.yml`
- Modify: `.env.example`

**Interfaces:**
- Produces: a running `jarvis-builder` container reachable from `api` at `http://jarvis-builder:4100`, and the `JARVIS_BUILDER_SECRET`/`JARVIS_REPO_HOST_PATH` env vars documented for the user to set.

- [ ] **Step 1: Add the `jarvis-builder` service to `docker-compose.yml`**

In `docker-compose.yml`, add this new service after the existing `tts` service (at the end of the file):

```yaml
  # The only service in this stack with access to the host's Docker
  # socket — see docs/superpowers/specs/2026-07-24-agentic-coding-department-design.md
  # for why this is split out from the main api service instead of
  # mounting the socket there directly. Deliberately has no LLM/chat/
  # business logic of its own: it only creates, execs into, and destroys
  # per-build-request sandbox containers on api's behalf, over an
  # internal-only API gated by JARVIS_BUILDER_SECRET.
  jarvis-builder:
    build:
      context: ./jarvis-builder
      dockerfile: Dockerfile
    container_name: jarvis-builder
    environment:
      - JARVIS_BUILDER_SECRET=${JARVIS_BUILDER_SECRET}
      - JARVIS_REPO_HOST_PATH=${JARVIS_REPO_HOST_PATH:-/mnt/jarvis_home/llm}
    volumes:
      # Mounted at the SAME path it has on the real host, not remapped
      # (unlike api's `.:/app`) — see this plan's Global Constraints.
      - ${JARVIS_REPO_HOST_PATH:-/mnt/jarvis_home/llm}:${JARVIS_REPO_HOST_PATH:-/mnt/jarvis_home/llm}
      - /var/run/docker.sock:/var/run/docker.sock
    # No ports: — never published to the host or reachable outside this
    # compose network. api reaches it at http://jarvis-builder:4100.
    restart: unless-stopped
```

Then add `jarvis-builder` to the `api` service's existing `depends_on` list (currently `postgres`, `tts`, `llama-cpp`, `whisper-cpp`):

```yaml
    depends_on:
      - postgres
      - tts
      - llama-cpp
      - whisper-cpp
      - jarvis-builder
```

- [ ] **Step 2: Document the new env vars in `.env.example`**

Add this block to `.env.example`, right after the existing `# ---------- Files/Notes ----------` section (find it via `grep -n "Files/Notes" .env.example`):

```
# ---------- Jarvis Builder (sandboxed coding agent execution) ----------
# Shared secret between the api and jarvis-builder services — jarvis-builder
# holds the only Docker-socket access in this stack (see
# docs/superpowers/specs/2026-07-24-agentic-coding-department-design.md),
# so this header check is a deliberate second layer beyond "only reachable
# on the internal Docker network."
# Generate one with: openssl rand -hex 32
JARVIS_BUILDER_SECRET=

# Real host filesystem path to this repo checkout — must match exactly,
# not a container-remapped path, so jarvis-builder can tell the HOST's
# Docker daemon to bind-mount subdirectories of this same repo into new
# sandbox containers (Docker always resolves bind-mount sources against
# the host, never the calling container's own view of the path).
JARVIS_REPO_HOST_PATH=/mnt/jarvis_home/llm
```

- [ ] **Step 3: Manually verify the full stack brings `jarvis-builder` up**

This requires `JARVIS_BUILDER_SECRET` set in a real `.env` (not the production one — verify against a scratch/isolated compose project, same precedent as every other live-stack verification in this codebase):

```bash
docker compose -p jarvis-builder-verify up -d --build jarvis-builder
sleep 5
docker exec jarvis-builder-verify-api-1 curl -s http://jarvis-builder:4100/health 2>&1 || \
  docker run --rm --network jarvis-builder-verify_default curlimages/curl -s http://jarvis-builder:4100/health
```

Expected: `{"status":"up"}`. Then confirm `docker inspect jarvis-builder --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{"\n"}}{{end}}'` shows the repo path mounted identically on both sides and `/var/run/docker.sock` mounted.

- [ ] **Step 4: Commit**

```bash
git add docker-compose.yml .env.example
git commit -m "feat: wire jarvis-builder into docker-compose"
```

---

### Task 5: Client module in the main app

**Files:**
- Create: `src/kernel/builder-client.ts`

**Interfaces:**
- Consumes: `JARVIS_BUILDER_SECRET` env var (already added to `.env.example` in Task 4) — the main `api` container gets this via its existing `env_file: .env` directive, no docker-compose change needed for `api` itself.
- Produces: `createWorkspace(buildRequestId, baseBranch): Promise<WorkspaceHandle>`, `execInWorkspace(buildRequestId, command): Promise<{stdout, stderr, exitCode}>`, `destroyWorkspace(buildRequestId): Promise<void>` — the (separate, later) agentic-loop plan calls these; no other task in this plan depends on this file.

- [ ] **Step 1: Create `src/kernel/builder-client.ts`**

```typescript
import { ObservationPlatform } from "./observation.js";

const observation = ObservationPlatform.getInstance();
const BUILDER_URL = "http://jarvis-builder:4100";

export class BuilderClientError extends Error {
  constructor(message: string, public status = 500) {
    super(message);
  }
}

function getSecret(): string {
  const secret = process.env.JARVIS_BUILDER_SECRET;
  if (!secret) {
    throw new BuilderClientError(
      "JARVIS_BUILDER_SECRET is not set — the sandboxed coding agent is unavailable.",
      503
    );
  }
  return secret;
}

async function builderRequest(path: string, init: RequestInit = {}): Promise<any> {
  const secret = getSecret();
  const res = await fetch(`${BUILDER_URL}${path}`, {
    ...init,
    headers: {
      "X-Builder-Secret": secret,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    observation.logTelemetry(
      "warn",
      "Executive",
      `jarvis-builder request failed: ${init.method || "GET"} ${path} -> ${res.status} ${body}`
    );
    throw new BuilderClientError(`jarvis-builder error (${res.status}): ${body}`, res.status);
  }
  return res.json();
}

export interface WorkspaceHandle {
  buildRequestId: number;
  branch: string;
  containerName: string;
}

export async function createWorkspace(buildRequestId: number, baseBranch: string): Promise<WorkspaceHandle> {
  return builderRequest("/workspaces", {
    method: "POST",
    body: JSON.stringify({ buildRequestId, baseBranch }),
  });
}

export async function execInWorkspace(
  buildRequestId: number,
  command: string
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return builderRequest(`/workspaces/${buildRequestId}/exec`, {
    method: "POST",
    body: JSON.stringify({ command }),
  });
}

export async function destroyWorkspace(buildRequestId: number): Promise<void> {
  await builderRequest(`/workspaces/${buildRequestId}`, { method: "DELETE" });
}
```

- [ ] **Step 2: Run the main repo's test suite and typecheck**

Run: `npm test`
Expected: unchanged pass count (this task adds a new file with no existing test coverage expectation — external-network-dependent providers in this codebase, e.g. `github.ts`/`websearch.ts`, have no unit tests either; this module is verified end-to-end manually instead).

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Manually verify end-to-end against the scratch stack from Task 4**

With the scratch `jarvis-builder-verify` stack from Task 4's Step 3 still running, and `JARVIS_BUILDER_SECRET` available to a local Node process (not the main api container, to keep this a fast, isolated check):

```bash
cd /path/to/repo
JARVIS_BUILDER_SECRET=<same secret used in Task 4> npx tsx -e '
import("./src/kernel/builder-client.js").then(async (bc) => {
  const ws = await bc.createWorkspace(99999, "main");
  console.log("created:", ws);
  const result = await bc.execInWorkspace(99999, "echo hello from sandbox && pwd && git log -1 --oneline");
  console.log("exec result:", result);
  await bc.destroyWorkspace(99999);
  console.log("destroyed");
});
'
```

Expected: `created:` shows a handle with `containerName: "jarvis-sandbox-br-99999"`; `exec result:` shows `stdout` containing `hello from sandbox`, `/workspace`, and a real commit line, `exitCode: 0`; `destroyed` prints with no error. Confirm afterward that `docker ps -a --filter name=jarvis-sandbox-br-99999` shows nothing (container removed) and `git worktree list` (run on the host, from the real repo) no longer lists `br-99999`.

- [ ] **Step 4: Commit**

```bash
git add src/kernel/builder-client.ts
git commit -m "feat: add the main app's jarvis-builder client module"
```

---

## Final Verification

- `npm test` (main repo) — full suite green, no regressions from before this plan.
- `npx tsc --noEmit` (main repo) — no errors.
- `cd jarvis-builder && npx tsc --noEmit` — no errors.
- Task 4 Step 3 and Task 5 Step 3's manual end-to-end checks both pass against a real running (scratch, not production) stack: `jarvis-builder` comes up healthy, and a full create → exec → destroy cycle works and leaves no residue (no lingering container, no lingering worktree).
- This plan is infrastructure only. It does not yet change how build requests actually get coded — `autonomous_executive.ts` still calls the existing `draftCodeChanges`/`reviewCodeDiff`. Wiring the real agentic loop through this new `jarvis-builder`/`builder-client.ts` infrastructure, adding the execution transcript, and changing what happens on approval are separate, later plans per this feature's design spec.
