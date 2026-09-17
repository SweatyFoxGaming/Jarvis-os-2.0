import { getPool } from "./db.js";

export type FeatureRequestStatus = "queued" | "in_progress" | "shipped" | "declined";

export interface FeatureRequest {
  id: number;
  title: string;
  description: string;
  research_notes: string | null;
  proposed_plan: string | null;
  status: FeatureRequestStatus;
  requested_by: string;
  created_at: Date;
  resolved_at: Date | null;
}

export async function addFeatureRequest(
  title: string,
  description: string,
  researchNotes: string | null,
  proposedPlan: string | null,
  requestedBy: string
): Promise<FeatureRequest> {
  const db = getPool();
  const { rows } = await db.query(
    `INSERT INTO feature_requests (title, description, research_notes, proposed_plan, requested_by)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [title, description, researchNotes, proposedPlan, requestedBy]
  );
  return rows[0];
}

// `username`, when passed, scopes results to that requester's own rows only
// (`requested_by = username`) — the route layer's job is to pass it for
// every caller except admin, so a personal user's titles/descriptions/
// research notes never leak to another personal user. Omitting it (as the
// route does for admin) returns every request system-wide, matching the
// pre-fix behavior admin still needs to triage the whole queue.
export async function getFeatureRequests(status?: FeatureRequestStatus, username?: string): Promise<FeatureRequest[]> {
  const db = getPool();
  const conditions: string[] = [];
  const params: (FeatureRequestStatus | string)[] = [];
  if (status) {
    params.push(status);
    conditions.push(`status = $${params.length}`);
  }
  if (username) {
    params.push(username);
    conditions.push(`requested_by = $${params.length}`);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const { rows } = await db.query(`SELECT * FROM feature_requests ${where} ORDER BY created_at DESC`, params);
  return rows;
}

// Backs the ownership check the POST /:id/status route performs before
// calling updateFeatureRequestStatus below — that update function has no
// ownership check of its own (any id, any status), so the route fetches the
// row first via this function to confirm the caller actually owns it (or is
// admin) before ever attempting the write.
export async function getFeatureRequestById(id: number): Promise<FeatureRequest | null> {
  const db = getPool();
  const { rows } = await db.query(`SELECT * FROM feature_requests WHERE id = $1`, [id]);
  return rows[0] || null;
}

export async function updateFeatureRequestStatus(
  id: number,
  status: FeatureRequestStatus
): Promise<FeatureRequest | null> {
  const db = getPool();
  const resolvedAt = status === "shipped" || status === "declined" ? "now()" : "NULL";
  const { rows } = await db.query(
    `UPDATE feature_requests SET status = $1, resolved_at = ${resolvedAt} WHERE id = $2 RETURNING *`,
    [status, id]
  );
  return rows[0] || null;
}
