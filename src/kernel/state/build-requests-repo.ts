import { getPool } from "./db.js";
import { ObservationPlatform } from "../observation.js";

const observation = ObservationPlatform.getInstance();

export type BuildRequestStatus =
  | "researching"
  | "awaiting_consult"
  | "direction_confirmed"
  | "coding"
  | "awaiting_code_approval"
  | "review_failed"
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
  coding_model_used: string | null;
  task_category: string | null;
  // Added by migrations/002_build_request_token_usage.ts — cumulative coding-
  // agent LLM token usage across the session (originally NVIDIA, now Groq;
  // the column was already provider-agnostic), incremented by incrementTokenUsage.
  tokens_used: number;
  // Added by migrations/007_autonomous_merge.ts — set true by markAutonomousMerge
  // once a PR is merged without human sign-off; countAutonomousMergesToday reads
  // this column to enforce the daily autonomous-merge cap.
  autonomous_merge: boolean;
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
  } catch (err: any) {
    observation.logTelemetry("warn", "BuildRequests", `getBuildRequest(${id}) failed: ${err.message}`);
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
  } catch (err: any) {
    observation.logTelemetry("warn", "BuildRequests", `getLatestAwaitingConsult("${username}") failed: ${err.message}`);
    return null;
  }
}

// A build request sitting in 'direction_confirmed' for more than an
// instant only happens via confirmDirection's reward gate pausing before
// startCoding — see the design spec's confirmation-gate section for why
// this reuses status timing instead of a new column, and the invariant
// (at most one awaiting/in-flight build request per user) it depends on.
export async function getLatestPendingRewardGate(username: string): Promise<BuildRequestRow | null> {
  try {
    const db = getPool();
    const { rows } = await db.query(
      `SELECT * FROM build_requests WHERE requested_by = $1 AND status = 'direction_confirmed' ORDER BY created_at DESC LIMIT 1`,
      [username]
    );
    return rows[0] || null;
  } catch (err: any) {
    observation.logTelemetry("warn", "BuildRequests", `getLatestPendingRewardGate("${username}") failed: ${err.message}`);
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
  } catch (err: any) {
    observation.logTelemetry("warn", "BuildRequests", `listBuildRequests(${status ?? "<all>"}) failed: ${err.message}`);
    return [];
  }
}

export async function getActiveTaskForUser(username: string): Promise<string | null> {
  try {
    const db = getPool();
    const { rows } = await db.query(
      `SELECT objective FROM build_requests WHERE requested_by = $1 AND status IN ('coding', 'researching') ORDER BY created_at DESC LIMIT 1`,
      [username]
    );
    return rows[0]?.objective ?? null;
  } catch (err: any) {
    observation.logTelemetry("warn", "BuildRequests", `getActiveTaskForUser(${username}) failed: ${err.message}`);
    return null;
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
  } catch (err: any) {
    observation.logTelemetry("warn", "BuildRequests", `recordResearch(${id}) failed: ${err.message}`);
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
  } catch (err: any) {
    // Best-effort — a failed error-log write is not itself worth crashing over.
    observation.logTelemetry("warn", "BuildRequests", `markResearchError(${id}) failed: ${err.message}`);
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
  } catch (err: any) {
    observation.logTelemetry("warn", "BuildRequests", `recordDirectionConfirmed(${id}) failed: ${err.message}`);
    return null;
  }
}

// A visibility marker set the moment code-drafting starts (before its
// Gemini call), so a hung/failed draft is visibly "stuck in coding" rather
// than ambiguously stuck at 'direction_confirmed' — see the design spec's
// data model section for the full reasoning.
export async function markCoding(id: number): Promise<boolean> {
  try {
    const db = getPool();
    const { rowCount } = await db.query(`UPDATE build_requests SET status = 'coding', updated_at = now() WHERE id = $1 AND status = 'direction_confirmed'`, [id]);
    return !!rowCount;
  } catch (err: any) {
    // A DB failure here means the claim couldn't be confirmed, so this
    // returns false the same as "another caller already claimed it" — the
    // caller (startCoding) treats both as "don't proceed," which is the
    // safe default: it must not start a coding session it can't be sure it
    // exclusively holds.
    observation.logTelemetry("warn", "BuildRequests", `markCoding(${id}) failed: ${err.message}`);
    return false;
  }
}

export async function recordCodeDraft(
  id: number,
  codeSummary: string,
  files: DraftedFile[],
  modelUsed: string | null = null,
  category: string = "general"
): Promise<BuildRequestRow | null> {
  try {
    const db = getPool();
    const { rows } = await db.query(
      `UPDATE build_requests SET code_summary = $1, proposed_files = $2, status = 'awaiting_code_approval', coding_model_used = $3, task_category = $4, updated_at = now()
       WHERE id = $5 AND status = 'coding' RETURNING *`,
      [codeSummary, JSON.stringify(files), modelUsed, category, id]
    );
    return rows[0] || null;
  } catch (err: any) {
    observation.logTelemetry("warn", "BuildRequests", `recordCodeDraft(${id}) failed: ${err.message}`);
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
  } catch (err: any) {
    // Best-effort.
    observation.logTelemetry("warn", "BuildRequests", `markCodeDraftError(${id}) failed: ${err.message}`);
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
  } catch (err: any) {
    observation.logTelemetry("warn", "BuildRequests", `rejectCode(${id}) failed: ${err.message}`);
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
  } catch (err: any) {
    observation.logTelemetry("warn", "BuildRequests", `recordPrOpened(${id}) failed: ${err.message}`);
    return null;
  }
}

export async function markAutonomousMerge(id: number): Promise<BuildRequestRow | null> {
  try {
    const db = getPool();
    const { rows } = await db.query(
      // Accepts 'qa_complete' as well as 'pr_opened': the approval flow calls
      // recordQaReview (which moves the row pr_opened -> qa_complete) before
      // it reaches the autonomous-merge decision, so a 'pr_opened'-only guard
      // would match zero rows every single time — silently leaving
      // autonomous_merge false, which would in turn make
      // countAutonomousMergesToday always return 0 and the daily cap never
      // bind. Both statuses mean "the PR is open and recorded", which is the
      // real precondition for marking it autonomously merged.
      `UPDATE build_requests SET autonomous_merge = true, updated_at = now() WHERE id = $1 AND status IN ('pr_opened', 'qa_complete') RETURNING *`,
      [id]
    );
    return rows[0] || null;
  } catch (err: any) {
    observation.logTelemetry("warn", "Database", `markAutonomousMerge failed for build request ${id}: ${err.message}`);
    return null;
  }
}

export async function countAutonomousMergesToday(): Promise<number> {
  try {
    const db = getPool();
    const { rows } = await db.query(
      `SELECT COUNT(*)::int AS count FROM build_requests WHERE autonomous_merge = true AND updated_at >= date_trunc('day', now())`
    );
    return rows[0]?.count ?? 0;
  } catch (err: any) {
    observation.logTelemetry("warn", "Database", `countAutonomousMergesToday failed: ${err.message}`);
    // Fails closed per this plan's Global Constraints: a DB error here must
    // never look like "0 merges today, plenty of room" — returning a value
    // at or above any realistic cap keeps the caller's "under cap?" check
    // false without the caller needing its own separate DB-health branch.
    return Number.MAX_SAFE_INTEGER;
  }
}

export async function markPrError(id: number, errorDetail: string): Promise<void> {
  try {
    const db = getPool();
    await db.query(
      `UPDATE build_requests SET status = 'error', error_detail = $1, updated_at = now() WHERE id = $2 AND status = 'awaiting_code_approval'`,
      [errorDetail, id]
    );
  } catch (err: any) {
    // Best-effort.
    observation.logTelemetry("warn", "BuildRequests", `markPrError(${id}) failed: ${err.message}`);
  }
}

export async function markReviewFailed(id: number, findings: string): Promise<BuildRequestRow | null> {
  try {
    const db = getPool();
    const { rows } = await db.query(
      `UPDATE build_requests SET status = 'review_failed', qa_summary = $1, updated_at = now()
       WHERE id = $2 AND status = 'awaiting_code_approval' RETURNING *`,
      [findings, id]
    );
    return rows[0] || null;
  } catch (err: any) {
    observation.logTelemetry("warn", "BuildRequests", `markReviewFailed failed for build request ${id}: ${err.message}`);
    return null;
  }
}

// QA is a bonus report, not consequential to correctness — a failed write
// here doesn't undo the fact that the PR is already open.
export async function recordQaReview(id: number, qaSummary: string): Promise<void> {
  try {
    const db = getPool();
    const { rowCount } = await db.query(
      `UPDATE build_requests SET qa_summary = $1, status = 'qa_complete', updated_at = now() WHERE id = $2 AND status = 'pr_opened'`,
      [qaSummary, id]
    );
    // The WHERE clause's status = 'pr_opened' guard means this silently
    // no-ops (never throws) if called before the row actually reaches that
    // state — worth a warning since the caller has no other way to notice
    // the qa_summary it just computed never got persisted.
    if (!rowCount) {
      observation.logTelemetry("warn", "BuildRequests", `recordQaReview(${id}) matched no row in status 'pr_opened' — qa_summary was not persisted`);
    }
  } catch (err: any) {
    // Best-effort.
    observation.logTelemetry("warn", "BuildRequests", `recordQaReview(${id}) failed: ${err.message}`);
  }
}

// Called after every Groq call the coding agent makes, not just at the
// end of a session — so the running total is visible (and survives a crash)
// even if the session never finishes cleanly. An increment, not a set: the
// caller doesn't need to track "how much have I already persisted", it just
// reports what this one call cost. No-ops on a non-positive amount rather
// than issuing a pointless UPDATE for a call whose usage was unknown (see
// AgentChatResult.totalTokens, which can be null).
export async function incrementTokenUsage(id: number, tokens: number): Promise<void> {
  if (!Number.isFinite(tokens) || tokens <= 0) return;
  try {
    const db = getPool();
    await db.query(`UPDATE build_requests SET tokens_used = tokens_used + $1, updated_at = now() WHERE id = $2`, [tokens, id]);
  } catch (err: any) {
    observation.logTelemetry("warn", "BuildRequests", `incrementTokenUsage(${id}) failed: ${err.message}`);
  }
}
