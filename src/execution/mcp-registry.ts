import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import * as mcpServersRepo from "../data/mcp-servers-repo.js";
import { ObservationPlatform } from "../observation/index.js";

const observation = ObservationPlatform.getInstance();

// Races `promise` against a timer so a stalling/malicious server (one that
// accepts the TCP connection but never completes the MCP handshake, or never
// responds to a request) can't hang the caller for undici's ~5-minute
// default. The underlying operation isn't cancelled — only the caller stops
// waiting on it — so this is paired with the existing `finally { close() }`
// cleanup at each call site.
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

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

export function isValidToolSchema(tool: any): tool is { name: string; description?: string; inputSchema: Record<string, any> } {
  if (!tool || typeof tool !== "object") return false;
  if (typeof tool.name !== "string" || tool.name.length === 0 || tool.name.length > MAX_TOOL_NAME_LENGTH) return false;
  if (!SAFE_NAME_PATTERN.test(tool.name)) return false;
  if (tool.description !== undefined && (typeof tool.description !== "string" || tool.description.length > MAX_TOOL_DESCRIPTION_LENGTH)) return false;
  if (!tool.inputSchema || typeof tool.inputSchema !== "object") return false;
  if (Array.isArray(tool.inputSchema)) return false;
  if (tool.inputSchema.type !== "object") return false;
  if (tool.inputSchema.properties !== undefined) {
    const props = tool.inputSchema.properties;
    if (typeof props !== "object" || props === null || Array.isArray(props)) return false;
  }
  return true;
}

// serverId -> its currently-cached, already-validated tool list. Not
// persisted — rebuilt from a live tools/list call every time a server is
// (re)approved or the health-check job successfully reconnects (Task 5).
// This is deliberately a read cache, not a source of truth, matching the
// same in-memory-cache-over-Postgres shape src/execution/permissions.ts
// already uses for grants.
const toolCache = new Map<number, McpToolDescriptor[]>();

const CONNECT_TIMEOUT_MS = 10_000;
const CALL_TIMEOUT_MS = 10_000;

async function connectAndListTools(url: string): Promise<{ ok: true; tools: any[] } | { ok: false; error: string }> {
  const client = new Client({ name: "jarvis-os", version: "1.0.0" });
  try {
    const transport = new StreamableHTTPClientTransport(new URL(url));
    await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, "MCP connect()");
    const { tools } = await withTimeout(client.listTools(), CONNECT_TIMEOUT_MS, "MCP listTools()");
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
    toolCache.delete(id);
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
  // Server is already 'approved' here (checked above), so
  // markMcpServerApproved's pending/error -> approved UPDATE would match 0
  // rows — use the dedicated approved -> approved refresh instead so
  // last_connected_at/last_error actually get updated on a successful
  // health-check reconnect.
  await mcpServersRepo.refreshMcpServerConnection(id);
  return true;
}

// Never throws — an empty cache (nothing approved yet, or every approved
// server currently unreachable) is a completely normal state, not an error.
export function getCachedMcpTools(): McpToolDescriptor[] {
  return Array.from(toolCache.values()).flat();
}

// Exposed so admin routes (e.g. the disable route in server.ts) can drop a
// server's cached tools immediately instead of waiting for the next failed
// health-check cycle to notice.
export function evictFromToolCache(id: number): void {
  toolCache.delete(id);
}

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
    await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, "MCP connect()");
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
