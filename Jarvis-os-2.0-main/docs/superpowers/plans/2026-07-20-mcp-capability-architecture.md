# MCP Capability Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **This plan is not scheduled for execution as of the pass that wrote it.** Per roadmap Phase 4's own framing ("this phase is a design project, not a feature; its 'done' is a decision, not a merge"), writing this plan is the deliverable — running it is a separate, later decision. Whoever picks this plan up to execute it should re-verify the SDK version pin in Task 2 Step 1 hasn't drifted (`@modelcontextprotocol/sdk` moves fast) before starting.

**Goal:** Let Jarvis call out to independently-deployed, independently-reviewable MCP (Model Context Protocol) servers as tools, with the same human-gated trust model and capability-grant system every existing tool already uses — without touching any of the 24 existing hand-coded tools' behavior.

**Architecture:** A new `mcp_servers` table + `src/execution/mcp-registry.ts` module owns server registration (propose → admin-approved-with-a-live-connection-test → cached tool list), using the official `@modelcontextprotocol/sdk` as an MCP client over Streamable HTTP. Each MCP tool becomes a capability string (`mcp.<server>.<tool>`) in the *existing* grant system — no changes to `hasGrant`/`grantCapability` themselves. `src/execution/tools.ts` gains a dynamic tool-declaration merge and one new `executeTool` dispatch branch; a new scheduled job re-checks approved servers' health.

**Tech Stack:** TypeScript, `@modelcontextprotocol/sdk` (new dependency), Express, `pg`, `@google/genai` function-calling, the existing hand-rolled `tests/index.test.ts` harness.

## Global Constraints

- **New dependency: `@modelcontextprotocol/sdk`, pinned to `^1.29.0`.** This is the *stable* published package. A newer, still-`beta`-tagged rewrite (`@modelcontextprotocol/client`, currently `2.0.0-beta.4`) exists upstream but is not production-appropriate — do not use it, and do not follow any documentation that references `@modelcontextprotocol/client` or a `Client`/`StreamableHTTPClientTransport` import from that package. This plan's code targets `@modelcontextprotocol/sdk`'s v1 API specifically: `import { Client } from "@modelcontextprotocol/sdk/client/index.js"` and `import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"`.
- `mcp_servers` is a brand-new table — a plain `CREATE TABLE IF NOT EXISTS` is sufficient (unlike Phase 3's `command_proposals` migration, there is no existing live table to `ALTER`).
- Registering a new MCP server requires the **new** `system.mcp_manage` capability — do not gate it behind `system.execute` (see design spec's rationale: registering a capability source is a categorically different, higher-stakes action than running one already-reviewed command).
- Per-tool grants for MCP-sourced tools use capability strings of the exact form `mcp.<serverName>.<toolName>` — no other separator, no capitalization changes to the server/tool names beyond what's already validated at cache time (Task 2).
- A server is marked `approved` **only** after a live `connect()` + `listTools()` round-trip succeeds inside `approveMcpServer` itself — never on the strength of the admin's approval action alone.
- Every MCP-touching function that isn't the live connection test itself must degrade to a safe value (never throw past its own boundary) on a network/DB failure — `getCachedMcpTools()` → `[]`, `callMcpTool()` → a clean error result, matching every repo function added in Phases 1-3.
- No existing tool's declaration, gating, or `executeTool` case changes. All work here is additive.
- Every DB-dependent test runs in `tests/index.test.ts`, which never calls `initDatabase()` — verify degrade-safety the same way every prior phase did. Tests that would require a live MCP server connection are explicitly out of scope for this plan's test steps (see each task's Testing note) — they're deferred to live verification whenever this plan is actually executed.
- Match existing code style exactly: `src/data/command-proposals-repo.ts` for the repo layer's propose/approve shape, `src/execution/tools.ts`'s existing `set_objective`/`propose_command` cases for the tool layer, `src/execution/scheduler.ts`'s `registerJob` for the health-check job.

---

### Task 1: Schema + basic repo functions (no MCP SDK yet)

**Files:**
- Modify: `src/data/db.ts` (add the `mcp_servers` table)
- Create: `src/data/mcp-servers-repo.ts`
- Test: `tests/index.test.ts`

**Interfaces:**
- Produces: `McpServerRow` interface and `proposeMcpServer(name, url, registeredBy): Promise<McpServerRow>`, `getMcpServer(id): Promise<McpServerRow | null>`, `listMcpServers(status?): Promise<McpServerRow[]>`, `markMcpServerApproved(id): Promise<McpServerRow | null>`, `markMcpServerError(id, error): Promise<void>`, `setMcpServerStatus(id, status: "error" | "disabled"): Promise<McpServerRow | null>` — all exported from `src/data/mcp-servers-repo.ts`. Task 2's registry module and Task 4's routes/tool both call these by name. (There is deliberately no separate `disableMcpServer` wrapper — `setMcpServerStatus(id, "disabled")` covers it directly, avoiding a redundant one-line wrapper around a single query; Task 4's disable route calls `setMcpServerStatus` for this reason.)

- [ ] **Step 1: Add the `mcp_servers` table**

In `src/data/db.ts`, find `createSchema()` and add this block after the `command_proposals` table/index statements (after the line `await db.query(\`CREATE INDEX IF NOT EXISTS command_proposals_outcome_idx ...\`);` added in Phase 3):

```ts
  await db.query(`
    CREATE TABLE IF NOT EXISTS mcp_servers (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      url TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      registered_by TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      approved_at TIMESTAMPTZ,
      last_connected_at TIMESTAMPTZ,
      last_error TEXT
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS mcp_servers_status_idx ON mcp_servers(status);`);
```

This is a brand-new table (unlike `command_proposals` in Phase 3) — no `ALTER TABLE` needed.

- [ ] **Step 2: Create the repo file**

Create `src/data/mcp-servers-repo.ts`:

```ts
import { getPool } from "./db.js";

export interface McpServerRow {
  id: number;
  name: string;
  url: string;
  status: "pending" | "approved" | "rejected" | "disabled" | "error";
  registered_by: string;
  created_at: Date;
  approved_at: Date | null;
  last_connected_at: Date | null;
  last_error: string | null;
}

// A genuine write with no sensible fallback value — allowed to reject,
// same reasoning as createObjective/addCommandProposal in earlier phases.
export async function proposeMcpServer(
  name: string,
  url: string,
  registeredBy: string
): Promise<McpServerRow> {
  const db = getPool();
  const { rows } = await db.query(
    `INSERT INTO mcp_servers (name, url, registered_by) VALUES ($1, $2, $3) RETURNING *`,
    [name, url, registeredBy]
  );
  return rows[0];
}

export async function getMcpServer(id: number): Promise<McpServerRow | null> {
  try {
    const db = getPool();
    const { rows } = await db.query(`SELECT * FROM mcp_servers WHERE id = $1`, [id]);
    return rows[0] || null;
  } catch {
    return null;
  }
}

export async function listMcpServers(status?: McpServerRow["status"]): Promise<McpServerRow[]> {
  try {
    const db = getPool();
    if (status) {
      const { rows } = await db.query(`SELECT * FROM mcp_servers WHERE status = $1 ORDER BY created_at DESC`, [status]);
      return rows;
    }
    const { rows } = await db.query(`SELECT * FROM mcp_servers ORDER BY created_at DESC`);
    return rows;
  } catch {
    return [];
  }
}

// Called only after a live connect()+listTools() round-trip has already
// succeeded (see mcp-registry.ts, Task 2) — this function itself does no
// network I/O, it only persists the outcome.
export async function markMcpServerApproved(id: number): Promise<McpServerRow | null> {
  try {
    const db = getPool();
    const { rows } = await db.query(
      `UPDATE mcp_servers SET status = 'approved', approved_at = now(), last_connected_at = now(), last_error = NULL
       WHERE id = $1 AND status IN ('pending', 'error') RETURNING *`,
      [id]
    );
    return rows[0] || null;
  } catch {
    return null;
  }
}

// Does NOT change status away from 'approved' on its own — the health-check
// job (Task 5) decides when repeated failures warrant flipping to 'error'.
// This just records the most recent failure for visibility.
export async function markMcpServerError(id: number, error: string): Promise<void> {
  try {
    const db = getPool();
    await db.query(`UPDATE mcp_servers SET last_error = $1 WHERE id = $2`, [error, id]);
  } catch {
    // Best-effort — a failed error-log write is not itself worth crashing over.
  }
}

export async function setMcpServerStatus(id: number, status: "error" | "disabled"): Promise<McpServerRow | null> {
  try {
    const db = getPool();
    const { rows } = await db.query(
      `UPDATE mcp_servers SET status = $1 WHERE id = $2 RETURNING *`,
      [status, id]
    );
    return rows[0] || null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 3: Write the degrade-safety tests**

In `tests/index.test.ts`, add near the other repo imports:

```ts
import { proposeMcpServer, getMcpServer, listMcpServers, markMcpServerApproved, setMcpServerStatus } from "../src/data/mcp-servers-repo.js";
```

Then add a new test category at the end of the file:

```ts
// ---------- MCP Servers Repo Tests (no live Postgres in this test process) ----------

registerTest("McpServers", "proposeMcpServer degrades cleanly when Postgres isn't reachable", async () => {
  try {
    await proposeMcpServer("test-server", "http://example.invalid/mcp", "admin");
    throw new Error("McpServers: expected proposeMcpServer to reject without a live Postgres connection");
  } catch (err: any) {
    if (err.message?.includes("expected proposeMcpServer to reject")) throw err;
    // Any other thrown error (connection refused/DNS failure) is expected here.
  }
});

registerTest("McpServers", "getMcpServer degrades cleanly when Postgres isn't reachable", async () => {
  const result = await getMcpServer(999999);
  if (result !== null) {
    throw new Error(`McpServers: expected null with no DB, got: ${JSON.stringify(result)}`);
  }
});

registerTest("McpServers", "listMcpServers degrades cleanly when Postgres isn't reachable", async () => {
  const result = await listMcpServers();
  if (!Array.isArray(result) || result.length !== 0) {
    throw new Error(`McpServers: expected an empty array with no DB, got: ${JSON.stringify(result)}`);
  }
});

registerTest("McpServers", "markMcpServerApproved degrades cleanly when Postgres isn't reachable", async () => {
  const result = await markMcpServerApproved(999999);
  if (result !== null) {
    throw new Error(`McpServers: expected null with no DB, got: ${JSON.stringify(result)}`);
  }
});

registerTest("McpServers", "setMcpServerStatus degrades cleanly when Postgres isn't reachable", async () => {
  const result = await setMcpServerStatus(999999, "disabled");
  if (result !== null) {
    throw new Error(`McpServers: expected null with no DB, got: ${JSON.stringify(result)}`);
  }
});
```

- [ ] **Step 4: Run the full suite and typecheck**

Run: `npm test`
Expected: all existing tests plus the 5 new `McpServers` tests pass.

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/data/db.ts src/data/mcp-servers-repo.ts tests/index.test.ts
git commit -m "feat: add mcp_servers table and repo"
```

---

### Task 2: MCP SDK integration — connection, tool caching, tool calls

**Files:**
- Modify: `package.json` (new dependency)
- Create: `src/execution/mcp-registry.ts`
- Test: `tests/index.test.ts`

**Interfaces:**
- Consumes: `mcpServersRepo.getMcpServer`, `listMcpServers`, `markMcpServerApproved`, `markMcpServerError`, `setMcpServerStatus` from Task 1.
- Produces: `McpToolDescriptor { serverId, serverName, toolName, description, inputSchema }`, `approveMcpServer(id: number): Promise<{ ok: true; server: McpServerRow } | { ok: false; error: string }>`, `getCachedMcpTools(): McpToolDescriptor[]`, `callMcpTool(serverId: number, toolName: string, args: Record<string, any>): Promise<{ ok: true; content: any } | { ok: false; error: string }>`, `refreshServerConnection(id: number): Promise<boolean>` — all from `src/execution/mcp-registry.ts`. Task 4's tool-declaration merge and `executeTool` branch, and Task 5's health-check job, call these by name.

- [ ] **Step 1: Add the dependency**

In `package.json`'s `"dependencies"` block, add (alphabetically, matching the existing sorted order):

```json
    "@modelcontextprotocol/sdk": "^1.29.0",
```

Run: `npm install`
Expected: `@modelcontextprotocol/sdk` appears in `package-lock.json`, install succeeds with no peer-dependency errors.

**Before running `npm install`, re-check that `^1.29.0` is still the current stable major-version-1 release** (`npm view @modelcontextprotocol/sdk version`) — this plan was written against that exact version, and this SDK moves quickly. If a newer 1.x version is out, use it; if the *stable* line has moved to a published (non-beta) v2, re-read this plan's Global Constraints note and adjust the import paths in Step 2 below to match whatever v2's equivalents turn out to be — do not silently mix v1 and v2 APIs.

- [ ] **Step 2: Create the registry module**

Create `src/execution/mcp-registry.ts`:

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import * as mcpServersRepo from "../data/mcp-servers-repo.js";
import { ObservationPlatform } from "../observation/index.js";

const observation = ObservationPlatform.getInstance();

export interface McpToolDescriptor {
  serverId: number;
  serverName: string;
  toolName: string;
  description: string;
  inputSchema: Record<string, any>;
}

// Bounds on what's accepted from a server's tools/list response before it's
// cached and merged into every future chat turn's tool declarations — an
// untrusted server's schema must be rejected per-tool, not trusted wholesale.
const MAX_TOOL_NAME_LENGTH = 64;
const MAX_TOOL_DESCRIPTION_LENGTH = 1024;
const SAFE_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

function isValidToolSchema(tool: any): tool is { name: string; description?: string; inputSchema: Record<string, any> } {
  if (!tool || typeof tool !== "object") return false;
  if (typeof tool.name !== "string" || tool.name.length === 0 || tool.name.length > MAX_TOOL_NAME_LENGTH) return false;
  if (!SAFE_NAME_PATTERN.test(tool.name)) return false;
  if (tool.description !== undefined && (typeof tool.description !== "string" || tool.description.length > MAX_TOOL_DESCRIPTION_LENGTH)) return false;
  if (!tool.inputSchema || typeof tool.inputSchema !== "object") return false;
  return true;
}

// serverId -> its currently-cached, already-validated tool list. Not
// persisted — rebuilt from a live tools/list call every time a server is
// (re)approved or the health-check job successfully reconnects (Task 5).
// This is deliberately a read cache, not a source of truth, matching the
// same in-memory-cache-over-Postgres shape src/execution/permissions.ts
// already uses for grants.
const toolCache = new Map<number, McpToolDescriptor[]>();

async function connectAndListTools(url: string): Promise<{ ok: true; tools: any[] } | { ok: false; error: string }> {
  const client = new Client({ name: "jarvis-os", version: "1.0.0" });
  try {
    const transport = new StreamableHTTPClientTransport(new URL(url));
    await client.connect(transport);
    const { tools } = await client.listTools();
    return { ok: true, tools };
  } catch (err: any) {
    return { ok: false, error: err.message || String(err) };
  } finally {
    try {
      await client.close();
    } catch {
      // Best-effort cleanup — a failed close() doesn't change the result already returned.
    }
  }
}

// The one function in this module allowed to actually flip a server to
// 'approved' — and it only does so after connectAndListTools succeeds.
// A server is never trusted on the strength of the admin's click alone.
export async function approveMcpServer(id: number): Promise<{ ok: true; server: mcpServersRepo.McpServerRow } | { ok: false; error: string }> {
  const server = await mcpServersRepo.getMcpServer(id);
  if (!server) return { ok: false, error: "Server not found" };

  const result = await connectAndListTools(server.url);
  if (!result.ok) {
    await mcpServersRepo.markMcpServerError(id, result.error);
    return { ok: false, error: `Connection test failed: ${result.error}` };
  }

  const validTools = result.tools.filter(isValidToolSchema);
  const rejectedCount = result.tools.length - validTools.length;
  if (rejectedCount > 0) {
    observation.logTelemetry("warn", "McpRegistry", `Server "${server.name}" declared ${rejectedCount} tool(s) that failed schema validation — cached the remaining ${validTools.length}.`);
  }

  toolCache.set(id, validTools.map(t => ({
    serverId: id,
    serverName: server.name,
    toolName: t.name,
    description: t.description || "",
    inputSchema: t.inputSchema
  })));

  const updated = await mcpServersRepo.markMcpServerApproved(id);
  if (!updated) return { ok: false, error: "Failed to persist approval after a successful connection test" };
  return { ok: true, server: updated };
}

// Used by the Task 5 health-check job to re-verify an already-approved
// server without going through the full approve lifecycle again. Returns
// whether the reconnect succeeded; the caller decides what to do with
// repeated failures (this function itself never changes status to 'error' —
// see Task 5 for the 3-consecutive-failures threshold).
export async function refreshServerConnection(id: number): Promise<boolean> {
  const server = await mcpServersRepo.getMcpServer(id);
  if (!server || server.status !== "approved") return false;

  const result = await connectAndListTools(server.url);
  if (!result.ok) {
    await mcpServersRepo.markMcpServerError(id, result.error);
    return false;
  }

  const validTools = result.tools.filter(isValidToolSchema);
  toolCache.set(id, validTools.map(t => ({
    serverId: id,
    serverName: server.name,
    toolName: t.name,
    description: t.description || "",
    inputSchema: t.inputSchema
  })));
  await mcpServersRepo.markMcpServerApproved(id); // refreshes last_connected_at, clears last_error
  return true;
}

// Never throws — an empty cache (nothing approved yet, or every approved
// server currently unreachable) is a completely normal state, not an error.
export function getCachedMcpTools(): McpToolDescriptor[] {
  return Array.from(toolCache.values()).flat();
}

const CALL_TIMEOUT_MS = 10_000;

// Never throws past this boundary — a down/slow/misbehaving MCP server can
// only ever affect the one tool call that invoked it.
export async function callMcpTool(
  serverId: number,
  toolName: string,
  args: Record<string, any>
): Promise<{ ok: true; content: any } | { ok: false; error: string }> {
  const server = await mcpServersRepo.getMcpServer(serverId);
  if (!server || server.status !== "approved") {
    return { ok: false, error: "MCP server not found or not approved" };
  }

  const client = new Client({ name: "jarvis-os", version: "1.0.0" });
  try {
    const transport = new StreamableHTTPClientTransport(new URL(server.url));
    await client.connect(transport);
    const result = await client.callTool({ name: toolName, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS });
    if ((result as any).isError) {
      return { ok: false, error: `Tool "${toolName}" on server "${server.name}" reported an error: ${JSON.stringify((result as any).content)}` };
    }
    return { ok: true, content: (result as any).content };
  } catch (err: any) {
    return { ok: false, error: `MCP call to "${server.name}"/"${toolName}" failed: ${err.message || err}` };
  } finally {
    try {
      await client.close();
    } catch {
      // Best-effort cleanup.
    }
  }
}
```

- [ ] **Step 3: Write tests for what's testable without a live MCP server**

The schema-validation logic (`isValidToolSchema`) is pure and synchronous — it's the part of this module worth unit-testing directly in this pass. The connection-dependent functions (`approveMcpServer`, `refreshServerConnection`, `callMcpTool`) all require an actual reachable MCP server to exercise meaningfully; per this plan's Global Constraints, that live round-trip is explicitly deferred to whenever this plan is executed, not written here. `isValidToolSchema` is not exported (module-private) — export it for testing purposes by adding it to the module's exports:

In `src/execution/mcp-registry.ts`, change:

```ts
function isValidToolSchema(tool: any): tool is { name: string; description?: string; inputSchema: Record<string, any> } {
```

to:

```ts
export function isValidToolSchema(tool: any): tool is { name: string; description?: string; inputSchema: Record<string, any> } {
```

In `tests/index.test.ts`, add the import near the other module imports at the top of the file:

```ts
import { isValidToolSchema, getCachedMcpTools } from "../src/execution/mcp-registry.js";
```

Then add the tests:

```ts
// ---------- MCP Registry Tests (pure schema validation, no network/DB) ----------

registerTest("McpRegistry", "isValidToolSchema accepts a well-formed tool", () => {
  const valid = isValidToolSchema({ name: "search_issues", description: "Search GitHub issues", inputSchema: { type: "object", properties: {} } });
  if (!valid) {
    throw new Error("McpRegistry: expected a well-formed tool schema to be accepted");
  }
});

registerTest("McpRegistry", "isValidToolSchema rejects a tool name with unsafe characters", () => {
  const valid = isValidToolSchema({ name: "search issues; rm -rf", description: "x", inputSchema: { type: "object" } });
  if (valid) {
    throw new Error("McpRegistry: expected a tool name with unsafe characters to be rejected");
  }
});

registerTest("McpRegistry", "isValidToolSchema rejects a tool with no inputSchema", () => {
  const valid = isValidToolSchema({ name: "no_schema", description: "x" });
  if (valid) {
    throw new Error("McpRegistry: expected a tool with a missing inputSchema to be rejected");
  }
});

registerTest("McpRegistry", "isValidToolSchema rejects an oversized description", () => {
  const valid = isValidToolSchema({ name: "long_desc", description: "x".repeat(2000), inputSchema: { type: "object" } });
  if (valid) {
    throw new Error("McpRegistry: expected an oversized description to be rejected");
  }
});

registerTest("McpRegistry", "getCachedMcpTools returns an empty array with nothing approved", () => {
  const tools = getCachedMcpTools();
  if (!Array.isArray(tools) || tools.length !== 0) {
    throw new Error(`McpRegistry: expected an empty array with nothing approved, got: ${JSON.stringify(tools)}`);
  }
});
```

This last test is safe as a plain top-level import: nothing else in this plan's test additions calls `approveMcpServer` (it requires a live, reachable MCP server, which per this plan's Global Constraints isn't available in the test process), so `toolCache` has no path to being populated anywhere in this test run — the cache is guaranteed empty regardless of test execution order.

- [ ] **Step 4: Run the full suite and typecheck**

Run: `npm test`
Expected: all existing tests plus the 5 new `McpRegistry` tests pass.

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src/execution/mcp-registry.ts tests/index.test.ts
git commit -m "feat: add MCP client registry (connection, tool caching, tool calls)"
```

---

### Task 3: Capability system extension

**Files:**
- Modify: `src/execution/permissions.ts`

**Interfaces:**
- Consumes: `mcpRegistry.getCachedMcpTools(): McpToolDescriptor[]` from Task 2.
- Produces: `ALL_CAPABILITIES` gains `"system.mcp_manage"`. `loadGrantsFromDb` additionally backfills admin for every currently-cached `mcp.<server>.<tool>` capability.

- [ ] **Step 1: Add the new static capability and the registry import**

In `src/execution/permissions.ts`, add this import near the top of the file, alongside the existing `getPool` import:

```ts
import { getCachedMcpTools } from "./mcp-registry.js";
```

(`mcp-registry.ts`, per Task 2, imports only `mcp-servers-repo.ts` and `ObservationPlatform` — neither of those imports `permissions.ts`, so this is a plain, non-circular, one-directional import; no dynamic `import()` is needed here.)

Find `ALL_CAPABILITIES`:

```ts
export const ALL_CAPABILITIES = [
  "github.read",
  "github.issues.create",
  "github.pulls.create",
  "email.send",
  "email.read",
  "tts.speak",
  "executive.plan",
  "calendar.read",
  "calendar.write",
  "briefing.read",
  "files.read",
  "files.write",
  "knowledge.read",
  "identity.read",
  "news.read",
  "web.search",
  "feature.propose",
  "security.read",
  "security.manage",
  "screen.view",
  "objectives.read",
  "objectives.write",
  "system.execute",
] as const;
```

Add one line so it reads:

```ts
export const ALL_CAPABILITIES = [
  "github.read",
  "github.issues.create",
  "github.pulls.create",
  "email.send",
  "email.read",
  "tts.speak",
  "executive.plan",
  "calendar.read",
  "calendar.write",
  "briefing.read",
  "files.read",
  "files.write",
  "knowledge.read",
  "identity.read",
  "news.read",
  "web.search",
  "feature.propose",
  "security.read",
  "security.manage",
  "screen.view",
  "objectives.read",
  "objectives.write",
  "system.execute",
  "system.mcp_manage",
] as const;
```

- [ ] **Step 2: Extend the admin backfill to cover dynamic MCP capabilities**

In `src/execution/permissions.ts`, find `loadGrantsFromDb`:

```ts
export async function loadGrantsFromDb(): Promise<void> {
  const db = getPool();
  const { rows } = await db.query<{ username: string; capability: string }>(
    `SELECT username, capability FROM capability_grants;`
  );

  grants.clear();
  for (const row of rows) {
    if (!grants.has(row.username)) grants.set(row.username, new Set());
    grants.get(row.username)!.add(row.capability);
  }

  const adminGrants = grants.get("admin") ?? new Set<string>();
  const missing = ALL_CAPABILITIES.filter(c => !adminGrants.has(c));
  if (missing.length > 0) {
    for (const capability of missing) {
      await db.query(
        `INSERT INTO capability_grants (username, capability, granted_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING;`,
        ["admin", capability, "system"]
      );
      adminGrants.add(capability);
    }
    grants.set("admin", adminGrants);
    observation.logTelemetry("info", "Permissions", `Backfilled admin grant(s) for: ${missing.join(", ")}.`);
  }

  observation.logTelemetry("info", "Permissions", `Loaded ${rows.length} persisted capability grant(s) from Postgres.`);
}
```

Replace it with:

```ts
export async function loadGrantsFromDb(): Promise<void> {
  const db = getPool();
  const { rows } = await db.query<{ username: string; capability: string }>(
    `SELECT username, capability FROM capability_grants;`
  );

  grants.clear();
  for (const row of rows) {
    if (!grants.has(row.username)) grants.set(row.username, new Set());
    grants.get(row.username)!.add(row.capability);
  }

  const adminGrants = grants.get("admin") ?? new Set<string>();
  const dynamicMcpCapabilities = getCachedMcpTools().map(t => `mcp.${t.serverName}.${t.toolName}`);

  const missing = [...ALL_CAPABILITIES, ...dynamicMcpCapabilities].filter(c => !adminGrants.has(c));
  if (missing.length > 0) {
    for (const capability of missing) {
      await db.query(
        `INSERT INTO capability_grants (username, capability, granted_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING;`,
        ["admin", capability, "system"]
      );
      adminGrants.add(capability);
    }
    grants.set("admin", adminGrants);
    observation.logTelemetry("info", "Permissions", `Backfilled admin grant(s) for: ${missing.join(", ")}.`);
  }

  observation.logTelemetry("info", "Permissions", `Loaded ${rows.length} persisted capability grant(s) from Postgres.`);
}
```

This means `loadGrantsFromDb` should also be re-invoked (not just at boot) right after `approveMcpServer` succeeds, so a newly-approved server's tools are usable by admin immediately rather than only after the next restart — Task 4 wires this call site.

- [ ] **Step 3: Run the full suite and typecheck**

Run: `npm test`
Expected: all existing tests still pass — this task adds no new tests of its own (`loadGrantsFromDb` already has no direct test in this suite; it's exercised indirectly via the server boot path in the `HTTP Boundary` category, which does not depend on any MCP server being present, since `getCachedMcpTools()` returns `[]` with nothing approved).

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/execution/permissions.ts
git commit -m "feat: extend capability system for system.mcp_manage and dynamic MCP capabilities"
```

---

### Task 4: Dynamic tool merging, `propose_mcp_server` tool, and admin approve/disable routes

**Files:**
- Modify: `src/execution/tools.ts`
- Modify: `src/server.ts`
- Test: `tests/index.test.ts`

**Interfaces:**
- Consumes: everything produced in Tasks 1-3.
- Produces: `getAllToolDeclarations(): FunctionDeclaration[]` (exported from `tools.ts`), a new `propose_mcp_server` chat tool, an `executeTool` branch that routes unrecognized-but-known-MCP tool names to `mcpRegistry.callMcpTool`, and two new admin routes: `POST /api/system/mcp-servers/:id/approve`, `POST /api/system/mcp-servers/:id/disable`.

- [ ] **Step 1: Add the permission mapping and import**

In `src/execution/tools.ts`, add near the other repo imports at the top:

```ts
import * as mcpServersRepo from "../data/mcp-servers-repo.js";
import * as mcpRegistry from "../execution/mcp-registry.js";
```

In `PERMISSION_BY_TOOL`, add:

```ts
  propose_mcp_server: "system.mcp_manage",
```

- [ ] **Step 2: Add the `propose_mcp_server` tool declaration**

In `TOOL_DECLARATIONS`, add (following the same style as `propose_command`):

```ts
  {
    name: "propose_mcp_server",
    description:
      "Propose a new MCP (Model Context Protocol) server as a new source of capabilities. This ONLY creates a pending registration for the user to review and approve — it never connects to or trusts the server automatically. Only call this when the user has given you a specific server name and URL and clearly wants it registered.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        name: { type: Type.STRING, description: "A short, unique name for this server (used in capability names, e.g. \"github-mcp\")" },
        url: { type: Type.STRING, description: "The server's MCP endpoint URL" },
      },
      required: ["name", "url"],
    },
  },
```

- [ ] **Step 3: Add the `executeTool` case for `propose_mcp_server`**

In `executeTool`'s `switch`, add a case following the `propose_command` pattern:

```ts
      case "propose_mcp_server": {
        const proposed = await mcpServersRepo.proposeMcpServer(args.name, args.url, username);
        observation.logAuditEvent(username, "mcp_server_proposed", "success", `"${args.name}" (${args.url}, id ${proposed.id})`);
        output = { id: proposed.id, status: proposed.status, message: "Proposed — awaiting your review and approval. Nothing connects until you approve it." };
        break;
      }
```

- [ ] **Step 4: Add dynamic MCP tool dispatch to `executeTool`**

`executeTool` currently ends its `switch` with a `default` case returning `Unhandled tool "${name}"`. Before the `switch` even begins, the function already checks `PERMISSION_BY_TOOL[name]` and returns `Unknown tool "${name}"` if there's no entry — a dynamically-discovered MCP tool will never have a static `PERMISSION_BY_TOOL` entry, so that check needs its own MCP-aware branch.

Find this block near the top of `executeTool` (added in earlier phases, exact line numbers will have shifted by the time this task runs — locate by the `UNGATED_TOOLS` comment):

```ts
  const UNGATED_TOOLS = new Set(["display_content"]);
  const requiredGrant = PERMISSION_BY_TOOL[name];
  if (!requiredGrant && !UNGATED_TOOLS.has(name)) {
    return { name, ok: false, error: `Unknown tool "${name}"` };
  }
  if (requiredGrant && !hasGrant(username, requiredGrant)) {
    observation.logAuditEvent(username, "tool_call_denied", "failed", `Missing grant "${requiredGrant}" for tool "${name}"`);
    return { name, ok: false, error: `Missing capability grant "${requiredGrant}"` };
  }
```

Replace it with:

```ts
  const UNGATED_TOOLS = new Set(["display_content"]);
  const requiredGrant = PERMISSION_BY_TOOL[name];

  // Not a static tool — check whether it's a currently-cached MCP tool
  // before concluding it's genuinely unknown.
  const mcpTool = !requiredGrant && !UNGATED_TOOLS.has(name)
    ? mcpRegistry.getCachedMcpTools().find(t => `mcp.${t.serverName}.${t.toolName}` === name)
    : undefined;

  if (!requiredGrant && !UNGATED_TOOLS.has(name) && !mcpTool) {
    return { name, ok: false, error: `Unknown tool "${name}"` };
  }

  const mcpCapability = mcpTool ? `mcp.${mcpTool.serverName}.${mcpTool.toolName}` : undefined;
  const effectiveRequiredGrant = requiredGrant || mcpCapability;
  if (effectiveRequiredGrant && !hasGrant(username, effectiveRequiredGrant)) {
    observation.logAuditEvent(username, "tool_call_denied", "failed", `Missing grant "${effectiveRequiredGrant}" for tool "${name}"`);
    return { name, ok: false, error: `Missing capability grant "${effectiveRequiredGrant}"` };
  }

  if (mcpTool) {
    const result = await mcpRegistry.callMcpTool(mcpTool.serverId, mcpTool.toolName, args);
    if (!result.ok) {
      observation.logAuditEvent(username, "tool_call", "failed", `${name}(${JSON.stringify(args)}): ${result.error}`);
      return { name, ok: false, error: result.error };
    }
    observation.logAuditEvent(username, "tool_call", "success", `${name}(${JSON.stringify(args)})`);
    return { name, ok: true, output: result.content };
  }
```

This returns early for MCP tools right after the grant check, before the static `switch` — the static `switch` and its `default` case are otherwise completely unchanged, matching this plan's Global Constraint that no existing tool's path changes.

- [ ] **Step 5: Add `getAllToolDeclarations()` and wire it into the chat loop**

In `src/execution/tools.ts`, add this function after `TOOL_DECLARATIONS`'s definition:

```ts
// Static declarations plus whatever MCP servers are currently approved and
// reachable — called fresh each time a chat turn builds its Gemini
// function-calling request, so a newly-approved server's tools appear
// without a restart, and a disabled/unreachable one's disappear.
export function getAllToolDeclarations(): FunctionDeclaration[] {
  const mcpDeclarations: FunctionDeclaration[] = mcpRegistry.getCachedMcpTools().map(t => ({
    name: `mcp.${t.serverName}.${t.toolName}`,
    description: t.description,
    parameters: t.inputSchema as any
  }));
  return [...TOOL_DECLARATIONS, ...mcpDeclarations];
}
```

In `src/server.ts`, find where `TOOL_DECLARATIONS` is passed to the Gemini function-calling request inside the `/api/chat` handler (search for `TOOL_DECLARATIONS` — it's referenced when constructing the `tools` field of the generation config) and replace that reference with `tools.getAllToolDeclarations()` (the module is already imported as `tools` for `executeTool`). Search first with `grep -n "TOOL_DECLARATIONS" src/server.ts` to find every call site — there may be more than one (e.g. the streaming and non-streaming paths, if both exist), and every one must switch to `getAllToolDeclarations()` for MCP tools to actually be callable from any code path that can reach them.

There is also a **third, non-`server.ts` call site**: `src/cognition/live-voice.ts` — voice mode's own tool-calling session builds its `tools` field directly from the static `TOOL_DECLARATIONS` import (currently `tools: [{ functionDeclarations: TOOL_DECLARATIONS }]`, around where it later calls `executeTool()` for the actual dispatch). Update the import at the top of `live-voice.ts` from `import { TOOL_DECLARATIONS, executeTool } from "../execution/tools.js";` to `import { getAllToolDeclarations, executeTool } from "../execution/tools.js";`, and change that `tools:` field to `tools: [{ functionDeclarations: getAllToolDeclarations() }]`. Skipping this leaves voice mode silently limited to the static tool set — MCP tools would work in chat but never be offered when talking to Jarvis by voice.

- [ ] **Step 6: Add the admin approve/disable routes**

In `src/server.ts`, near the existing `/api/system/commands/:id/approve` route, add:

```ts
app.post("/api/system/mcp-servers/:id/approve", validateApiKey, async (req: any, res: any) => {
  if (!permissions.hasGrant(req.username, "system.mcp_manage")) {
    return res.status(403).json({ error: 'Missing capability grant "system.mcp_manage"' });
  }
  try {
    const result = await mcpRegistry.approveMcpServer(Number(req.params.id));
    if (!result.ok) {
      observation.logAuditEvent(req.username, "mcp_server_approve_failed", "failed", result.error);
      return res.status(422).json({ error: result.error });
    }
    await permissions.loadGrantsFromDb(); // backfill admin for this server's newly-cached tools immediately
    observation.logAuditEvent(req.username, "mcp_server_approved", "success", `#${result.server.id}: ${result.server.name}`);
    res.json(result.server);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/system/mcp-servers/:id/disable", validateApiKey, async (req: any, res: any) => {
  if (!permissions.hasGrant(req.username, "system.mcp_manage")) {
    return res.status(403).json({ error: 'Missing capability grant "system.mcp_manage"' });
  }
  try {
    const updated = await mcpServersRepo.setMcpServerStatus(Number(req.params.id), "disabled");
    if (!updated) return res.status(404).json({ error: "Server not found" });
    observation.logAuditEvent(req.username, "mcp_server_disabled", "success", `#${updated.id}: ${updated.name}`);
    res.json(updated);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
```

Add the two new imports at the top of `src/server.ts` alongside the other `src/data`/`src/execution` imports:

```ts
import * as mcpServersRepo from "./data/mcp-servers-repo.js";
import * as mcpRegistry from "./execution/mcp-registry.js";
```

Note: `disableMcpServer` from the design's original naming is implemented here as `setMcpServerStatus(id, "disabled")` (Task 1) — this route is the disable entry point; there's no separate `disableMcpServer` function, avoiding a redundant wrapper around a one-line query.

- [ ] **Step 7: Write the tool/route tests**

In `tests/index.test.ts`, add to the `"Tools"` category:

```ts
registerTest("Tools", "propose_mcp_server denies calls without system.mcp_manage grant", async () => {
  const result = await executeTool("propose_mcp_server", { name: "test-server", url: "http://example.invalid/mcp" }, "ungranted_test_user");
  if (result.ok !== false || !result.error?.toLowerCase().includes("grant")) {
    throw new Error("Tools: propose_mcp_server should deny a call with no capability grant");
  }
});

registerTest("Tools", "executeTool reports unknown tool for a name that isn't static or a cached MCP tool", async () => {
  const result = await executeTool("not_a_real_tool", {}, "admin");
  if (result.ok !== false || !result.error?.toLowerCase().includes("unknown")) {
    throw new Error("Tools: expected a clean 'unknown tool' error for a name matching neither a static tool nor a cached MCP tool");
  }
});

registerTest("Tools", "getAllToolDeclarations includes every static declaration with nothing MCP-approved", () => {
  const declarations = getAllToolDeclarations();
  if (declarations.length < 25) { // 24 static tools as of Phase 3, plus propose_mcp_server = 25
    throw new Error(`Tools: expected at least 25 static declarations, got ${declarations.length}`);
  }
});
```

Add `getAllToolDeclarations` to the existing `executeTool` import line near the top of `tests/index.test.ts`:

```ts
import { executeTool, getAllToolDeclarations } from "../src/execution/tools.js";
```

- [ ] **Step 8: Run the full suite and typecheck**

Run: `npm test`
Expected: all existing tests plus the 3 new `Tools` tests pass.

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 9: Search for any other reference to `TOOL_DECLARATIONS` outside `tools.ts` itself**

Run: `grep -rn "TOOL_DECLARATIONS" src/` and confirm every call site outside `tools.ts`'s own definition now goes through `getAllToolDeclarations()` instead (Step 5 already covers `server.ts`'s chat handler(s) and `src/cognition/live-voice.ts`'s voice-mode tool-calling session — this step is the verification that nothing else references the static array directly, the same kind of check that caught unanticipated call sites in Phases 2 and 3).

- [ ] **Step 10: Commit**

```bash
git add src/execution/tools.ts src/server.ts tests/index.test.ts
git commit -m "feat: merge MCP tools into the chat loop, add propose_mcp_server and admin routes"
```

---

### Task 5: Health-check scheduled job

**Files:**
- Modify: `src/execution/scheduler.ts`

**Interfaces:**
- Consumes: `mcpServersRepo.listMcpServers("approved")`, `mcpRegistry.refreshServerConnection(id)`, `mcpServersRepo.setMcpServerStatus(id, "error")` from Tasks 1-2.

- [ ] **Step 1: Add the job**

In `src/execution/scheduler.ts`, add near the other built-in jobs (`startBriefingJob`, etc.):

```ts
import * as mcpServersRepo from "../data/mcp-servers-repo.js";
import * as mcpRegistry from "./mcp-registry.js";

// Tracks consecutive reconnect failures per server, in-memory only — reset
// on a successful reconnect or a restart. This is deliberately ephemeral
// (unlike command_proposals/objectives' Postgres-backed durability): a
// restart re-attempting from a clean slate for "how many times has this
// server failed in a row" is the correct behavior here, not a bug — a
// server that was flapping before a restart gets a fresh chance, exactly
// like `seenBriefingItemIds`'s existing ephemeral novelty tracking.
const consecutiveFailures = new Map<number, number>();
const MCP_HEALTH_CHECK_FAILURE_THRESHOLD = 3;

export function startMcpHealthCheckJob(intervalMs = 30 * 60 * 1000): NodeJS.Timeout {
  return registerJob("mcp-health-check", intervalMs, async () => {
    const servers = await mcpServersRepo.listMcpServers("approved");
    for (const server of servers) {
      const reconnected = await mcpRegistry.refreshServerConnection(server.id);
      if (reconnected) {
        consecutiveFailures.delete(server.id);
        continue;
      }
      const failures = (consecutiveFailures.get(server.id) ?? 0) + 1;
      consecutiveFailures.set(server.id, failures);
      if (failures >= MCP_HEALTH_CHECK_FAILURE_THRESHOLD) {
        await mcpServersRepo.setMcpServerStatus(server.id, "error");
        observation.logTelemetry("warn", "McpHealthCheck", `Server "${server.name}" (#${server.id}) failed to reconnect ${failures} times in a row — marked 'error'.`);
        consecutiveFailures.delete(server.id);
      }
    }
  });
}
```

- [ ] **Step 2: Wire the job into server startup**

Search for where `startBriefingJob` (or another `start*Job` function) is called during server boot in `src/server.ts` — likely near the other `scheduler.start*Job(...)` calls — and add `scheduler.startMcpHealthCheckJob();` alongside them, following the exact same pattern (no arguments needed to use the 30-minute default).

- [ ] **Step 3: Run the full suite and typecheck**

Run: `npm test`
Expected: all existing tests still pass. No new dedicated test for this job — same reasoned exception as Phase 3's notification-wiring task and Phase 2's scheduler-wiring task: this is a scheduled side effect with no live MCP server to exercise it against in this test process, and unit-testing `registerJob`'s own timer behavior is already out of scope for this codebase's test suite (no existing scheduled job has one either).

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/execution/scheduler.ts src/server.ts
git commit -m "feat: add MCP server health-check scheduled job"
```
