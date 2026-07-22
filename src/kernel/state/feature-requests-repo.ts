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

export async function getFeatureRequests(status?: FeatureRequestStatus): Promise<FeatureRequest[]> {
  const db = getPool();
  if (status) {
    const { rows } = await db.query(
      `SELECT * FROM feature_requests WHERE status = $1 ORDER BY created_at DESC`,
      [status]
    );
    return rows;
  }
  const { rows } = await db.query(`SELECT * FROM feature_requests ORDER BY created_at DESC`);
  return rows;
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
