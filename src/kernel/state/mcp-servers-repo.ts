import { getPool } from "./db.js";
import { ObservationPlatform } from "../observation.js";

const observation = ObservationPlatform.getInstance();

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

export class InvalidMcpServerNameError extends Error {}
export class McpServerNameTakenError extends Error {
  constructor(name: string) {
    super(`An MCP server named "${name}" is already registered — pick a different name or manage the existing one.`);
  }
}

// Same bound/pattern src/capabilities/mcp-registry.ts's isValidToolSchema
// already applies to individual tool names (kept as an independent constant
// here, not a shared import — mcp-registry.ts already imports this module,
// so importing back from it would be circular). This server's own `name`
// gets embedded verbatim into capability strings ("mcp.<name>.<toolName>")
// and LLM function-declaration names once approved, so it needs the same
// discipline: an unvalidated name could break a provider's function-name
// validation at runtime, or — since registering a server already requires
// the admin-level system.mcp_manage grant, so this isn't exploitable by an
// untrusted caller today — just silently produce a broken/unusable server
// entry that's confusing to debug.
const MAX_SERVER_NAME_LENGTH = 64;
const SAFE_SERVER_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

// A genuine write with no sensible fallback value — allowed to reject,
// same reasoning as createObjective/addCommandProposal in earlier phases.
export async function proposeMcpServer(
  name: string,
  url: string,
  registeredBy: string
): Promise<McpServerRow> {
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    name.length > MAX_SERVER_NAME_LENGTH ||
    !SAFE_SERVER_NAME_PATTERN.test(name)
  ) {
    throw new InvalidMcpServerNameError(
      `MCP server name must be 1-${MAX_SERVER_NAME_LENGTH} characters, letters/numbers/underscore/hyphen only — got: ${JSON.stringify(name)}`
    );
  }
  const db = getPool();
  // ON CONFLICT DO NOTHING + a rowCount check, not a raw INSERT: without
  // this, registering a name that's already taken threw Postgres's own raw
  // unique-violation error straight up through executeTool()'s generic
  // catch-and-return-err.message (tools.ts) to whoever's chatting with
  // Jarvis — a constraint-name-and-detail leak, not a usable error message.
  // Same pattern users-repo.ts's createUser already uses for the identical
  // race/duplicate shape.
  const { rows } = await db.query(
    `INSERT INTO mcp_servers (name, url, registered_by) VALUES ($1, $2, $3)
     ON CONFLICT (name) DO NOTHING RETURNING *`,
    [name, url, registeredBy]
  );
  if (rows.length === 0) {
    throw new McpServerNameTakenError(name);
  }
  return rows[0];
}

export async function getMcpServer(id: number): Promise<McpServerRow | null> {
  try {
    const db = getPool();
    const { rows } = await db.query(`SELECT * FROM mcp_servers WHERE id = $1`, [id]);
    return rows[0] || null;
  } catch (err: any) {
    observation.logTelemetry("warn", "McpServers", `getMcpServer(${id}) failed: ${err.message}`);
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
  } catch (err: any) {
    observation.logTelemetry("warn", "McpServers", `listMcpServers(${status ?? "<all>"}) failed: ${err.message}`);
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
  } catch (err: any) {
    observation.logTelemetry("warn", "McpServers", `markMcpServerApproved(${id}) failed: ${err.message}`);
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
  } catch (err: any) {
    // Best-effort — a failed error-log write is not itself worth crashing over.
    observation.logTelemetry("warn", "McpServers", `markMcpServerError(${id}) failed: ${err.message}`);
  }
}

// Called by the Task 5 health-check job after a successful reconnect to an
// already-'approved' server. Deliberately separate from
// markMcpServerApproved: that function's WHERE clause only matches
// status IN ('pending', 'error'), so it's a guaranteed no-op for a server
// that's already 'approved' — which is exactly the case here.
export async function refreshMcpServerConnection(id: number): Promise<McpServerRow | null> {
  try {
    const db = getPool();
    const { rows } = await db.query(
      `UPDATE mcp_servers SET last_connected_at = now(), last_error = NULL
       WHERE id = $1 AND status = 'approved' RETURNING *`,
      [id]
    );
    return rows[0] || null;
  } catch (err: any) {
    observation.logTelemetry("warn", "McpServers", `refreshMcpServerConnection(${id}) failed: ${err.message}`);
    return null;
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
  } catch (err: any) {
    observation.logTelemetry("warn", "McpServers", `setMcpServerStatus(${id}, ${status}) failed: ${err.message}`);
    return null;
  }
}
