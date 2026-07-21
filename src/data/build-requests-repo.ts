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
