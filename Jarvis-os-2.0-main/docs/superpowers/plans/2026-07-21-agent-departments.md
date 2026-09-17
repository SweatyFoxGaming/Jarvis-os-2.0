# Agent Departments (Research / Coding / QA) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Research, Coding, and QA "specialist swarm" stages in `src/execution/autonomous_executive.ts` real instead of narrated — real web/repo/knowledge research, real drafted code proposed as a GitHub pull request only after two separate human checkpoints (confirm direction, then approve the code), and a real QA review of the diff once the PR opens.

**Architecture:** `decompose_plan` (unchanged entry point) now tags each decomposed step with a department. An objective with a `coding` step creates a new `build_requests` row and branches into a multi-phase, human-paced lifecycle (research → consult → confirm direction → draft code → approve → PR opens → QA); an objective without one just gets real research instead of narration, same shape as today. Three new real routines live in a new `src/execution/departments.ts`, kept separate from the orchestrator in `autonomous_executive.ts`.

**Tech Stack:** TypeScript, `@google/genai` structured JSON output (`responseSchema`), Postgres, the GitHub REST API via the existing `src/integrations/github.ts` (no new dependency), the existing hand-rolled `tests/index.test.ts` harness.

## Global Constraints

- **No new dependency.** Everything here uses libraries already in `package.json`.
- **Coding is scoped to this repository only.** The target repo is read from two new env vars, `SELF_REPO_OWNER`/`SELF_REPO_NAME` — never a model-supplied argument.
- `build_requests` is a brand-new table — a plain `CREATE TABLE IF NOT EXISTS` is sufficient, no `ALTER TABLE` needed (unlike `command_proposals`'s live-table migration in an earlier phase).
- **Two separate human checkpoints, never collapsed into one:** confirming direction (`confirm_build_direction`, gated by `executive.plan`) only drafts code and stores it — nothing reaches GitHub until a second, separate approval (`POST .../approve-code`, gated by `github.pulls.create`) is given.
- Every repo function except the one genuine "no sensible fallback" write (`createBuildRequest`) must degrade to a safe value (never throw past its own boundary) on failure — matching `src/data/mcp-servers-repo.ts`'s pattern exactly (the most recently reviewed and praised repo file in this codebase).
- Research and code-drafting both require a real AI client. There is no "dumb local fallback" for drafting real code — if `ai` is `null` or `kernel.offlineMode` is on, these steps report that plainly rather than attempting something unreviewed.
- The approve-code route's GitHub calls (branch → commit each file → open PR) must never silently report success on a partial failure — each failure mode records exactly which step failed via `error_detail`, never leaves the row claiming a status it didn't actually reach.
- Jarvis never pushes to the repo's default branch and never merges anything — a PR is the ceiling of what this feature does unattended.
- `confirm_build_direction` takes **no id parameter** — it resolves against the caller's own most recent `awaiting_consult` build request server-side, not a model-recalled numeric id (see the design spec's "Decisions" section for why).
- Match existing code style exactly: `src/data/mcp-servers-repo.ts` for the repo layer's degrade-safety shape, `src/cognition/identity.ts`/`src/cognition/knowledge-graph.ts` for structured-JSON Gemini calls (`responseMimeType: "application/json"` + `responseSchema`), `src/execution/tools.ts`'s existing `propose_command`/`decompose_plan` cases for the tool layer, `src/server.ts`'s `mcp-servers/:id/approve` route for the admin-route shape.

---

### Task 1: Schema + `build-requests-repo.ts`

**Files:**
- Modify: `src/data/db.ts` (add the `build_requests` table)
- Create: `src/data/build-requests-repo.ts`
- Test: `tests/index.test.ts`

**Interfaces:**
- Produces: `BuildRequestStatus` type, `DraftedFile` interface (`{ path: string; content: string }`), `BuildRequestRow` interface, and: `createBuildRequest(objective, requestedBy): Promise<BuildRequestRow>`, `getBuildRequest(id): Promise<BuildRequestRow | null>`, `getLatestAwaitingConsult(username): Promise<BuildRequestRow | null>`, `listBuildRequests(status?): Promise<BuildRequestRow[]>`, `recordResearch(id, researchSummary): Promise<BuildRequestRow | null>`, `markResearchError(id, errorDetail): Promise<void>`, `recordDirectionConfirmed(id, directionNotes): Promise<BuildRequestRow | null>`, `markCoding(id): Promise<void>`, `recordCodeDraft(id, codeSummary, files): Promise<BuildRequestRow | null>`, `markCodeDraftError(id, errorDetail): Promise<void>`, `rejectCode(id): Promise<BuildRequestRow | null>`, `recordPrOpened(id, prUrl, prNumber): Promise<BuildRequestRow | null>`, `markPrError(id, errorDetail): Promise<void>`, `recordQaReview(id, qaSummary): Promise<void>` — all exported from `src/data/build-requests-repo.ts`. Task 4's orchestrator and Task 5's routes call these by name.

- [ ] **Step 1: Add the `build_requests` table**

In `src/data/db.ts`, find `createSchema()` and add this block right after the `mcp_servers` table/index statements (after the line `await db.query(\`CREATE INDEX IF NOT EXISTS mcp_servers_status_idx ...\`);` added in the prior phase):

```ts
  await db.query(`
    CREATE TABLE IF NOT EXISTS build_requests (
      id SERIAL PRIMARY KEY,
      objective TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'researching',
      requested_by TEXT NOT NULL,
      research_summary TEXT,
      direction_notes TEXT,
      code_summary TEXT,
      proposed_files JSONB,
      pr_url TEXT,
      pr_number INTEGER,
      qa_summary TEXT,
      error_detail TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS build_requests_status_idx ON build_requests(status);`);
  await db.query(`CREATE INDEX IF NOT EXISTS build_requests_requested_by_idx ON build_requests(requested_by, status);`);
```

This is a brand-new table — no `ALTER TABLE` needed.

- [ ] **Step 2: Create the repo file**

Create `src/data/build-requests-repo.ts`:

```ts
import { getPool } from "./db.js";

export type BuildRequestStatus =
  | "researching"
  | "awaiting_consult"
  | "direction_confirmed"
  | "coding"
  | "awaiting_code_approval"
  | "pr_opened"
  | "qa_complete"
  | "rejected_at_code"
  | "error";

export interface DraftedFile {
  path: string;
  content: string;
}

export interface BuildRequestRow {
  id: number;
  objective: string;
  status: BuildRequestStatus;
  requested_by: string;
  research_summary: string | null;
  direction_notes: string | null;
  code_summary: string | null;
  proposed_files: DraftedFile[] | null;
  pr_url: string | null;
  pr_number: number | null;
  qa_summary: string | null;
  error_detail: string | null;
  created_at: Date;
  updated_at: Date;
}

// A genuine write with no sensible fallback value — allowed to reject,
// same reasoning as proposeMcpServer/addCommandProposal in earlier phases.
export async function createBuildRequest(objective: string, requestedBy: string): Promise<BuildRequestRow> {
  const db = getPool();
  const { rows } = await db.query(
    `INSERT INTO build_requests (objective, requested_by) VALUES ($1, $2) RETURNING *`,
    [objective, requestedBy]
  );
  return rows[0];
}

export async function getBuildRequest(id: number): Promise<BuildRequestRow | null> {
  try {
    const db = getPool();
    const { rows } = await db.query(`SELECT * FROM build_requests WHERE id = $1`, [id]);
    return rows[0] || null;
  } catch {
    return null;
  }
}

// confirm_build_direction (Task 4) resolves against this instead of a
// model-recalled numeric id — see this plan's Global Constraints and the
// design spec's "Decisions" section for why.
export async function getLatestAwaitingConsult(username: string): Promise<BuildRequestRow | null> {
  try {
    const db = getPool();
    const { rows } = await db.query(
      `SELECT * FROM build_requests WHERE requested_by = $1 AND status = 'awaiting_consult' ORDER BY created_at DESC LIMIT 1`,
      [username]
    );
    return rows[0] || null;
  } catch {
    return null;
  }
}

export async function listBuildRequests(status?: BuildRequestStatus): Promise<BuildRequestRow[]> {
  try {
    const db = getPool();
    if (status) {
      const { rows } = await db.query(`SELECT * FROM build_requests WHERE status = $1 ORDER BY created_at DESC`, [status]);
      return rows;
    }
    const { rows } = await db.query(`SELECT * FROM build_requests ORDER BY created_at DESC`);
    return rows;
  } catch {
    return [];
  }
}

export async function recordResearch(id: number, researchSummary: string): Promise<BuildRequestRow | null> {
  try {
    const db = getPool();
    const { rows } = await db.query(
      `UPDATE build_requests SET research_summary = $1, status = 'awaiting_consult', updated_at = now()
       WHERE id = $2 AND status = 'researching' RETURNING *`,
      [researchSummary, id]
    );
    return rows[0] || null;
  } catch {
    return null;
  }
}

export async function markResearchError(id: number, errorDetail: string): Promise<void> {
  try {
    const db = getPool();
    await db.query(
      `UPDATE build_requests SET status = 'error', error_detail = $1, updated_at = now() WHERE id = $2 AND status = 'researching'`,
      [errorDetail, id]
    );
  } catch {
    // Best-effort — a failed error-log write is not itself worth crashing over.
  }
}

// Named distinctly from AutonomousExecutive.confirmDirection (Task 4) —
// that class method is the orchestrator; this is only the persistence step
// it calls partway through, and sharing a name would be genuinely confusing
// to read even though it's technically unambiguous TypeScript.
export async function recordDirectionConfirmed(id: number, directionNotes: string): Promise<BuildRequestRow | null> {
  try {
    const db = getPool();
    const { rows } = await db.query(
      `UPDATE build_requests SET direction_notes = $1, status = 'direction_confirmed', updated_at = now()
       WHERE id = $2 AND status = 'awaiting_consult' RETURNING *`,
      [directionNotes, id]
    );
    return rows[0] || null;
  } catch {
    return null;
  }
}

// A visibility marker set the moment code-drafting starts (before its
// Gemini call), so a hung/failed draft is visibly "stuck in coding" rather
// than ambiguously stuck at 'direction_confirmed' — see the design spec's
// data model section for the full reasoning.
export async function markCoding(id: number): Promise<void> {
  try {
    const db = getPool();
    await db.query(`UPDATE build_requests SET status = 'coding', updated_at = now() WHERE id = $1 AND status = 'direction_confirmed'`, [id]);
  } catch {
    // Best-effort — a failed write here doesn't block drafting itself.
  }
}

export async function recordCodeDraft(id: number, codeSummary: string, files: DraftedFile[]): Promise<BuildRequestRow | null> {
  try {
    const db = getPool();
    const { rows } = await db.query(
      `UPDATE build_requests SET code_summary = $1, proposed_files = $2, status = 'awaiting_code_approval', updated_at = now()
       WHERE id = $3 AND status = 'coding' RETURNING *`,
      [codeSummary, JSON.stringify(files), id]
    );
    return rows[0] || null;
  } catch {
    return null;
  }
}

export async function markCodeDraftError(id: number, errorDetail: string): Promise<void> {
  try {
    const db = getPool();
    await db.query(
      `UPDATE build_requests SET status = 'error', error_detail = $1, updated_at = now() WHERE id = $2 AND status = 'coding'`,
      [errorDetail, id]
    );
  } catch {
    // Best-effort.
  }
}

export async function rejectCode(id: number): Promise<BuildRequestRow | null> {
  try {
    const db = getPool();
    const { rows } = await db.query(
      `UPDATE build_requests SET status = 'rejected_at_code', updated_at = now() WHERE id = $1 AND status = 'awaiting_code_approval' RETURNING *`,
      [id]
    );
    return rows[0] || null;
  } catch {
    return null;
  }
}

export async function recordPrOpened(id: number, prUrl: string, prNumber: number): Promise<BuildRequestRow | null> {
  try {
    const db = getPool();
    const { rows } = await db.query(
      `UPDATE build_requests SET pr_url = $1, pr_number = $2, status = 'pr_opened', updated_at = now()
       WHERE id = $3 AND status = 'awaiting_code_approval' RETURNING *`,
      [prUrl, prNumber, id]
    );
    return rows[0] || null;
  } catch {
    return null;
  }
}

export async function markPrError(id: number, errorDetail: string): Promise<void> {
  try {
    const db = getPool();
    await db.query(
      `UPDATE build_requests SET status = 'error', error_detail = $1, updated_at = now() WHERE id = $2 AND status = 'awaiting_code_approval'`,
      [errorDetail, id]
    );
  } catch {
    // Best-effort.
  }
}

// QA is a bonus report, not consequential to correctness — a failed write
// here doesn't undo the fact that the PR is already open.
export async function recordQaReview(id: number, qaSummary: string): Promise<void> {
  try {
    const db = getPool();
    await db.query(
      `UPDATE build_requests SET qa_summary = $1, status = 'qa_complete', updated_at = now() WHERE id = $2 AND status = 'pr_opened'`,
      [qaSummary, id]
    );
  } catch {
    // Best-effort.
  }
}
```

- [ ] **Step 3: Write the degrade-safety tests**

In `tests/index.test.ts`, add near the other repo imports at the top of the file:

```ts
import {
  createBuildRequest,
  getBuildRequest,
  getLatestAwaitingConsult,
  listBuildRequests,
  recordDirectionConfirmed,
  rejectCode as rejectBuildCode,
} from "../src/data/build-requests-repo.js";
```

Then add a new test category at the end of the file:

```ts
// ---------- Build Requests Repo Tests (no live Postgres in this test process) ----------

registerTest("BuildRequests", "createBuildRequest degrades cleanly when Postgres isn't reachable", async () => {
  try {
    await createBuildRequest("test objective", "admin");
    throw new Error("BuildRequests: expected createBuildRequest to reject without a live Postgres connection");
  } catch (err: any) {
    if (err.message?.includes("expected createBuildRequest to reject")) throw err;
    // Any other thrown error (connection refused/DNS failure) is expected here.
  }
});

registerTest("BuildRequests", "getBuildRequest degrades cleanly when Postgres isn't reachable", async () => {
  const result = await getBuildRequest(999999);
  if (result !== null) {
    throw new Error(`BuildRequests: expected null with no DB, got: ${JSON.stringify(result)}`);
  }
});

registerTest("BuildRequests", "getLatestAwaitingConsult degrades cleanly when Postgres isn't reachable", async () => {
  const result = await getLatestAwaitingConsult("admin");
  if (result !== null) {
    throw new Error(`BuildRequests: expected null with no DB, got: ${JSON.stringify(result)}`);
  }
});

registerTest("BuildRequests", "listBuildRequests degrades cleanly when Postgres isn't reachable", async () => {
  const result = await listBuildRequests();
  if (!Array.isArray(result) || result.length !== 0) {
    throw new Error(`BuildRequests: expected an empty array with no DB, got: ${JSON.stringify(result)}`);
  }
});

registerTest("BuildRequests", "recordDirectionConfirmed degrades cleanly when Postgres isn't reachable", async () => {
  const result = await recordDirectionConfirmed(999999, "some direction notes");
  if (result !== null) {
    throw new Error(`BuildRequests: expected null with no DB, got: ${JSON.stringify(result)}`);
  }
});

registerTest("BuildRequests", "rejectCode degrades cleanly when Postgres isn't reachable", async () => {
  const result = await rejectBuildCode(999999);
  if (result !== null) {
    throw new Error(`BuildRequests: expected null with no DB, got: ${JSON.stringify(result)}`);
  }
});
```

- [ ] **Step 4: Run the full suite and typecheck**

Run: `npm test`
Expected: all existing tests plus the 6 new `BuildRequests` tests pass.

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/data/db.ts src/data/build-requests-repo.ts tests/index.test.ts
git commit -m "feat: add build_requests table and repo"
```

---

### Task 2: GitHub branch/commit integration + repo config

**Files:**
- Modify: `src/integrations/github.ts` (two new functions)
- Modify: `.env` and `.env.example` (new `SELF_REPO_OWNER`/`SELF_REPO_NAME` variables)

**Interfaces:**
- Produces: `createBranch(owner, repo, branchName, baseBranch): Promise<any>`, `commitFile(owner, repo, path, content, message, branch): Promise<any>` — both exported from `src/integrations/github.ts`. `createPullRequest` already exists in this file from an earlier phase and needs no changes — Task 5's approve route calls it directly.
- Consumes: nothing new from other tasks.

- [ ] **Step 1: Add `createBranch`**

In `src/integrations/github.ts`, add after the existing `getNotifications` function at the end of the file:

```ts
export async function createBranch(owner: string, repo: string, branchName: string, baseBranch: string) {
  const baseRef = await githubRequest(`/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(baseBranch)}`);
  const baseSha = baseRef.object.sha;
  const created = await githubRequest(`/repos/${owner}/${repo}/git/refs`, {
    method: "POST",
    body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha: baseSha }),
  });
  observation.logTelemetry("info", "Integrations", `GitHub branch created: ${owner}/${repo}@${branchName} (from ${baseBranch})`);
  return created;
}
```

- [ ] **Step 2: Add `commitFile`**

Immediately after `createBranch`:

```ts
// Creates the file if it doesn't exist on this branch yet, or updates it in
// place if it does — the Contents API requires the current file's `sha` for
// an update but rejects one for a genuinely new file, so this checks first.
export async function commitFile(
  owner: string,
  repo: string,
  path: string,
  content: string,
  message: string,
  branch: string
) {
  let existingSha: string | undefined;
  try {
    const existing = await getFileContent(owner, repo, path, branch);
    if (existing && !Array.isArray(existing) && typeof existing.sha === "string") {
      existingSha = existing.sha;
    }
  } catch (err: any) {
    if (!(err instanceof GitHubIntegrationError) || err.status !== 404) {
      throw err;
    }
    // 404 means the file doesn't exist yet on this branch — a genuine new file, not an error.
  }

  const created = await githubRequest(`/repos/${owner}/${repo}/contents/${path}`, {
    method: "PUT",
    body: JSON.stringify({
      message,
      content: Buffer.from(content, "utf-8").toString("base64"),
      branch,
      ...(existingSha ? { sha: existingSha } : {}),
    }),
  });
  observation.logTelemetry("info", "Integrations", `GitHub file committed: ${owner}/${repo}/${path}@${branch}`);
  return created;
}
```

- [ ] **Step 3: Add the repo-config env vars**

In `.env.example`, find the `# ---------- GitHub ----------` section and add right after `GITHUB_TOKEN=`:

```
# Which repo the Coding department is allowed to open real PRs against —
# deliberately not a model-suppliable argument, see docs/superpowers/specs/
# 2026-07-21-agent-departments-design.md's Security section.
SELF_REPO_OWNER=
SELF_REPO_NAME=
```

In `.env` (the real, git-ignored local file — not `.env.example`), add the same two variables with this repo's actual values:

```
SELF_REPO_OWNER=SweatyFoxGaming
SELF_REPO_NAME=Jarvis-os-2.0
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

No dedicated test for this task — `src/integrations/github.ts` has zero existing test coverage in this codebase already (every function in it requires a live `GITHUB_TOKEN` and live network), so this matches its existing convention rather than introducing a new one. The live round trip (a real branch created, a real file committed) is deferred to manual verification at deploy time, alongside Task 5's approve-code route.

- [ ] **Step 5: Commit**

```bash
git add src/integrations/github.ts .env.example .env
git commit -m "feat: add GitHub branch/commit integration and repo config"
```

---

### Task 3: `departments.ts` — the three real routines

**Files:**
- Create: `src/execution/departments.ts`
- Test: `tests/index.test.ts`

**Interfaces:**
- Consumes: `github.getRepo`, `github.getFileContent` (Task 2, already existing before this plan), `webSearch.webSearch` (existing), `knowledgeGraph.queryKnowledge` (existing).
- Produces: `DepartmentStep` interface (`{ step: string; department: "research" | "coding" | "qa" }`), `decomposeObjective(objective, ai, offlineMode): Promise<DepartmentStep[]>`, `ResearchResult` interface (`{ summary: string }`), `runResearch(objective, ai): Promise<ResearchResult>`, `CodeDraftResult` type (`{ ok: true; summary: string; files: DraftedFile[] } | { ok: false; error: string }`), `draftCodeChanges(objective, researchSummary, directionNotes, ai): Promise<CodeDraftResult>`, `reviewCodeDiff(objective, files, ai): Promise<string>` — all exported from `src/execution/departments.ts`. Task 4's orchestrator and Task 5's QA dispatch call these by name.

- [ ] **Step 1: Create the file with `decomposeObjective`**

Create `src/execution/departments.ts`:

```ts
import { GoogleGenAI, Type } from "@google/genai";
import { ObservationPlatform } from "../observation/index.js";
import * as github from "../integrations/github.js";
import * as webSearch from "../integrations/websearch.js";
import * as knowledgeGraph from "../cognition/knowledge-graph.js";
import type { DraftedFile } from "../data/build-requests-repo.js";

const observation = ObservationPlatform.getInstance();

/**
 * The three real "specialist swarm" routines dispatched from
 * autonomous_executive.ts. Kept in their own module so that file stays the
 * orchestrator, not a growing monolith holding both coordination logic and
 * the actual department work. See docs/superpowers/specs/
 * 2026-07-21-agent-departments-design.md for the full design.
 */

export interface DepartmentStep {
  step: string;
  department: "research" | "coding" | "qa";
}

const DEPARTMENT_DECOMPOSITION_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    steps: {
      type: Type.ARRAY,
      description: "1 to 5 concrete steps needed to accomplish the objective, each tagged with the department that owns it.",
      items: {
        type: Type.OBJECT,
        properties: {
          step: { type: Type.STRING, description: "A concrete, specific description of this step" },
          department: {
            type: Type.STRING,
            description:
              "One of: research, coding, qa. Use 'coding' ONLY if the objective genuinely requires writing/changing " +
              "code in this repository. Use 'qa' ONLY as a step that reviews code from a 'coding' step in the same " +
              "list — never include 'qa' without a 'coding' step also present. Use 'research' for anything else " +
              "(planning, gathering information, answering a question).",
          },
        },
        required: ["step", "department"],
      },
    },
  },
  required: ["steps"],
};

// No AI client, or offline mode: there's no safe heuristic fallback for
// detecting a real coding intent from free text the way there was for the
// old fixed 4-step decomposition — defaulting to a single research-tagged
// step is the conservative, honest choice (never triggers a coding proposal
// without a real model actually reasoning about it).
export async function decomposeObjective(
  objective: string,
  ai: GoogleGenAI | null,
  offlineMode: boolean
): Promise<DepartmentStep[]> {
  if (!ai || offlineMode) {
    return [{ step: objective, department: "research" }];
  }

  try {
    const response = await ai.models.generateContent({
      model: "gemini-3.1-flash-lite",
      contents: `Break this objective down into 1-5 concrete steps, each tagged with the department that owns it: "${objective}"`,
      config: {
        responseMimeType: "application/json",
        responseSchema: DEPARTMENT_DECOMPOSITION_SCHEMA,
      },
    });

    const parsed = JSON.parse(response.text || "{}");
    const rawSteps = Array.isArray(parsed.steps) ? parsed.steps : [];
    const valid: DepartmentStep[] = rawSteps.filter(
      (s: any) =>
        typeof s.step === "string" &&
        s.step.trim().length > 0 &&
        ["research", "coding", "qa"].includes(s.department)
    );

    if (valid.length === 0) {
      return [{ step: objective, department: "research" }];
    }

    // A "qa" step with no accompanying "coding" step has nothing to
    // review — fall back to research for it rather than dispatching a
    // no-op QA pass.
    const hasCoding = valid.some((s) => s.department === "coding");
    return hasCoding
      ? valid
      : valid.map((s) => (s.department === "qa" ? { ...s, department: "research" as const } : s));
  } catch (err: any) {
    observation.logTelemetry("warn", "Departments", `decomposeObjective failed: ${err.message}. Falling back to a single research step.`);
    return [{ step: objective, department: "research" }];
  }
}
```

- [ ] **Step 2: Add `runResearch`**

Immediately after `decomposeObjective`:

```ts
export interface ResearchResult {
  summary: string;
}

const RESEARCH_LOOKUPS_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    webQueries: {
      type: Type.ARRAY,
      description: "0-3 specific web search queries that would genuinely help research this objective. Empty array if web search wouldn't help.",
      items: { type: Type.STRING },
    },
    checkThisRepo: {
      type: Type.BOOLEAN,
      description: "True only if understanding this repository's current purpose/structure would genuinely help (e.g. the objective is about building or changing something in this codebase).",
    },
    knowledgeQuery: {
      type: Type.STRING,
      description: "A specific name/topic to check Jarvis's own stored knowledge for, or \"\" if not applicable.",
    },
  },
  required: ["webQueries", "checkThisRepo", "knowledgeQuery"],
};

// Real research in two Gemini calls: the first plans WHAT to look up
// (specific search queries, whether this repo's context matters, a
// knowledge-graph topic) rather than guessing search terms directly from
// the raw objective; the second synthesizes whatever was actually gathered.
// Each individual lookup degrades independently — one failing read (a
// missing BRAVE_API_KEY, a GitHub hiccup) doesn't abort the whole pass.
export async function runResearch(objective: string, ai: GoogleGenAI | null): Promise<ResearchResult> {
  if (!ai) {
    return {
      summary:
        "No capable model is available right now, so I couldn't do real research on this — " +
        "I'd need Gemini reachable to plan and synthesize findings.",
    };
  }

  let webQueries: string[] = [];
  let checkThisRepo = false;
  let knowledgeQuery = "";
  try {
    const lookupResponse = await ai.models.generateContent({
      model: "gemini-3.1-flash-lite",
      contents: `Plan what to research for this objective: "${objective}"`,
      config: {
        responseMimeType: "application/json",
        responseSchema: RESEARCH_LOOKUPS_SCHEMA,
      },
    });
    const parsed = JSON.parse(lookupResponse.text || "{}");
    webQueries = Array.isArray(parsed.webQueries)
      ? parsed.webQueries.filter((q: any) => typeof q === "string" && q.trim()).slice(0, 3)
      : [];
    checkThisRepo = parsed.checkThisRepo === true;
    knowledgeQuery = typeof parsed.knowledgeQuery === "string" ? parsed.knowledgeQuery.trim() : "";
  } catch (err: any) {
    observation.logTelemetry("warn", "Departments", `Research lookup planning failed: ${err.message}. Falling back to a single direct web search.`);
    webQueries = [objective];
  }

  const findings: string[] = [];

  for (const query of webQueries) {
    try {
      const results = await webSearch.webSearch(query);
      if (results.length > 0) {
        findings.push(
          `Web search "${query}":\n` +
            results.map((r) => `- ${r.title} (${r.url})${r.description ? `: ${r.description}` : ""}`).join("\n")
        );
      }
    } catch (err: any) {
      findings.push(`Web search "${query}" failed: ${err.message}`);
    }
  }

  if (checkThisRepo) {
    const owner = process.env.SELF_REPO_OWNER;
    const repoName = process.env.SELF_REPO_NAME;
    if (owner && repoName) {
      try {
        const repo = await github.getRepo(owner, repoName);
        findings.push(`This repository: ${repo.full_name} — ${repo.description || "(no description)"}. Default branch: ${repo.default_branch}.`);
      } catch (err: any) {
        findings.push(`Could not read this repository's metadata: ${err.message}`);
      }
      try {
        const readme: any = await github.getFileContent(owner, repoName, "README.md");
        if (readme?.decodedContent) {
          findings.push(`README excerpt:\n${readme.decodedContent.slice(0, 1500)}`);
        }
      } catch {
        // README missing or unreadable on this branch — not fatal, just skip it.
      }
    }
  }

  if (knowledgeQuery) {
    try {
      const known = await knowledgeGraph.queryKnowledge(knowledgeQuery);
      if (known.length > 0) {
        findings.push(
          `Already known about "${knowledgeQuery}": ` +
            known.map((k) => `${k.entityName} — ${k.facts.join("; ")}`).join(" | ")
        );
      }
    } catch (err: any) {
      findings.push(`Knowledge graph lookup for "${knowledgeQuery}" failed: ${err.message}`);
    }
  }

  if (findings.length === 0) {
    return {
      summary:
        "I wasn't able to find anything concrete — no search results, no relevant repo context, " +
        "and nothing already known. Let's discuss what you have in mind directly.",
    };
  }

  try {
    const synthesis = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: `Synthesize these raw research findings into a clear, concise report for the objective "${objective}". Findings:\n\n${findings.join("\n\n")}`,
    });
    return { summary: synthesis.text || findings.join("\n\n") };
  } catch (err: any) {
    observation.logTelemetry("warn", "Departments", `Research synthesis failed: ${err.message}. Returning raw findings.`);
    return { summary: findings.join("\n\n") };
  }
}
```

- [ ] **Step 3: Add `draftCodeChanges`**

Immediately after `runResearch`:

```ts
export type CodeDraftResult = { ok: true; summary: string; files: DraftedFile[] } | { ok: false; error: string };

const CODE_DRAFT_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    summary: { type: Type.STRING, description: "A short, plain-language summary of what this code change does, suitable for a PR description." },
    files: {
      type: Type.ARRAY,
      description: "The complete files to create or overwrite. At least one file is required.",
      items: {
        type: Type.OBJECT,
        properties: {
          path: { type: Type.STRING, description: "Relative path from the repository root, e.g. \"src/foo/bar.ts\"" },
          content: { type: Type.STRING, description: "The complete file content" },
        },
        required: ["path", "content"],
      },
    },
  },
  required: ["summary", "files"],
};

export async function draftCodeChanges(
  objective: string,
  researchSummary: string,
  directionNotes: string,
  ai: GoogleGenAI | null
): Promise<CodeDraftResult> {
  if (!ai) {
    return { ok: false, error: "No capable model is available right now to draft real code — Gemini must be reachable for this." };
  }
  try {
    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents:
        "Draft real, complete file changes for this repository to accomplish the objective below. Only include files " +
        "that genuinely need to be created or changed. Write complete, working file contents, not snippets or " +
        "placeholders.\n\n" +
        `Objective: ${objective}\n\nResearch findings:\n${researchSummary}\n\nConfirmed direction from the user:\n${directionNotes}`,
      config: {
        responseMimeType: "application/json",
        responseSchema: CODE_DRAFT_SCHEMA,
      },
    });
    const parsed = JSON.parse(response.text || "{}");
    const files: DraftedFile[] = Array.isArray(parsed.files)
      ? parsed.files.filter((f: any) => typeof f.path === "string" && f.path.trim() && typeof f.content === "string")
      : [];
    if (files.length === 0) {
      return { ok: false, error: "The model didn't produce any concrete file changes for this objective." };
    }
    const summary = typeof parsed.summary === "string" && parsed.summary.trim() ? parsed.summary.trim() : `Implements: ${objective}`;
    return { ok: true, summary, files };
  } catch (err: any) {
    observation.logTelemetry("warn", "Departments", `draftCodeChanges failed: ${err.message}`);
    return { ok: false, error: err.message || String(err) };
  }
}
```

- [ ] **Step 4: Add `reviewCodeDiff`**

Immediately after `draftCodeChanges`:

```ts
export async function reviewCodeDiff(objective: string, files: DraftedFile[], ai: GoogleGenAI | null): Promise<string> {
  if (!ai) {
    return "No capable model was available to review this change — please review the diff yourself before merging.";
  }
  try {
    const filesText = files.map((f) => `--- ${f.path} ---\n${f.content}`).join("\n\n");
    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents:
        "Review this drafted code change against the objective it's meant to accomplish. Flag anything concerning — " +
        "bugs, missing error handling, security issues, or ways it doesn't actually satisfy the objective. Be concise.\n\n" +
        `Objective: ${objective}\n\nFiles:\n${filesText}`,
    });
    return response.text || "Review completed with no specific feedback.";
  } catch (err: any) {
    observation.logTelemetry("warn", "Departments", `reviewCodeDiff failed: ${err.message}`);
    return `Automated review failed (${err.message}) — please review the diff yourself before merging.`;
  }
}
```

- [ ] **Step 5: Write the degrade-safety tests**

In `tests/index.test.ts`, add near the other module imports at the top of the file:

```ts
import * as departments from "../src/execution/departments.js";
```

Then add a new test category at the end of the file:

```ts
// ---------- Departments Tests (no live AI/network in this test process) ----------

registerTest("Departments", "decomposeObjective falls back to a single research step with no AI client", async () => {
  const steps = await departments.decomposeObjective("Build me a website", null, false);
  if (steps.length !== 1 || steps[0].department !== "research") {
    throw new Error(`Departments: expected a single research-tagged fallback step, got: ${JSON.stringify(steps)}`);
  }
});

registerTest("Departments", "decomposeObjective falls back to research when offline mode is on, even with an AI client", async () => {
  // A real GoogleGenAI instance isn't available in this test process; `{} as
  // any` is safe here because offlineMode=true short-circuits before any
  // property on it is ever touched.
  const steps = await departments.decomposeObjective("Build me a website", {} as any, true);
  if (steps.length !== 1 || steps[0].department !== "research") {
    throw new Error(`Departments: expected offline mode to force the research-only fallback, got: ${JSON.stringify(steps)}`);
  }
});

registerTest("Departments", "runResearch degrades cleanly with no AI client", async () => {
  const result = await departments.runResearch("test objective", null);
  if (!result.summary.includes("No capable model is available")) {
    throw new Error(`Departments: expected the no-AI degrade message, got: ${result.summary}`);
  }
});

registerTest("Departments", "draftCodeChanges degrades cleanly with no AI client", async () => {
  const result = await departments.draftCodeChanges("test objective", "research", "direction", null);
  if (result.ok !== false || !result.error.includes("No capable model is available")) {
    throw new Error(`Departments: expected a clean failure with no AI client, got: ${JSON.stringify(result)}`);
  }
});

registerTest("Departments", "reviewCodeDiff degrades cleanly with no AI client", async () => {
  const result = await departments.reviewCodeDiff("test objective", [{ path: "a.ts", content: "x" }], null);
  if (!result.includes("No capable model was available")) {
    throw new Error(`Departments: expected the no-AI degrade message, got: ${result}`);
  }
});
```

- [ ] **Step 6: Run the full suite and typecheck**

Run: `npm test`
Expected: all existing tests plus the 5 new `Departments` tests pass.

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/execution/departments.ts tests/index.test.ts
git commit -m "feat: add real research/coding/QA department routines"
```

---

### Task 4: Real dispatch in `autonomous_executive.ts` + `confirm_build_direction` tool

**Files:**
- Modify: `src/execution/autonomous_executive.ts`
- Modify: `src/execution/tools.ts`
- Modify: `src/server.ts` (one-line call-site update)
- Test: `tests/index.test.ts`

**Interfaces:**
- Consumes: everything produced in Tasks 1-3.
- Produces: `AutonomousExecutive.executeObjective`'s signature changes to `(objective: string, session: SessionState, username: string): Promise<any>` — the `username` parameter is new. A new method, `AutonomousExecutive.confirmDirection(username: string, directionNotes: string): Promise<{ ok: boolean; message: string }>`. A new chat tool, `confirm_build_direction`.

- [ ] **Step 1: Rewrite `autonomous_executive.ts`'s imports and header**

In `src/execution/autonomous_executive.ts`, replace the entire import block and class doc-comment at the top of the file:

```ts
import { ObservationPlatform } from "../observation/index.js";
import { GoogleGenAI } from "@google/genai";
import { MindKernel } from "../cognition/kernel/kernel.js";
import { SessionState } from "../cognition/session.js";
import * as commandProposalsRepo from "../data/command-proposals-repo.js";
```

with:

```ts
import { ObservationPlatform } from "../observation/index.js";
import { GoogleGenAI } from "@google/genai";
import { MindKernel } from "../cognition/kernel/kernel.js";
import { SessionState } from "../cognition/session.js";
import * as commandProposalsRepo from "../data/command-proposals-repo.js";
import * as buildRequestsRepo from "../data/build-requests-repo.js";
import * as departments from "./departments.js";
import * as scheduler from "./scheduler.js";
```

Replace the class doc-comment (the `/** ... */` block right above `export class AutonomousExecutive {`):

```ts
/**
 * Phase XIII: Executive Coordinator (formerly Autonomous Executive)
 * Acts as an orchestrator/coordinator.
 * Responsibilities:
 * 1. Receive request
 * 2. Ask Mind Kernel for state
 * 3. Determine execution path
 * 4. Delegate
 * 5. Receive result
 * 6. Update Mind Kernel
 * 7. Return response
 *
 * This planner decomposes a free-text objective into steps (via Gemini when
 * available) and narrates them — it does not execute anything itself. Real
 * delegation to a capability (GitHub/email/TTS) requires structured arguments
 * (owner/repo/title, to/subject/body, ...) that a free-text objective doesn't
 * reliably contain; that's handled by real Gemini function-calling in the
 * /api/chat path instead (src/execution/tools.ts), where the model extracts
 * those arguments directly from the conversation. Keeping this planner honest
 * about that boundary (see `simulated`/`buildVerification` below) beats
 * guessing a repo/recipient from keyword matches on a plan string.
 */
```

with:

```ts
/**
 * Phase XIII: Executive Coordinator (formerly Autonomous Executive)
 * Acts as an orchestrator/coordinator.
 *
 * Decomposes a free-text objective into department-tagged steps (real
 * dispatch via src/execution/departments.ts when Gemini is available).
 * An objective with a 'coding' step branches into the build_requests
 * lifecycle (real research -> human consult -> confirmed direction -> real
 * drafted code -> human approval -> real GitHub PR -> real QA review) —
 * see docs/superpowers/specs/2026-07-21-agent-departments-design.md. An
 * objective with no coding step gets real research for each step, same
 * lighter-weight shape this planner always had, just no longer narrated.
 */
```

- [ ] **Step 2: Replace `executeObjective`**

Replace the entire `executeObjective` method (from `public async executeObjective(objective: string, session: SessionState): Promise<any> {` through its closing `}` right before `private delay`) with:

```ts
  public async executeObjective(objective: string, session: SessionState, username: string): Promise<any> {
    const kernel = MindKernel.getInstance();
    const workspace = session.workspace;

    this.observation.logTelemetry("info", "Executive", `Coordinator: Initiating Autonomous Objective: "${objective}"`);

    session.dialogue.clear();
    session.dialogue.recordTurn("CEO", `We have received a new high-level objective: "${objective}". Let's decompose and coordinate execution.`);
    session.dialogue.recordTurn("Architect", "We should decompose this into concrete steps, each owned by a real department.");

    // --- STAGE 1: Decompose Objective ---
    session.updateState({
      currentMission: objective,
      currentThought: "Understanding Request",
      executiveStatus: "Thinking",
      attentionTarget: session.attentionEngine.determineAttention({ userRequest: objective }),
    }, this.observation);

    workspace.mission.progressPercent = 10;
    workspace.mission.status = "in_progress";
    await this.delay(300);

    // --- STAGE 2: Formulate Goals ---
    session.updateState({
      currentGoal: `Autonomous Fulfillment: ${objective}`,
      currentThought: "Planning Departments",
      executiveStatus: "Planning",
      attentionTarget: session.attentionEngine.determineAttention({ activeGoal: `Autonomous Fulfillment: ${objective}` }),
    }, this.observation);

    workspace.mission.progressPercent = 30;
    await this.delay(300);

    // --- STAGE 3: Department-Tagged Decomposition ---
    const steps = await departments.decomposeObjective(objective, this.ai, kernel.offlineMode);
    const hasCodingStep = steps.some(s => s.department === "coding");

    session.updateState({
      currentPlan: steps.map(s => `[${s.department}] ${s.step}`),
      currentThought: hasCodingStep ? "Starting Research For Build Request" : "Researching",
      executiveStatus: "Executing",
      activeCapability: hasCodingStep ? "Build Request Pipeline" : "Research Department",
      attentionTarget: session.attentionEngine.determineAttention({ hasIncompletePlan: true }),
    }, this.observation);

    workspace.mission.progressPercent = 50;
    await this.delay(200);

    // Computed once, shared by both branches below, instead of a bare magic
    // number in the build-request branch's decision trace — same real
    // command-outcome-driven signal every other confidence score in this
    // codebase uses.
    const recentOutcomeSuccessRate = await commandProposalsRepo.getRecentOutcomeSuccessRate();
    const calculatedConfidence = session.confidenceModel.calculateOverallConfidence({
      memoryConfidence: 1.0,
      toolConfidence: 1.0,
      validationConfidence: 1.0,
      capabilityConfidence: 1.0,
      environmentConfidence: 1.0,
      ...(recentOutcomeSuccessRate !== null ? { outcomeConfidence: recentOutcomeSuccessRate } : {})
    });

    // --- STAGE 4a: Build Request Branch (real research -> stop for consult) ---
    if (hasCodingStep) {
      const buildRequest = await buildRequestsRepo.createBuildRequest(objective, username);
      const research = await departments.runResearch(objective, this.ai);
      const recorded = await buildRequestsRepo.recordResearch(buildRequest.id, research.summary);

      if (!recorded) {
        await buildRequestsRepo.markResearchError(buildRequest.id, "Failed to persist research findings.");
        session.updateState({ currentThought: "Idle", executiveStatus: "Idle", activeCapability: null }, this.observation);
        workspace.mission.status = "failed";
        return {
          objective,
          status: "error",
          buildRequestId: buildRequest.id,
          message: "Research completed but couldn't be saved — please try again.",
        };
      }

      scheduler.pushNotification(
        username,
        `I've done some research on "${objective}", sir. ${research.summary.slice(0, 300)}${research.summary.length > 300 ? "..." : ""} ` +
          `Let's talk through direction before I draft anything — build request #${buildRequest.id}.`,
        "info"
      );

      session.dialogue.recordTurn("Research", "Real research complete — findings stored, awaiting your input on direction.");
      session.dialogue.recordTurn("Decision", `Build request #${buildRequest.id} is awaiting your consultation.`);

      session.updateState({
        currentThought: "Awaiting Consultation",
        executiveStatus: "Idle",
        activeCapability: null,
        attentionTarget: session.attentionEngine.determineAttention({}),
      }, this.observation);
      workspace.mission.progressPercent = 60;
      workspace.mission.status = "in_progress";

      this.observation.recordDecisionTrace({
        intent: `Autonomous Execution: "${objective}"`,
        goals: [`Complete: ${objective}`, "Research before building", "Confirm direction before coding"],
        strategy: "Real department dispatch — build request lifecycle",
        planner: steps.map(s => s.step),
        capabilitySelection: ["Research Department"],
        reasoning: `Objective required real code, so a build request (#${buildRequest.id}) was created. Real research ran and is stored; coding is deferred until the user confirms direction.`,
        knowledgeUsed: workspace.userContext.loadedFacts,
        executionResult: `Build request #${buildRequest.id} created, research stored, awaiting consult.`,
        reflection: "This objective needs a human conversation before any code gets written — that boundary is by design, not a limitation.",
        confidence: calculatedConfidence / 100
      });

      return {
        objective,
        status: "awaiting_consult",
        buildRequestId: buildRequest.id,
        researchSummary: research.summary,
        message: "Research is done and stored. I'll discuss it with you before drafting any code — nothing gets built until you confirm direction.",
      };
    }

    // --- STAGE 4b: No coding step — real research for every step, same
    // lighter-weight shape this planner always had, just no longer narrated. ---
    const findings: string[] = [];

    for (let i = 0; i < steps.length; i++) {
      const { step } = steps[i];
      workspace.plan.currentStepIndex = i;

      session.updateState({
        attentionTarget: session.attentionEngine.determineAttention({ emergency: null, userRequest: step }),
      }, this.observation);
      workspace.attention.focusOn(step);

      const research = await departments.runResearch(step, this.ai);
      const resultText = `[Research] ${research.summary}`;

      workspace.capabilities.recordResult({ step, outcome: "success", summary: resultText });
      this.observation.logTelemetry("info", "Executive", `[Stage 4] Step ${i + 1} researched for real.`);
      findings.push(resultText);
    }

    // --- STAGE 5: Output Aggregation ---
    session.dialogue.recordTurn("QA", "All steps researched for real.");
    session.dialogue.recordTurn("Decision", `Objective "${objective}" researched.`);

    const finalReport = {
      objective,
      status: "success",
      totalStepsExecuted: steps.length,
      findings,
    };

    // calculatedConfidence was already computed once, right after Stage 3,
    // shared with the build-request branch above — not recomputed here.
    session.updateState({
      currentThought: "Preparing Response",
      executiveStatus: "Idle",
      activeCapability: null,
      confidence: calculatedConfidence,
      attentionTarget: session.attentionEngine.determineAttention({}),
    }, this.observation);

    workspace.mission.progressPercent = 100;
    workspace.mission.status = "completed";

    workspace.capabilities.recordResult(finalReport);
    workspace.plan.updateStatus("idle");
    workspace.attention.clearFocus();

    this.observation.recordDecisionTrace({
      intent: `Autonomous Execution: "${objective}"`,
      goals: [`Complete: ${objective}`, "Decompose goals autonomously", "Research for real"],
      strategy: "Multi-stage Autonomous executive pattern",
      planner: steps.map(s => s.step),
      capabilitySelection: ["Research Department"],
      reasoning: `Completed research for all ${steps.length} step(s). Confidence: ${calculatedConfidence}%.`,
      knowledgeUsed: workspace.userContext.loadedFacts,
      executionResult: `Researched ${objective}. Status: SUCCESS`,
      reflection: "Executive coordinator loop ran via SessionState; real research was performed for every step.",
      confidence: calculatedConfidence / 100
    });

    return finalReport;
  }

  // Drives the second stage of the build_requests lifecycle: called once
  // the user has actually confirmed a direction in conversation (never
  // speculatively — see confirm_build_direction's tool description in
  // tools.ts). Resolves against the caller's own most recent
  // 'awaiting_consult' row rather than a model-recalled id — see this
  // plan's Global Constraints for why.
  public async confirmDirection(username: string, directionNotes: string): Promise<{ ok: boolean; message: string }> {
    const buildRequest = await buildRequestsRepo.getLatestAwaitingConsult(username);
    if (!buildRequest) {
      return { ok: false, message: "There's no build request of mine currently awaiting your direction to confirm." };
    }

    const confirmed = await buildRequestsRepo.recordDirectionConfirmed(buildRequest.id, directionNotes);
    if (!confirmed) {
      return { ok: false, message: "Couldn't confirm direction — that build request may have already moved on." };
    }

    await buildRequestsRepo.markCoding(confirmed.id);

    const draft = await departments.draftCodeChanges(
      confirmed.objective,
      confirmed.research_summary || "",
      directionNotes,
      this.ai
    );

    if (!draft.ok) {
      await buildRequestsRepo.markCodeDraftError(confirmed.id, draft.error);
      scheduler.pushNotification(
        username,
        `I wasn't able to draft code for build request #${confirmed.id}, sir: ${draft.error}`,
        "warning"
      );
      return { ok: false, message: `Direction confirmed, but drafting the code failed: ${draft.error}` };
    }

    const recorded = await buildRequestsRepo.recordCodeDraft(confirmed.id, draft.summary, draft.files);
    if (!recorded) {
      await buildRequestsRepo.markCodeDraftError(confirmed.id, "Failed to persist the drafted code.");
      return { ok: false, message: "Direction confirmed and code drafted, but I couldn't save it — please try again." };
    }

    scheduler.pushNotification(
      username,
      `I've drafted the code for build request #${confirmed.id}, sir: ${draft.summary}. It's waiting for your approval in the dashboard before I open a pull request.`,
      "info"
    );

    return {
      ok: true,
      message: `Direction confirmed. I've drafted ${draft.files.length} file(s) — build request #${confirmed.id} is now waiting for your approval before I open a pull request.`,
    };
  }
```

- [ ] **Step 3: Update the `/api/executive/run` call site**

In `src/server.ts`, find (around line 519):

```ts
    const session = await getSession(req.username);
    const report = await executive.executeObjective(objective, session);
```

Replace with:

```ts
    const session = await getSession(req.username);
    const report = await executive.executeObjective(objective, session, req.username);
```

- [ ] **Step 4: Add the `confirm_build_direction` tool declaration**

In `src/execution/tools.ts`, in `TOOL_DECLARATIONS`, add right after the `decompose_plan` declaration (before `calendar_list_events`):

```ts
  {
    name: "confirm_build_direction",
    description:
      "Call this ONLY when the user has explicitly confirmed the direction for something you researched and discussed with them (not just a casual 'sounds interesting') — this locks in the direction and starts drafting real code. Never call this speculatively or before a genuine research-and-discussion exchange about a build request.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        directionNotes: { type: Type.STRING, description: "A clear summary of the direction the user confirmed — what to build, key choices discussed (stack, scope, style)" },
      },
      required: ["directionNotes"],
    },
  },
```

- [ ] **Step 5: Add the permission mapping**

In `PERMISSION_BY_TOOL`, add (at the end, matching how `propose_mcp_server` was added in an earlier phase):

```ts
  confirm_build_direction: "executive.plan",
```

- [ ] **Step 6: Add the `executeTool` case**

In `executeTool`'s `switch`, add right after the `decompose_plan` case:

```ts
      case "confirm_build_direction": {
        const result = await AutonomousExecutive.getInstance().confirmDirection(username, args.directionNotes);
        if (!result.ok) {
          return { name, ok: false, error: result.message };
        }
        output = { message: result.message };
        break;
      }
```

- [ ] **Step 7: Deliberately do NOT add `confirm_build_direction` to `TOOL_TRIGGER_WORDS`**

This is a deliberate omission, not an oversight — `confirm_build_direction` belongs in the same category as `propose_command`, `display_content`, `update_objective_status`, `record_command_outcome`, and `queue_feature_request`: tools that should only ever be invoked as a model-driven judgment call after real context, never routed to directly by a keyword match. No change needed to `TOOL_TRIGGER_WORDS` for this task.

- [ ] **Step 8: Update the existing `Executive 2.0` test for the new signature and real behavior**

In `tests/index.test.ts`, find the test registered under category `"Executive 2.0"` (title `"Autonomous executive 5-stage pipeline validation"`). Replace the entire test with:

```ts
registerTest("Executive 2.0", "Autonomous executive real dispatch pipeline (no AI available)", async () => {
  const session = new SessionState();
  const obs = ObservationPlatform.getInstance();
  const exec = AutonomousExecutive.getInstance(obs, null); // No AI client — exercises the degrade-safety fallback path

  const report = await exec.executeObjective("Deploy microservices orchestrator", session, "test_user");

  if (report.status !== "success") {
    throw new Error("Autonomous Executive: Execution status mismatch");
  }
  if (report.totalStepsExecuted !== 1) {
    throw new Error(`Autonomous Executive: expected 1 step in the no-AI fallback, got ${report.totalStepsExecuted}`);
  }
  if (!report.findings?.[0]?.includes("No capable model is available")) {
    throw new Error("Autonomous Executive: expected the no-AI research fallback message in findings");
  }
  if (session.workspace.mission.status !== "completed") {
    throw new Error("Autonomous Executive: Mission status did not resolve to 'completed'");
  }
  if (session.workspace.mission.progressPercent !== 100) {
    throw new Error("Autonomous Executive: Mission progress percent did not resolve to 100%");
  }
});
```

This changes from the old assertion (`totalStepsExecuted !== 4`, matching the old fixed 4-step heuristic decomposition) to the new one (`=== 1`, matching `decomposeObjective`'s no-AI fallback — a single research-tagged step, since there's no safe heuristic fallback for detecting a coding intent from free text without a real model). With `ai: null`, `hasCodingStep` can never be `true` (the fallback always tags `research`), so this test only exercises Stage 4b, not the build-request branch — the build-request branch requires a real Gemini call to ever produce a `coding`-tagged step, and is covered by manual live verification instead (same as the MCP plan's live-server-connection tests were deferred).

- [ ] **Step 9: Run the full suite and typecheck**

Run: `npm test`
Expected: all tests pass, including the updated `Executive 2.0` test and the one new `Tools` test category addition happens in Task 5 — this step should show the same total as Task 3's end plus no new failures (the `Executive 2.0` test count stays the same, its content changed).

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git add src/execution/autonomous_executive.ts src/execution/tools.ts src/server.ts tests/index.test.ts
git commit -m "feat: real department dispatch + confirm_build_direction tool"
```

---

### Task 5: Consult context + approve/reject-code routes + QA dispatch

**Files:**
- Modify: `src/server.ts`
- Test: `tests/index.test.ts`

**Interfaces:**
- Consumes: everything produced in Tasks 1-4.
- Produces: `GET /api/system/build-requests`, `POST /api/system/build-requests/:id/approve-code`, `POST /api/system/build-requests/:id/reject-code`. Also wires an awaiting-consult build request's research findings into `/api/chat`'s system prompt context — the design spec's "Consult" step depends on this (Jarvis can't discuss research it can't see), and nothing in Tasks 1-4 does it yet.

- [ ] **Step 1: Add the imports**

In `src/server.ts`, add right after the existing `mcpRegistry` import (near the other `src/data`/`src/execution` imports):

```ts
import * as buildRequestsRepo from "./data/build-requests-repo.js";
import * as departments from "./execution/departments.js";
```

- [ ] **Step 2: Pull awaiting-consult research into `/api/chat`'s system prompt**

In `src/server.ts`, find (around line 699, in the `/api/chat` handler):

```ts
    const identityContext = await identity.buildIdentityContext();

    const baseSystemInstruction =
```

Replace with:

```ts
    const identityContext = await identity.buildIdentityContext();

    // Pulls a currently-awaiting-consult build request's research findings
    // into context the same way memory/identity already are — without this,
    // Jarvis has no way to discuss research it did moments (or turns) ago
    // once the notification that announced it scrolls out of context.
    // getLatestAwaitingConsult already degrades to null internally (Task 1)
    // — no extra try/catch needed here, matching how memoryStore.recall is
    // called directly above for the same reason.
    const awaitingBuildRequest = await buildRequestsRepo.getLatestAwaitingConsult(req.username);
    const buildRequestContext = awaitingBuildRequest
      ? `\n\nYou have a build request (#${awaitingBuildRequest.id}) awaiting the user's direction: "${awaitingBuildRequest.objective}". ` +
        `Research findings: ${awaitingBuildRequest.research_summary}. Discuss this with the user and, once they've genuinely ` +
        `confirmed a direction, call confirm_build_direction.`
      : "";

    const baseSystemInstruction =
```

Then find, a few lines further down:

```ts
      + memoryContext + styleContext + identityContext;
```

Replace with:

```ts
      + memoryContext + styleContext + identityContext + buildRequestContext;
```

- [ ] **Step 3: Add the GET route**

In `src/server.ts`, add right after the MCP servers section (after the `POST /api/system/mcp-servers/:id/disable` route, before `POST /api/system/commands/:id/reject`):

```ts
app.get("/api/system/build-requests", validateApiKey, async (req: any, res: any) => {
  if (!permissions.hasGrant(req.username, "github.pulls.create")) {
    return res.status(403).json({ error: 'Missing capability grant "github.pulls.create"' });
  }
  try {
    res.json({ buildRequests: await buildRequestsRepo.listBuildRequests(req.query.status as buildRequestsRepo.BuildRequestStatus | undefined) });
  } catch (err: any) {
    res.json({ buildRequests: [], error: err.message });
  }
});
```

- [ ] **Step 4: Add the approve-code route**

Immediately after the GET route:

```ts
// The only place in this codebase that opens a real PR on Jarvis's own
// behalf. Every GitHub call here (branch -> commit each file -> open PR) is
// wrapped so a partial failure records exactly which step failed via
// markPrError rather than silently claiming a status it didn't reach — see
// this plan's Global Constraints.
app.post("/api/system/build-requests/:id/approve-code", validateApiKey, async (req: any, res: any) => {
  if (!permissions.hasGrant(req.username, "github.pulls.create")) {
    return res.status(403).json({ error: 'Missing capability grant "github.pulls.create"' });
  }
  const owner = process.env.SELF_REPO_OWNER;
  const repoName = process.env.SELF_REPO_NAME;
  if (!owner || !repoName) {
    return res.status(503).json({ error: "SELF_REPO_OWNER/SELF_REPO_NAME are not configured." });
  }
  try {
    const buildRequest = await buildRequestsRepo.getBuildRequest(Number(req.params.id));
    if (!buildRequest || buildRequest.status !== "awaiting_code_approval") {
      return res.status(404).json({ error: "Build request not found or not awaiting approval" });
    }
    const files = buildRequest.proposed_files || [];
    if (files.length === 0) {
      await buildRequestsRepo.markPrError(buildRequest.id, "No proposed files to commit.");
      return res.status(422).json({ error: "No proposed files to commit." });
    }

    const branchName = `jarvis/build-request-${buildRequest.id}`;

    let repoInfo: any;
    try {
      repoInfo = await github.getRepo(owner, repoName);
    } catch (err: any) {
      await buildRequestsRepo.markPrError(buildRequest.id, `Failed to read repo default branch: ${err.message}`);
      return res.status(502).json({ error: `Failed to read repo default branch: ${err.message}` });
    }
    const baseBranch = repoInfo.default_branch;

    try {
      await github.createBranch(owner, repoName, branchName, baseBranch);
    } catch (err: any) {
      await buildRequestsRepo.markPrError(buildRequest.id, `Failed to create branch: ${err.message}`);
      return res.status(502).json({ error: `Failed to create branch: ${err.message}` });
    }

    for (const file of files) {
      try {
        await github.commitFile(
          owner,
          repoName,
          file.path,
          file.content,
          `Build request #${buildRequest.id}: ${buildRequest.code_summary || buildRequest.objective}`,
          branchName
        );
      } catch (err: any) {
        await buildRequestsRepo.markPrError(
          buildRequest.id,
          `Failed to commit "${file.path}": ${err.message}. Branch "${branchName}" may exist with a partial commit — review it manually.`
        );
        return res.status(502).json({ error: `Failed to commit "${file.path}": ${err.message}` });
      }
    }

    let pr: any;
    try {
      pr = await github.createPullRequest(
        owner,
        repoName,
        `Build request #${buildRequest.id}: ${buildRequest.objective}`,
        branchName,
        baseBranch,
        buildRequest.code_summary || undefined
      );
    } catch (err: any) {
      await buildRequestsRepo.markPrError(buildRequest.id, `Branch and commits succeeded but opening the PR failed: ${err.message}`);
      return res.status(502).json({ error: `Failed to open PR: ${err.message}` });
    }

    const updated = await buildRequestsRepo.recordPrOpened(buildRequest.id, pr.html_url, pr.number);
    if (!updated) {
      return res.status(500).json({ error: "PR was opened but couldn't be recorded — check GitHub directly." });
    }

    observation.logAuditEvent(req.username, "build_request_pr_opened", "success", `#${updated.id} -> ${pr.html_url}`);

    // QA runs immediately, synchronously, right here — no CI polling (see
    // design spec's "Decisions"). CI's own result speaks for itself on
    // GitHub, same as any other PR.
    const qaSummary = await departments.reviewCodeDiff(updated.objective, files, ai);
    await buildRequestsRepo.recordQaReview(updated.id, qaSummary);

    scheduler.pushNotification(
      req.username,
      `Opened the pull request for build request #${updated.id}, sir: ${pr.html_url}. QA review: ${qaSummary.slice(0, 300)}${qaSummary.length > 300 ? "..." : ""} Check GitHub for CI status.`,
      "info"
    );

    res.json({ ...updated, qa_summary: qaSummary });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
```

- [ ] **Step 5: Add the reject-code route**

Immediately after the approve-code route:

```ts
app.post("/api/system/build-requests/:id/reject-code", validateApiKey, async (req: any, res: any) => {
  if (!permissions.hasGrant(req.username, "github.pulls.create")) {
    return res.status(403).json({ error: 'Missing capability grant "github.pulls.create"' });
  }
  try {
    const updated = await buildRequestsRepo.rejectCode(Number(req.params.id));
    if (!updated) return res.status(404).json({ error: "Build request not found or not awaiting code approval" });
    observation.logAuditEvent(req.username, "build_request_code_rejected", "success", `#${updated.id}`);
    res.json(updated);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
```

- [ ] **Step 6: Write the tool-gating test**

In `tests/index.test.ts`, add to the `"Tools"` category (find the existing `registerTest("Tools", ...)` calls and add alongside them):

```ts
registerTest("Tools", "confirm_build_direction denies calls without executive.plan grant", async () => {
  const result = await executeTool("confirm_build_direction", { directionNotes: "use React" }, "ungranted_test_user");
  if (result.ok !== false || !result.error?.toLowerCase().includes("grant")) {
    throw new Error("Tools: confirm_build_direction should deny a call with no capability grant");
  }
});

registerTest("Tools", "confirm_build_direction reports cleanly when no build request is awaiting consult", async () => {
  const result = await executeTool("confirm_build_direction", { directionNotes: "use React" }, "admin");
  if (result.ok !== false || !result.error?.toLowerCase().includes("no build request")) {
    throw new Error(`Tools: expected a clean 'no build request awaiting consult' error, got: ${JSON.stringify(result)}`);
  }
});
```

The second test relies on `getLatestAwaitingConsult` degrading to `null` with no live Postgres connection in this test process (verified in Task 1) — so `confirmDirection`'s first branch (`if (!buildRequest) return { ok: false, message: "..." }`) is exactly what fires here, giving a real, meaningful assertion rather than a smoke test.

- [ ] **Step 7: Run the full suite and typecheck**

Run: `npm test`
Expected: all existing tests plus the 2 new `Tools` tests pass.

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 8: Search for any other reference to the old `executeObjective` two-argument call shape**

Run: `grep -rn "executeObjective(" src/ tests/` and confirm every call site now passes three arguments (`objective, session, username`) — Task 4 already updated `tools.ts`'s `decompose_plan` case and `server.ts`'s `/api/executive/run` route; this step is the verification that nothing else calls the old two-argument shape, the same kind of check that caught unanticipated call sites in earlier phases.

- [ ] **Step 9: Commit**

```bash
git add src/server.ts tests/index.test.ts
git commit -m "feat: add build-request approve/reject-code routes with QA dispatch"
```
