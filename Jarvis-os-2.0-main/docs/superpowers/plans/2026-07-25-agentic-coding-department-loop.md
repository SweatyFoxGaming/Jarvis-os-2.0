# Agentic Coding Department — Plan 2 (The Real Loop) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `draftCodeChanges`'s single blind LLM call with a real multi-turn tool-calling agentic loop that reads, edits, and tests real files inside the isolated `jarvis-builder` sandbox from Plan 1 — then gate the existing GitHub PR flow behind a fresh final-verification pass and give the dashboard on-demand visibility into every command the loop ran.

**Architecture:** A new `runCodingAgent` function drives an OpenAI-compatible tool-calling loop against NVIDIA NIM, offering the model exactly two tools (`run_shell_command`, `finish_coding`) executed via Plan 1's `jarvis-builder` client. Every command and its output is persisted as a transcript event. When the model calls `finish_coding`, the loop reads back whatever the model actually left on disk (via `git diff` + `cat`, not recalled text) and hands it to the existing `awaiting_code_approval` checkpoint — unchanged in shape, so the rest of the state machine doesn't need to know anything changed upstream. On approval, a fresh `npm ci && npm test && npx tsc --noEmit` pass runs inside the same still-alive sandbox before any GitHub call, and the workspace is torn down exactly once, in every exit path, right after that checkpoint resolves.

**Tech Stack:** TypeScript, Express, `pg`, NVIDIA NIM's OpenAI-compatible chat-completions API via plain `fetch` (no SDK, matching `github.ts`/`websearch.ts`/`wikipedia.ts`), Plan 1's `jarvis-builder` HTTP API via `src/kernel/builder-client.ts`.

## Global Constraints

- **No new build-request statuses.** Reuse the existing `BuildRequestStatus` union (`researching`, `awaiting_consult`, `direction_confirmed`, `coding`, `awaiting_code_approval`, `pr_opened`, `qa_complete`, `rejected_at_code`, `error`) exactly as-is — verbatim from `src/kernel/state/build-requests-repo.ts:3-12`.
- **Exactly two checkpoints.** Everything between `direction_confirmed`→`coding`→`awaiting_code_approval` (the agentic loop itself) runs with zero human checkpoints. The only two stops are: direction confirmation (already exists, unchanged) and the combined testing-and-deployment gate at `awaiting_code_approval` (approve/reject).
- **No secrets or GitHub credentials reach the sandbox at any point**, including during the new final-verification pass — it runs via `execInWorkspace`, which never passes env vars into the sandbox container (Plan 1's `jarvis-builder/workspace.ts` `docker run` has zero `-e`/`--env-file` flags — do not add any as part of this plan).
- **The coding agent gets exactly one tool for doing work: `run_shell_command`.** No curated/allowlisted toolset — this was explicit user direction during Plan 1's brainstorming and still applies here. `finish_coding` is a signal-only tool (ends the loop), not a work tool.
- **NVIDIA NIM only for this loop**, kept fully separate from the existing Groq (`groq-sdk`) and Gemini (`@google/genai`) usage elsewhere in this codebase — chat, research, decomposition, and the existing post-PR QA review (`reviewCodeDiff`) stay exactly as they are today, untouched by this plan.
- **The sandbox workspace stays alive from `coding` through `awaiting_code_approval`** (needed for the final-verification pass to run against the same on-disk state) and is destroyed exactly once, in every exit path (approve success, approve failure, reject, or a coding-session failure) — never left running past a terminal-adjacent state.
- **Plain `fetch`, not an SDK package**, for the new NVIDIA client — matching every other backend HTTP integration in this codebase (`github.ts`, `websearch.ts`, `wikipedia.ts`, `builder-client.ts`), none of which pull in a client library.
- **No unit tests for the Docker/NVIDIA-dependent orchestration itself** (the agentic loop, the final-verification exec calls) — matches this codebase's established precedent for `github.ts`/`websearch.ts`/`wikipedia.ts`/`jarvis-builder`, none of which have tests since they depend entirely on live external systems. Any genuinely pure logic (transcript-event persistence/listing) gets normal unit tests, matching the degrade-cleanly precedent in `vault-repo.ts`/`build-requests-repo.ts`. `npm test`/`tsc --noEmit` must stay green throughout.
- **End-to-end behavior is verified manually against a real running instance** — a real build request, a real NVIDIA API key, a real sandboxed agent loop — the same precedent Plan 1 and every other live-system-dependent feature in this codebase already follows. This is called out explicitly as the last item in this plan, not left implicit.

---

### Task 1: NVIDIA NIM client module

**Files:**
- Create: `src/runtime/nvidia-client.ts`
- Modify: `.env.example` (add NVIDIA section)
- Modify: `src/server.ts` (add NVIDIA API key init, mirroring the existing Groq init block)
- Test: `tests/index.test.ts` (add a unit test for the pure tool-call-parsing helper)

**Interfaces:**
- Produces: `callNvidiaChat(apiKey: string, messages: NvidiaMessage[], tools: NvidiaTool[]): Promise<{ content: string | null; toolCalls: NvidiaToolCall[] | null }>`, plus the `NvidiaMessage`, `NvidiaTool`, `NvidiaToolCall` types and `NvidiaIntegrationError` class — all exported from `src/runtime/nvidia-client.ts`. Task 3 imports and drives the loop with these.
- Produces: a module-level `nvidiaApiKey: string | null` local in `src/server.ts` (mirroring the existing `groq` local at `server.ts:190`), read from `process.env.NVIDIA_API_KEY`. Task 4 threads this into `AutonomousExecutive`.

- [ ] **Step 1: Write `src/runtime/nvidia-client.ts`**

```ts
import { ObservationPlatform } from "../kernel/observation.js";

const observation = ObservationPlatform.getInstance();
const NVIDIA_API_URL = "https://integrate.api.nvidia.com/v1/chat/completions";

// meta/llama-3.1-70b-instruct is NVIDIA NIM's most broadly available
// OpenAI-tool-calling-compatible model at the time this was written.
// Overridable via NVIDIA_MODEL without a code change, since the design
// spec explicitly leaves the exact model unverified until live testing.
const DEFAULT_MODEL = "meta/llama-3.1-70b-instruct";

export class NvidiaIntegrationError extends Error {
  constructor(message: string, public status = 500) {
    super(message);
  }
}

export interface NvidiaToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface NvidiaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: NvidiaToolCall[];
  tool_call_id?: string;
}

export interface NvidiaTool {
  type: "function";
  function: { name: string; description: string; parameters: any };
}

export interface NvidiaChatResult {
  content: string | null;
  toolCalls: NvidiaToolCall[] | null;
}

// Extracts the {content, toolCalls} shape this module's callers actually
// need from a raw OpenAI-compatible chat-completions response body — split
// out from callNvidiaChat so it's testable without a real network call.
export function parseNvidiaChatResponse(data: any): NvidiaChatResult {
  const message = data?.choices?.[0]?.message;
  if (!message) {
    throw new NvidiaIntegrationError("NVIDIA NIM response had no message content.");
  }
  return {
    content: message.content ?? null,
    toolCalls: Array.isArray(message.tool_calls) && message.tool_calls.length > 0 ? message.tool_calls : null,
  };
}

export async function callNvidiaChat(
  apiKey: string,
  messages: NvidiaMessage[],
  tools: NvidiaTool[]
): Promise<NvidiaChatResult> {
  const model = process.env.NVIDIA_MODEL || DEFAULT_MODEL;
  const res = await fetch(NVIDIA_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ model, messages, tools, tool_choice: "auto" }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    observation.logTelemetry("warn", "Cognition", `NVIDIA NIM request failed: ${res.status} ${body}`);
    throw new NvidiaIntegrationError(`NVIDIA NIM API error (${res.status}): ${body}`, res.status);
  }

  const data = await res.json();
  return parseNvidiaChatResponse(data);
}
```

- [ ] **Step 2: Add the unit test for `parseNvidiaChatResponse`**

Add to `tests/index.test.ts` in the existing test-runner style used throughout that file (find the `Category: GroqClient` block and add a new `Category: NvidiaClient` block right after it, following the exact same `test(...)`/assertion helper pattern already used for `toGroqSchema` in that file — read the surrounding 20 lines before writing this to match the exact helper function names in use).

```ts
test("Category: NvidiaClient", "parseNvidiaChatResponse extracts content with no tool calls", () => {
  const result = parseNvidiaChatResponse({ choices: [{ message: { content: "hello", tool_calls: [] } }] });
  assertEqual(result, { content: "hello", toolCalls: null });
});

test("Category: NvidiaClient", "parseNvidiaChatResponse extracts tool calls when present", () => {
  const toolCalls = [{ id: "call_1", type: "function", function: { name: "run_shell_command", arguments: "{}" } }];
  const result = parseNvidiaChatResponse({ choices: [{ message: { content: null, tool_calls: toolCalls } }] });
  assertEqual(result, { content: null, toolCalls });
});

test("Category: NvidiaClient", "parseNvidiaChatResponse throws when the response has no message", () => {
  let threw = false;
  try {
    parseNvidiaChatResponse({ choices: [] });
  } catch {
    threw = true;
  }
  assertEqual(threw, true);
});
```

(Match `test`/`assertEqual` to whatever this file's actual existing helper names are — read `tests/index.test.ts`'s top of file and the `GroqClient` block first; do not guess the names.)

- [ ] **Step 3: Add the NVIDIA import to `tests/index.test.ts`**

Add alongside the existing `groq-client.ts` import in that file: `import { parseNvidiaChatResponse } from "../src/runtime/nvidia-client.js";`

- [ ] **Step 4: Run the test suite**

Run: `npm test`
Expected: all prior tests plus the 3 new `NvidiaClient` tests pass (111/111 total, up from 108/108).

- [ ] **Step 5: Add the NVIDIA section to `.env.example`**

Add a new section (find where the existing `# LLM` section with `GROQ_API_KEY`/`GEMINI_API_KEY` lives and add this directly after it):

```
# NVIDIA NIM (coding agent loop only — kept separate from Groq so the
# iterative multi-turn coding loop can't collide with Groq's rate limits)
NVIDIA_API_KEY=
NVIDIA_MODEL=meta/llama-3.1-70b-instruct
```

- [ ] **Step 6: Wire the NVIDIA API key into `src/server.ts`**

Find the existing Groq client init block (`server.ts:189-196`):

```ts
// ---------- Groq Client Initialization (primary cloud tier) ----------
let groq: Groq | null = null;
if (process.env.GROQ_API_KEY) {
  groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  observation.logTelemetry("info", "Cognition", "Groq client successfully configured with API Key.");
} else {
  observation.logTelemetry("warn", "Cognition", "No GROQ_API_KEY detected. Groq features unavailable.");
}
briefing.configureGroq(groq);
```

Add directly after it (before the next section):

```ts
// ---------- NVIDIA NIM Client Initialization (agentic coding loop only) ----------
const nvidiaApiKey: string | null = process.env.NVIDIA_API_KEY || null;
if (nvidiaApiKey) {
  observation.logTelemetry("info", "Cognition", "NVIDIA NIM API key configured — the agentic coding loop is available.");
} else {
  observation.logTelemetry("warn", "Cognition", "No NVIDIA_API_KEY detected. The agentic coding loop is unavailable.");
}
```

- [ ] **Step 7: Typecheck**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/runtime/nvidia-client.ts .env.example src/server.ts tests/index.test.ts
git commit -m "feat: add the NVIDIA NIM client for the agentic coding loop"
```

---

### Task 2: Transcript events table and repo

**Files:**
- Modify: `src/kernel/state/db.ts` (add `transcript_events` table to `createSchema()`)
- Create: `src/kernel/state/transcript-events-repo.ts`
- Test: `tests/index.test.ts` (degrade-cleanly tests, matching `build-requests-repo.ts`/`vault-repo.ts` precedent)

**Interfaces:**
- Consumes: `getPool()` from `./db.js` (existing, `src/kernel/state/db.ts`).
- Produces: `recordTranscriptEvent(buildRequestId: number, seq: number, command: string, stdout: string, stderr: string, exitCode: number): Promise<void>` and `listTranscriptEvents(buildRequestId: number): Promise<TranscriptEventRow[]>`, both exported from `src/kernel/state/transcript-events-repo.ts`. Task 3 calls `recordTranscriptEvent` from inside the agentic loop; Task 6's new route calls `listTranscriptEvents`.

- [ ] **Step 1: Add the `transcript_events` table to `db.ts`'s schema**

Find the existing `build_requests` table block in `src/kernel/state/db.ts` (lines 285-304):

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

Add directly after it (this table must be created after `build_requests` since it references it):

```ts
  // One row per run_shell_command call the agentic coding loop makes,
  // in call order — the "View Activity" panel's data source. Cascades on
  // build_requests delete since a transcript is meaningless without its
  // parent build request.
  await db.query(`
    CREATE TABLE IF NOT EXISTS transcript_events (
      id SERIAL PRIMARY KEY,
      build_request_id INTEGER NOT NULL REFERENCES build_requests(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      command TEXT NOT NULL,
      stdout TEXT NOT NULL,
      stderr TEXT NOT NULL,
      exit_code INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS transcript_events_build_request_idx ON transcript_events(build_request_id, seq);`);
```

- [ ] **Step 2: Write `src/kernel/state/transcript-events-repo.ts`**

```ts
import { getPool } from "./db.js";

export interface TranscriptEventRow {
  id: number;
  build_request_id: number;
  seq: number;
  command: string;
  stdout: string;
  stderr: string;
  exit_code: number;
  created_at: Date;
}

// Best-effort like every write in build-requests-repo.ts — a missed
// transcript write must never abort the coding session itself, the loop's
// own error handling in coding-agent.ts is what matters for correctness.
export async function recordTranscriptEvent(
  buildRequestId: number,
  seq: number,
  command: string,
  stdout: string,
  stderr: string,
  exitCode: number
): Promise<void> {
  try {
    const db = getPool();
    await db.query(
      `INSERT INTO transcript_events (build_request_id, seq, command, stdout, stderr, exit_code) VALUES ($1, $2, $3, $4, $5, $6)`,
      [buildRequestId, seq, command, stdout, stderr, exitCode]
    );
  } catch {
    // Best-effort — see comment above.
  }
}

export async function listTranscriptEvents(buildRequestId: number): Promise<TranscriptEventRow[]> {
  try {
    const db = getPool();
    const { rows } = await db.query(
      `SELECT * FROM transcript_events WHERE build_request_id = $1 ORDER BY seq ASC`,
      [buildRequestId]
    );
    return rows;
  } catch {
    return [];
  }
}
```

- [ ] **Step 3: Add degrade-cleanly unit tests**

Add to `tests/index.test.ts`, in a new `Category: TranscriptEvents` block, matching the exact style of the existing `Category: Vault` degrade-cleanly tests (e.g. `"listNotes degrades cleanly when Postgres isn't reachable"` in that same file — read that block first to match the exact assertion helper and how those tests avoid a real DB connection):

```ts
test("Category: TranscriptEvents", "recordTranscriptEvent degrades cleanly when Postgres isn't reachable", async () => {
  await recordTranscriptEvent(999999, 1, "echo hi", "hi\n", "", 0);
  // No throw is the assertion — matches this file's existing degrade-cleanly tests.
});

test("Category: TranscriptEvents", "listTranscriptEvents degrades cleanly when Postgres isn't reachable", async () => {
  const events = await listTranscriptEvents(999999);
  assertEqual(events, []);
});
```

Add the import alongside the other repo imports in that file: `import { recordTranscriptEvent, listTranscriptEvents } from "../src/kernel/state/transcript-events-repo.js";`

- [ ] **Step 4: Run the test suite**

Run: `npm test`
Expected: all prior tests plus the 2 new `TranscriptEvents` tests pass.

- [ ] **Step 5: Typecheck**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/kernel/state/db.ts src/kernel/state/transcript-events-repo.ts tests/index.test.ts
git commit -m "feat: add the transcript_events table and repo"
```

---

### Task 3: The coding agent loop

**Files:**
- Create: `src/executive/coding-agent.ts`

**Interfaces:**
- Consumes: `createWorkspace`, `execInWorkspace` from `../kernel/builder-client.js` (Plan 1, existing — `createWorkspace(buildRequestId: number, baseBranch: string): Promise<WorkspaceHandle>`, `execInWorkspace(buildRequestId: number, command: string): Promise<{stdout: string; stderr: string; exitCode: number}>`). Consumes `recordTranscriptEvent` from Task 2. Consumes `callNvidiaChat`, `NvidiaMessage`, `NvidiaTool`, `NvidiaToolCall` from Task 1. Consumes `DraftedFile` type from `../kernel/state/build-requests-repo.js` (existing, `{path: string; content: string}`).
- Produces: `runCodingAgent(buildRequestId: number, objective: string, researchSummary: string, directionNotes: string, baseBranch: string, nvidiaApiKey: string | null): Promise<CodingAgentResult>` where `CodingAgentResult = {ok: true; summary: string; files: DraftedFile[]} | {ok: false; error: string}` — deliberately the same shape as the `CodeDraftResult` it replaces, so Task 4's call site barely changes. **Does not destroy the workspace on success** (Task 5 needs it alive through the approval checkpoint) — only destroys it on failure, since a failed session has nothing left to verify.

- [ ] **Step 1: Write `src/executive/coding-agent.ts`**

```ts
import { ObservationPlatform } from "../kernel/observation.js";
import * as builderClient from "../kernel/builder-client.js";
import { recordTranscriptEvent } from "../kernel/state/transcript-events-repo.js";
import { callNvidiaChat, NvidiaMessage, NvidiaTool } from "../runtime/nvidia-client.js";
import type { DraftedFile } from "../kernel/state/build-requests-repo.js";

const observation = ObservationPlatform.getInstance();

// Defense-in-depth alongside jarvis-builder's own 1-hour reaper (Plan 1) —
// bounds a model that never calls finish_coding, surfaced as an honest
// error rather than silently truncated (design spec, "The agentic loop").
const MAX_TURNS = 40;

const RUN_SHELL_TOOL: NvidiaTool = {
  type: "function",
  function: {
    name: "run_shell_command",
    description:
      "Run a shell command in the sandboxed workspace (cwd is the repository root) and get back stdout, stderr, and the exit code.",
    parameters: {
      type: "object",
      properties: { command: { type: "string", description: "The shell command to run." } },
      required: ["command"],
      additionalProperties: false,
    },
  },
};

const FINISH_CODING_TOOL: NvidiaTool = {
  type: "function",
  function: {
    name: "finish_coding",
    description:
      "Call this once the objective is fully implemented, tested, and ready for human review. Ends the coding session.",
    parameters: {
      type: "object",
      properties: { summary: { type: "string", description: "A concise summary of what was changed and why." } },
      required: ["summary"],
      additionalProperties: false,
    },
  },
};

export type CodingAgentResult = { ok: true; summary: string; files: DraftedFile[] } | { ok: false; error: string };

export async function runCodingAgent(
  buildRequestId: number,
  objective: string,
  researchSummary: string,
  directionNotes: string,
  baseBranch: string,
  nvidiaApiKey: string | null
): Promise<CodingAgentResult> {
  if (!nvidiaApiKey) {
    return { ok: false, error: "No NVIDIA_API_KEY is configured — the agentic coding loop is unavailable." };
  }

  try {
    await builderClient.createWorkspace(buildRequestId, baseBranch);
  } catch (err: any) {
    return { ok: false, error: `Failed to create the sandboxed workspace: ${err.message}` };
  }

  const messages: NvidiaMessage[] = [
    {
      role: "system",
      content:
        `You are Jarvis's coding agent, working alone in an isolated sandboxed git worktree at the repository root. ` +
        `Objective: ${objective}\n\nResearch summary:\n${researchSummary || "(none)"}\n\nConfirmed direction:\n${directionNotes}\n\n` +
        `You have exactly one tool for doing work — run_shell_command — plus finish_coding to end the session. ` +
        `Read files with cat, edit with heredocs or sed, run tests with the project's test command, check types, use git to ` +
        `inspect and commit your work. Call finish_coding once the objective is fully implemented and verified.`,
    },
  ];

  let seq = 0;

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const response = await callNvidiaChat(nvidiaApiKey, messages, [RUN_SHELL_TOOL, FINISH_CODING_TOOL]);

      if (!response.toolCalls || response.toolCalls.length === 0) {
        // A bare text reply with no tool call means the model is confused,
        // not finished — nudge it back rather than silently ending the loop.
        messages.push({ role: "assistant", content: response.content });
        messages.push({
          role: "user",
          content: "Use run_shell_command to keep working, or finish_coding if the objective is complete.",
        });
        continue;
      }

      messages.push({ role: "assistant", content: response.content, tool_calls: response.toolCalls });

      let finishedSummary: string | null = null;

      for (const call of response.toolCalls) {
        if (call.function.name === "finish_coding") {
          let summary = "Coding session finished.";
          try {
            const parsed = JSON.parse(call.function.arguments);
            if (typeof parsed.summary === "string" && parsed.summary.trim()) summary = parsed.summary;
          } catch {
            // Malformed arguments — fall back to the default summary rather than failing the whole session.
          }
          finishedSummary = summary;
          messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ ok: true }) });
          continue;
        }

        if (call.function.name === "run_shell_command") {
          let command = "";
          try {
            const parsed = JSON.parse(call.function.arguments);
            command = typeof parsed.command === "string" ? parsed.command : "";
          } catch {
            messages.push({
              role: "tool",
              tool_call_id: call.id,
              content: JSON.stringify({ error: "Malformed arguments — command must be valid JSON with a string 'command' field." }),
            });
            continue;
          }
          if (!command) {
            messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ error: "command was empty." }) });
            continue;
          }

          const result = await builderClient
            .execInWorkspace(buildRequestId, command)
            .catch((err: any) => ({ stdout: "", stderr: err.message || String(err), exitCode: -1 }));

          seq++;
          await recordTranscriptEvent(buildRequestId, seq, command, result.stdout, result.stderr, result.exitCode);

          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: JSON.stringify({
              stdout: result.stdout.slice(0, 8000),
              stderr: result.stderr.slice(0, 4000),
              exitCode: result.exitCode,
            }),
          });
          continue;
        }

        // Unknown tool name — only two tools are offered, but a model can hallucinate a call.
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ error: `Unknown tool: ${call.function.name}` }) });
      }

      if (finishedSummary !== null) {
        const files = await extractChangedFiles(buildRequestId, baseBranch);
        if (files.length === 0) {
          await builderClient.destroyWorkspace(buildRequestId).catch(() => {});
          return { ok: false, error: "The coding session finished but left no changed files to propose." };
        }
        return { ok: true, summary: finishedSummary, files };
      }
    }

    await builderClient.destroyWorkspace(buildRequestId).catch(() => {});
    return { ok: false, error: `The coding session hit its ${MAX_TURNS}-turn limit without calling finish_coding.` };
  } catch (err: any) {
    observation.logTelemetry("warn", "Executive", `Coding agent loop failed for build request #${buildRequestId}: ${err.message}`);
    await builderClient.destroyWorkspace(buildRequestId).catch(() => {});
    return { ok: false, error: `The coding session failed: ${err.message}` };
  }
}

// Reads back whatever the agent actually left on disk (committed or not) by
// diffing the working tree against the base branch it started from — the
// worktree, not any model-recalled text, is the source of truth for what
// gets proposed at the approval checkpoint. `origin/<baseBranch>` resolves
// correctly here even after the sandbox's staging worktree is gone (Plan
# 1's cdf56be) because it's a remote-tracking ref to already-fetched
// objects, not a live connection to that path — confirmed live during
// Plan 1's verification.
async function extractChangedFiles(buildRequestId: number, baseBranch: string): Promise<DraftedFile[]> {
  const diffResult = await builderClient.execInWorkspace(buildRequestId, `git diff --name-only origin/${baseBranch}`);
  const paths = diffResult.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const files: DraftedFile[] = [];
  for (const path of paths) {
    const catResult = await builderClient.execInWorkspace(buildRequestId, `cat "${path}"`);
    if (catResult.exitCode === 0) {
      files.push({ path, content: catResult.stdout });
    }
  }
  return files;
}
```

**Note on the stray `#` above:** the comment block contains a line starting `# 1's cdf56be` — this is a typo, it must read `// 1's cdf56be` (a continuation of the `//` comment above it, not a new directive). Write it as a proper `//`-prefixed continuation line, not literally as shown — this plan's markdown rendering broke the comment across lines oddly; the intent is one continuous `//` comment block.

- [ ] **Step 2: Typecheck**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 3: Run the existing test suite (no new tests in this task, per this plan's Global Constraints)**

Run: `npm test`
Expected: same pass count as after Task 2, all green — this file has no automated tests of its own (Docker/NVIDIA-dependent orchestration, matching the `github.ts`/`jarvis-builder` precedent).

- [ ] **Step 4: Commit**

```bash
git add src/executive/coding-agent.ts
git commit -m "feat: add the multi-turn agentic coding loop against NVIDIA NIM"
```

---

### Task 4: Wire the coding agent into `confirmDirection`, remove `draftCodeChanges`

**Files:**
- Modify: `src/executive/autonomous_executive.ts`
- Modify: `src/executive/departments.ts` (remove now-dead `draftCodeChanges`/`CODE_DRAFT_SCHEMA`)
- Modify: `src/server.ts` (thread `nvidiaApiKey` into `AutonomousExecutive.getInstance`)

**Interfaces:**
- Consumes: `runCodingAgent` from Task 3, `nvidiaApiKey` local from Task 1's `server.ts` change.
- Produces: `AutonomousExecutive.getInstance(observation?, ai?, groq?, nvidiaApiKey?)` — a new optional 4th parameter, backward compatible with the one other call site (`tools.ts`, which calls `getInstance()` with no arguments to reach the already-initialized singleton — confirm this via grep before editing, since a signature change here must not break that call site's positional arguments).

- [ ] **Step 1: Add `nvidiaApiKey` to `AutonomousExecutive`'s constructor and singleton accessor**

In `src/executive/autonomous_executive.ts`, find:

```ts
export class AutonomousExecutive {
  private static instance: AutonomousExecutive | null = null;
  private observation: ObservationPlatform;
  // Kept for future needs (per the Groq-migration design) even though no current internal call reads it — every departments.* call below uses this.groq.
  private ai: GoogleGenAI | null;
  private groq: Groq | null;

  private constructor(observation: ObservationPlatform, ai: GoogleGenAI | null, groq: Groq | null) {
    this.observation = observation;
    this.ai = ai;
    this.groq = groq;
  }

  // A singleton (like the other cognition engines) rather than a plain
  // constructor so tools.ts's decompose_plan/confirm_build_direction tools
  // can reach the same instance server.ts already created at startup with
  // the real ai/groq clients, instead of needing a circular import back
  // into server.ts.
  public static getInstance(observation?: ObservationPlatform, ai?: GoogleGenAI | null, groq?: Groq | null): AutonomousExecutive {
    if (!this.instance) {
      if (!observation) {
        throw new Error("AutonomousExecutive.getInstance() called before server.ts initialized it");
      }
      this.instance = new AutonomousExecutive(observation, ai ?? null, groq ?? null);
    }
    return this.instance;
  }
```

Replace with:

```ts
export class AutonomousExecutive {
  private static instance: AutonomousExecutive | null = null;
  private observation: ObservationPlatform;
  // Kept for future needs (per the Groq-migration design) even though no current internal call reads it — every departments.* call below uses this.groq.
  private ai: GoogleGenAI | null;
  private groq: Groq | null;
  private nvidiaApiKey: string | null;

  private constructor(observation: ObservationPlatform, ai: GoogleGenAI | null, groq: Groq | null, nvidiaApiKey: string | null) {
    this.observation = observation;
    this.ai = ai;
    this.groq = groq;
    this.nvidiaApiKey = nvidiaApiKey;
  }

  // A singleton (like the other cognition engines) rather than a plain
  // constructor so tools.ts's decompose_plan/confirm_build_direction tools
  // can reach the same instance server.ts already created at startup with
  // the real ai/groq/nvidia clients, instead of needing a circular import
  // back into server.ts.
  public static getInstance(
    observation?: ObservationPlatform,
    ai?: GoogleGenAI | null,
    groq?: Groq | null,
    nvidiaApiKey?: string | null
  ): AutonomousExecutive {
    if (!this.instance) {
      if (!observation) {
        throw new Error("AutonomousExecutive.getInstance() called before server.ts initialized it");
      }
      this.instance = new AutonomousExecutive(observation, ai ?? null, groq ?? null, nvidiaApiKey ?? null);
    }
    return this.instance;
  }
```

- [ ] **Step 2: Confirm the only other `getInstance` call site is unaffected**

Run: `grep -rn "AutonomousExecutive.getInstance" src/`
Expected: two call sites — `src/server.ts:222` (the one you're about to update in Step 4) and one inside `src/executive/tools.ts` (or wherever `decompose_plan`/`confirm_build_direction` tools live) calling `getInstance()` with **zero** arguments. Confirm the zero-argument call site still compiles fine — it will, since all 4 parameters are optional and it only ever runs after `server.ts` has already created the real singleton with real arguments.

- [ ] **Step 3: Replace the `draftCodeChanges` call in `confirmDirection`**

In `src/executive/autonomous_executive.ts`, find `confirmDirection` (lines 250-304):

```ts
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
      this.groq
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
```

Replace with:

```ts
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

    let baseBranch = "main";
    const owner = process.env.SELF_REPO_OWNER;
    const repoName = process.env.SELF_REPO_NAME;
    if (owner && repoName) {
      try {
        const repoInfo = await github.getRepo(owner, repoName);
        baseBranch = repoInfo.default_branch;
      } catch {
        // Fall back to "main" — matches this codebase's degrade-cleanly convention.
      }
    }

    const draft = await codingAgent.runCodingAgent(
      confirmed.id,
      confirmed.objective,
      confirmed.research_summary || "",
      directionNotes,
      baseBranch,
      this.nvidiaApiKey
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
```

The rest of `confirmDirection` (the `recorded`/`obsidian.writeOrUpdateCodingNote`/`scheduler.pushNotification`/final `return` block, lines 280-304) is unchanged — `draft.summary`/`draft.files` still exist on the new `CodingAgentResult` success shape, so nothing below this point needs editing.

- [ ] **Step 4: Add the new imports**

At the top of `src/executive/autonomous_executive.ts`, add:

```ts
import * as codingAgent from "./coding-agent.js";
import * as github from "../capabilities/providers/github.js";
```

alongside the existing `import * as departments from "./departments.js";` line.

- [ ] **Step 5: Thread `nvidiaApiKey` through in `server.ts`**

In `src/server.ts`, find:

```ts
const executive = AutonomousExecutive.getInstance(observation, ai, groq);
```

Replace with:

```ts
const executive = AutonomousExecutive.getInstance(observation, ai, groq, nvidiaApiKey);
```

(This line must come after Task 1 Step 6's `nvidiaApiKey` declaration in the same file — confirm `nvidiaApiKey` is already declared above this line; if `server.ts`'s existing initialization order puts this line before Task 1 Step 6's block, move Task 1 Step 6's block earlier so `nvidiaApiKey` is declared before this line uses it.)

- [ ] **Step 6: Remove the now-dead `draftCodeChanges` and `CODE_DRAFT_SCHEMA` from `departments.ts`**

Run: `grep -rn "draftCodeChanges\|CODE_DRAFT_SCHEMA" src/` first, to confirm the only remaining references are the definitions themselves in `src/executive/departments.ts` (the call site in `autonomous_executive.ts` was just removed in Step 3). If any other reference turns up, stop and investigate before deleting.

Delete the `CODE_DRAFT_SCHEMA` constant and the `draftCodeChanges` function (and its `CodeDraftResult` type) from `src/executive/departments.ts` — the exact block described in this plan's research as lines 263-326 in the pre-Task-4 file (re-locate by searching for `CODE_DRAFT_SCHEMA` and `export async function draftCodeChanges`, since line numbers will have shifted from other work on this branch). **Leave `reviewCodeDiff` and everything else in this file untouched** — it's still called from `server.ts`'s approve-code route (Task 5) for the post-PR QA step, unchanged by this plan. Leave the `Type` and `toGroqSchema` imports in place — both are still used elsewhere in this file (`DEPARTMENT_DECOMPOSITION_SCHEMA`, `RESEARCH_LOOKUPS_SCHEMA`), confirmed via the same grep above.

- [ ] **Step 7: Typecheck**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 8: Run the test suite**

Run: `npm test`
Expected: same pass count as after Task 2/3, all green.

- [ ] **Step 9: Commit**

```bash
git add src/executive/autonomous_executive.ts src/executive/departments.ts src/server.ts
git commit -m "feat: wire the agentic coding loop into confirmDirection, remove draftCodeChanges"
```

---

### Task 5: Final verification gate + workspace teardown in the approve/reject routes

**Files:**
- Modify: `src/server.ts` (rewrite `POST /api/system/build-requests/:id/approve-code`, add workspace teardown to `POST /api/system/build-requests/:id/reject-code`)

**Interfaces:**
- Consumes: `execInWorkspace`, `destroyWorkspace` from `../kernel/builder-client.js` (Plan 1, existing).

- [ ] **Step 1: Add the builder-client import**

In `src/server.ts`, add alongside the other `import * as ... from "./...js"` lines near the top: `import * as builderClient from "./kernel/builder-client.js";`

- [ ] **Step 2: Rewrite the approve-code route**

Find the full existing route (`server.ts:1774-1901`, shown in full below) and replace it in its entirety:

```ts
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

    // Closing the gap noted above: reject the whole approval loudly and
    // cleanly if any proposed file targets a path outside the intended
    // scope (traversal, absolute path, or a null byte) — never commit any
    // of them.
    const unsafePaths = files.map((f) => f.path).filter(isUnsafeProposedPath);
    if (unsafePaths.length > 0) {
      const message = `Refusing to commit unsafe file path(s): ${unsafePaths.join(", ")}`;
      await buildRequestsRepo.markPrError(buildRequest.id, message);
      return res.status(422).json({ error: message });
    }

    // From here on, this build request's sandbox workspace (Plan 1) is
    // still alive — it was deliberately kept alive since coding-agent.ts's
    // finish_coding, specifically so this verification pass can run
    // against the exact on-disk state the coding session actually left,
    // not any residual/stateful assumption about it. Whatever happens next
    // (success or any failure below), the workspace's job ends here — torn
    // down exactly once, in `finally`, so no future edit to any branch
    // below can forget to.
    try {
      // Final verification: a fresh install and the full test suite/typecheck
      // — not trusting whatever state the free-reign coding session happened
      // to leave the container in — so this reflects exactly what's about to
      // be committed, per the design spec's testing-and-deployment checkpoint.
      let verify: { stdout: string; stderr: string; exitCode: number };
      try {
        verify = await builderClient.execInWorkspace(
          buildRequest.id,
          "rm -rf node_modules && npm ci && npm test && npx tsc --noEmit"
        );
      } catch (err: any) {
        const message = `Final verification could not run: ${err.message}`;
        await buildRequestsRepo.markPrError(buildRequest.id, message);
        return res.status(502).json({ error: message });
      }
      if (verify.exitCode !== 0) {
        const message = `Final verification failed (exit ${verify.exitCode}):\n${verify.stdout.slice(-2000)}\n${verify.stderr.slice(-2000)}`;
        await buildRequestsRepo.markPrError(buildRequest.id, message);
        return res.status(422).json({ error: message });
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

      obsidian.writeOrUpdateCodingNote(updated.id, updated.objective, {
        directionNotes: updated.direction_notes || undefined,
        codeSummary: updated.code_summary || undefined,
        files: files.map((f: any) => f.path),
        prUrl: updated.pr_url || undefined,
        status: updated.status,
      }).catch((err: any) => {
        observation.logTelemetry("warn", "Interaction", `Failed to write coding vault note: ${err.message}`);
      });

      // QA runs immediately, synchronously, right here — no CI polling (see
      // design spec's "Decisions"). CI's own result speaks for itself on
      // GitHub, same as any other PR.
      const qaSummary = await departments.reviewCodeDiff(updated.objective, files, groq);
      await buildRequestsRepo.recordQaReview(updated.id, qaSummary);

      obsidian.writeOrUpdateCodingNote(updated.id, updated.objective, {
        directionNotes: updated.direction_notes || undefined,
        codeSummary: updated.code_summary || undefined,
        files: files.map((f: any) => f.path),
        prUrl: updated.pr_url || undefined,
        qaSummary,
        status: "qa_complete",
      }).catch((err: any) => {
        observation.logTelemetry("warn", "Interaction", `Failed to write coding vault note: ${err.message}`);
      });

      scheduler.pushNotification(
        req.username,
        `Opened the pull request for build request #${updated.id}, sir: ${pr.html_url}. QA review: ${qaSummary.slice(0, 300)}${qaSummary.length > 300 ? "..." : ""} Check GitHub for CI status.`,
        "info"
      );

      res.json({ ...updated, qa_summary: qaSummary });
    } finally {
      await builderClient.destroyWorkspace(buildRequest.id).catch(() => {});
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
```

This is a structural rewrite, not a small edit: everything from the final-verification check through the end of the route is now nested inside an inner `try { ... } finally { destroyWorkspace }` block, so the workspace is torn down exactly once regardless of which of the many `return` statements fires. The route's early-return validation (build-request lookup, empty-files check, unsafe-path check) stays outside that inner block since it never touches the workspace.

- [ ] **Step 3: Add workspace teardown to the reject-code route**

Find the existing route (`server.ts:1903-1915`):

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

Replace with:

```ts
app.post("/api/system/build-requests/:id/reject-code", validateApiKey, async (req: any, res: any) => {
  if (!permissions.hasGrant(req.username, "github.pulls.create")) {
    return res.status(403).json({ error: 'Missing capability grant "github.pulls.create"' });
  }
  try {
    const updated = await buildRequestsRepo.rejectCode(Number(req.params.id));
    if (!updated) return res.status(404).json({ error: "Build request not found or not awaiting code approval" });
    await builderClient.destroyWorkspace(updated.id).catch(() => {});
    observation.logAuditEvent(req.username, "build_request_code_rejected", "success", `#${updated.id}`);
    res.json(updated);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
```

- [ ] **Step 4: Typecheck**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 5: Run the test suite**

Run: `npm test`
Expected: same pass count as after Task 4, all green.

- [ ] **Step 6: Commit**

```bash
git add src/server.ts
git commit -m "feat: add final verification gate and workspace teardown to the approve/reject routes"
```

---

### Task 6: Transcript route + dashboard "View Activity" panel

**Files:**
- Modify: `src/server.ts` (add `GET /api/system/build-requests/:id/transcript`)
- Modify: `src/interaction/static/index.html` (add the transcript panel + "View activity" button)

**Interfaces:**
- Consumes: `listTranscriptEvents` from Task 2.

- [ ] **Step 1: Add the transcript route**

In `src/server.ts`, find the existing `GET /api/system/build-requests` route (lines 1747-1756):

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

Add directly after it:

```ts
app.get("/api/system/build-requests/:id/transcript", validateApiKey, async (req: any, res: any) => {
  if (!permissions.hasGrant(req.username, "github.pulls.create")) {
    return res.status(403).json({ error: 'Missing capability grant "github.pulls.create"' });
  }
  try {
    res.json({ events: await transcriptEventsRepo.listTranscriptEvents(Number(req.params.id)) });
  } catch (err: any) {
    res.json({ events: [], error: err.message });
  }
});
```

Add the import alongside the other repo imports near the top of `src/server.ts`: `import * as transcriptEventsRepo from "./kernel/state/transcript-events-repo.js";`

- [ ] **Step 2: Add the transcript panel to `index.html`**

Find the build-requests panel in `src/interaction/static/index.html` (lines 331-340):

```html
                <div class="holo-panel rounded-2xl p-5 w-full">
                    <div class="flex justify-between items-center mb-4">
                        <h3 class="font-display font-semibold text-sm text-white">Build Requests</h3>
                        <span id="build-requests-count-badge" class="px-2 py-0.5 rounded-full bg-white/5 border border-white/10 text-[11px] text-secondary">0 active</span>
                    </div>
                    <div id="build-requests-list" class="space-y-2.5">
                        <div class="text-secondary text-center w-full py-6 text-sm opacity-60">Nothing yet — ask Jarvis to build something new to see it here.</div>
                    </div>
                </div>
            </div>
```

Replace with (adds a second, initially-hidden panel right after the build-requests list, still inside `view-projects`):

```html
                <div class="holo-panel rounded-2xl p-5 w-full">
                    <div class="flex justify-between items-center mb-4">
                        <h3 class="font-display font-semibold text-sm text-white">Build Requests</h3>
                        <span id="build-requests-count-badge" class="px-2 py-0.5 rounded-full bg-white/5 border border-white/10 text-[11px] text-secondary">0 active</span>
                    </div>
                    <div id="build-requests-list" class="space-y-2.5">
                        <div class="text-secondary text-center w-full py-6 text-sm opacity-60">Nothing yet — ask Jarvis to build something new to see it here.</div>
                    </div>
                </div>
                <div id="build-request-transcript-panel" class="holo-panel rounded-2xl p-5 w-full hidden">
                    <div class="flex justify-between items-center mb-4">
                        <h3 class="font-display font-semibold text-sm text-white">Activity — <span id="build-request-transcript-title"></span></h3>
                        <button onclick="closeBuildRequestTranscript()" class="px-2 py-0.5 rounded-full bg-white/5 border border-white/10 text-[11px] text-secondary hover:text-white">Close</button>
                    </div>
                    <div id="build-request-transcript-body" class="space-y-2 max-h-[480px] overflow-y-auto font-mono text-[11px]"></div>
                </div>
            </div>
```

- [ ] **Step 3: Add the "View activity" button, cache the loaded requests, and add the fetch/render/close functions**

Find `loadBuildRequests` in `src/interaction/static/index.html` (lines 2616-2657):

```js
    async function loadBuildRequests() {
        if (!CURRENT_API_KEY) return; // not logged in yet — nothing to poll for
        try {
            const headers = { 'X-API-Key': CURRENT_API_KEY };
            const res = await authFetch('/api/system/build-requests', { headers });
            if (!res.ok) return;
            const data = await res.json();
            const requests = data.buildRequests || [];

            const activeCount = requests.filter(r => !BUILD_REQUEST_TERMINAL_STATUSES.includes(r.status)).length;
            document.getElementById('build-requests-count-badge').textContent = `${activeCount} ACTIVE`;

            const list = document.getElementById('build-requests-list');
            if (requests.length === 0) {
                list.innerHTML = `<div class="text-secondary text-center w-full py-6 text-xs uppercase tracking-widest font-mono opacity-50">Nothing yet — ask Jarvis to build something new to see it here.</div>`;
                return;
            }
            list.innerHTML = requests.map(r => {
                const style = BUILD_REQUEST_STATUS_STYLE[r.status] || BUILD_REQUEST_STATUS_STYLE.researching;
                const summary = r.qa_summary || r.code_summary || r.direction_notes || r.research_summary;
                const approveReject = r.status === 'awaiting_code_approval' ? `
                    <div class="flex gap-2 mt-2">
                        <button onclick="approveBuildRequest(${r.id})" class="flex-1 px-2 py-1 rounded border border-success/25 text-success bg-success/5 text-[10px] font-mono font-bold uppercase tracking-widest hover:bg-success/10">Approve</button>
                        <button onclick="rejectBuildRequest(${r.id})" class="flex-1 px-2 py-1 rounded border border-danger/25 text-danger bg-danger/5 text-[10px] font-mono font-bold uppercase tracking-widest hover:bg-danger/10">Reject</button>
                    </div>
                ` : '';
                const prLink = r.pr_url ? `<a href="${escapeHtml(r.pr_url)}" target="_blank" rel="noopener noreferrer" class="text-[10px] text-primary underline block mt-1.5">View pull request &rarr;</a>` : '';
                return `
                    <div class="holo-chip border ${style.classes.split(' ')[0]} rounded-xl p-3.5">
                        <div class="flex items-center justify-between mb-1.5">
                            <span class="font-display font-bold text-xs text-white">${escapeHtml(r.objective)}</span>
                            <span class="px-1.5 py-0.5 rounded border text-[8px] font-mono font-bold tracking-widest uppercase whitespace-nowrap ${style.classes}">${style.label}</span>
                        </div>
                        ${summary ? `<p class="text-[11px] text-text/80 leading-snug mb-1.5">${escapeHtml(summary.slice(0, 300))}</p>` : ''}
                        ${prLink}
                        ${approveReject}
                        <span class="text-[8px] text-secondary font-mono mt-1.5 block">${new Date(r.created_at).toLocaleString()}</span>
                    </div>
                `;
            }).join('');
        } catch {}
    }
```

Replace with (adds a `BUILD_REQUESTS_CACHE` array so the activity viewer can look up an objective by id without embedding free-text objective content into an `onclick` attribute — objectives are untrusted, free-typed text and could contain a `"` that would break out of the attribute otherwise; adds the "View activity" button; adds `viewBuildRequestActivity`/`closeBuildRequestTranscript`):

```js
    let BUILD_REQUESTS_CACHE = [];

    async function loadBuildRequests() {
        if (!CURRENT_API_KEY) return; // not logged in yet — nothing to poll for
        try {
            const headers = { 'X-API-Key': CURRENT_API_KEY };
            const res = await authFetch('/api/system/build-requests', { headers });
            if (!res.ok) return;
            const data = await res.json();
            const requests = data.buildRequests || [];
            BUILD_REQUESTS_CACHE = requests;

            const activeCount = requests.filter(r => !BUILD_REQUEST_TERMINAL_STATUSES.includes(r.status)).length;
            document.getElementById('build-requests-count-badge').textContent = `${activeCount} ACTIVE`;

            const list = document.getElementById('build-requests-list');
            if (requests.length === 0) {
                list.innerHTML = `<div class="text-secondary text-center w-full py-6 text-xs uppercase tracking-widest font-mono opacity-50">Nothing yet — ask Jarvis to build something new to see it here.</div>`;
                return;
            }
            list.innerHTML = requests.map(r => {
                const style = BUILD_REQUEST_STATUS_STYLE[r.status] || BUILD_REQUEST_STATUS_STYLE.researching;
                const summary = r.qa_summary || r.code_summary || r.direction_notes || r.research_summary;
                const approveReject = r.status === 'awaiting_code_approval' ? `
                    <div class="flex gap-2 mt-2">
                        <button onclick="approveBuildRequest(${r.id})" class="flex-1 px-2 py-1 rounded border border-success/25 text-success bg-success/5 text-[10px] font-mono font-bold uppercase tracking-widest hover:bg-success/10">Approve</button>
                        <button onclick="rejectBuildRequest(${r.id})" class="flex-1 px-2 py-1 rounded border border-danger/25 text-danger bg-danger/5 text-[10px] font-mono font-bold uppercase tracking-widest hover:bg-danger/10">Reject</button>
                    </div>
                ` : '';
                const prLink = r.pr_url ? `<a href="${escapeHtml(r.pr_url)}" target="_blank" rel="noopener noreferrer" class="text-[10px] text-primary underline block mt-1.5">View pull request &rarr;</a>` : '';
                return `
                    <div class="holo-chip border ${style.classes.split(' ')[0]} rounded-xl p-3.5">
                        <div class="flex items-center justify-between mb-1.5">
                            <span class="font-display font-bold text-xs text-white">${escapeHtml(r.objective)}</span>
                            <span class="px-1.5 py-0.5 rounded border text-[8px] font-mono font-bold tracking-widest uppercase whitespace-nowrap ${style.classes}">${style.label}</span>
                        </div>
                        ${summary ? `<p class="text-[11px] text-text/80 leading-snug mb-1.5">${escapeHtml(summary.slice(0, 300))}</p>` : ''}
                        ${prLink}
                        <button onclick="viewBuildRequestActivity(${r.id})" class="text-[10px] text-primary underline block mt-1.5">View activity &rarr;</button>
                        ${approveReject}
                        <span class="text-[8px] text-secondary font-mono mt-1.5 block">${new Date(r.created_at).toLocaleString()}</span>
                    </div>
                `;
            }).join('');
        } catch {}
    }

    async function viewBuildRequestActivity(id) {
        if (!CURRENT_API_KEY) return;
        const panel = document.getElementById('build-request-transcript-panel');
        const title = document.getElementById('build-request-transcript-title');
        const body = document.getElementById('build-request-transcript-body');
        const cached = BUILD_REQUESTS_CACHE.find(r => r.id === id);
        title.textContent = cached ? `#${id} — ${cached.objective}` : `#${id}`;
        body.innerHTML = `<div class="text-secondary text-xs opacity-60">Loading...</div>`;
        panel.classList.remove('hidden');
        panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        try {
            const headers = { 'X-API-Key': CURRENT_API_KEY };
            const res = await authFetch(`/api/system/build-requests/${id}/transcript`, { headers });
            const data = await res.json();
            const events = data.events || [];
            if (events.length === 0) {
                body.innerHTML = `<div class="text-secondary text-xs opacity-60">No activity recorded yet.</div>`;
                return;
            }
            body.innerHTML = events.map(e => {
                const ok = e.exit_code === 0;
                return `
                    <div class="holo-chip border ${ok ? 'border-success/20' : 'border-danger/20'} rounded-lg p-2.5">
                        <div class="flex items-center justify-between mb-1">
                            <span class="text-white">$ ${escapeHtml(e.command)}</span>
                            <span class="px-1.5 py-0.5 rounded border text-[9px] font-bold uppercase tracking-widest ${ok ? 'border-success/25 text-success bg-success/5' : 'border-danger/25 text-danger bg-danger/5'}">exit ${e.exit_code}</span>
                        </div>
                        ${e.stdout ? `<pre class="text-text/70 whitespace-pre-wrap break-words">${escapeHtml(e.stdout.slice(0, 2000))}</pre>` : ''}
                        ${e.stderr ? `<pre class="text-danger/70 whitespace-pre-wrap break-words">${escapeHtml(e.stderr.slice(0, 2000))}</pre>` : ''}
                    </div>
                `;
            }).join('');
        } catch {
            body.innerHTML = `<div class="text-danger text-xs">Failed to load activity.</div>`;
        }
    }

    function closeBuildRequestTranscript() {
        document.getElementById('build-request-transcript-panel').classList.add('hidden');
    }
```

- [ ] **Step 4: Typecheck**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 5: Run the test suite**

Run: `npm test`
Expected: same pass count as after Task 5, all green.

- [ ] **Step 6: Commit**

```bash
git add src/server.ts src/interaction/static/index.html
git commit -m "feat: add the transcript route and dashboard activity panel"
```

---

## Final Verification (manual, against a real running instance — not automatable)

Per this plan's Global Constraints, the agentic loop and the final-verification gate depend entirely on live external systems (a real Docker daemon via `jarvis-builder`, a real NVIDIA API key, a real GitHub repo) that no subagent in this workflow has access to — the same situation Plan 1 was in, where 3 real bugs were found only through direct live testing. After all 6 tasks are reviewed and merged to this branch, live-verify directly (not delegated):

1. Confirm `NVIDIA_API_KEY` is actually present in the real running stack's `.env` — it was not added to `.env.example` with a real value (by design, `.env.example` never holds real secrets) and this plan's research found **zero** existing references to it anywhere in this repo's config, meaning the real key the user provided earlier this session still needs to be added to the live `.env` file directly (not committed, not echoed) before this can be tested end-to-end.
2. Trigger a real build request through to `direction_confirmed`, and confirm `confirmDirection` actually creates a sandbox workspace, drives a real multi-turn NVIDIA tool-calling loop, and reaches `awaiting_code_approval` with real transcript events persisted (check `GET /api/system/build-requests/:id/transcript` returns real command/stdout/stderr rows).
3. Confirm the chosen `NVIDIA_MODEL` (default `meta/llama-3.1-70b-instruct`) actually supports tool-calling correctly against NVIDIA NIM's real API — the design spec explicitly flags this as unverified; if it doesn't behave correctly, adjust `NVIDIA_MODEL` in the real `.env` (no code change needed, per Task 1's design) or revisit the default in code if a different model proves necessary.
4. Approve the build request and confirm: the final verification pass actually runs fresh `npm ci`/`npm test`/`npx tsc --noEmit` inside the sandbox, a real PR opens on GitHub sourced from the sandbox's real on-disk diff (not regenerated text), and the workspace container + worktree are fully destroyed afterward (`docker ps`/`git worktree list` show no residue, mirroring Plan 1's verification method).
5. Reject a separate build request and confirm its workspace is also destroyed.
6. Open the dashboard's "View activity" panel for a completed build request and confirm it renders the real transcript.

Only after this passes should the branch proceed through `superpowers:finishing-a-development-branch`.
