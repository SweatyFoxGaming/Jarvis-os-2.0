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
  } catch {
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
  } catch {
    return null;
  }
}
