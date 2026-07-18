import { getPool } from "./db.js";

export type CommandProposalStatus = "pending" | "approved" | "rejected" | "running" | "executed" | "failed";

export interface CommandProposal {
  id: number;
  command: string;
  reason: string;
  status: CommandProposalStatus;
  requested_by: string;
  output: string | null;
  exit_code: number | null;
  created_at: Date;
  approved_at: Date | null;
  executed_at: Date | null;
}

export async function addCommandProposal(
  command: string,
  reason: string,
  requestedBy: string
): Promise<CommandProposal> {
  const db = getPool();
  const { rows } = await db.query(
    `INSERT INTO command_proposals (command, reason, requested_by) VALUES ($1, $2, $3) RETURNING *`,
    [command, reason, requestedBy]
  );
  return rows[0];
}

export async function getCommandProposals(status?: CommandProposalStatus): Promise<CommandProposal[]> {
  const db = getPool();
  if (status) {
    const { rows } = await db.query(
      `SELECT * FROM command_proposals WHERE status = $1 ORDER BY created_at DESC`,
      [status]
    );
    return rows;
  }
  const { rows } = await db.query(`SELECT * FROM command_proposals ORDER BY created_at DESC`);
  return rows;
}

// pending -> approved/rejected only. The user's own explicit action is the
// only way a row ever becomes 'approved' — nothing in this codebase does
// that transition automatically.
export async function setCommandDecision(
  id: number,
  decision: "approved" | "rejected"
): Promise<CommandProposal | null> {
  const db = getPool();
  const { rows } = await db.query(
    `UPDATE command_proposals SET status = $1, approved_at = CASE WHEN $1 = 'approved' THEN now() ELSE approved_at END
     WHERE id = $2 AND status = 'pending' RETURNING *`,
    [decision, id]
  );
  return rows[0] || null;
}

// Atomically claims ONE approved command for execution (approved -> running)
// in a single UPDATE...RETURNING — if two executor runs overlap, only one of
// them gets a non-empty result back, so the same command can never run twice.
export async function claimApprovedCommand(): Promise<CommandProposal | null> {
  const db = getPool();
  const { rows } = await db.query(
    `UPDATE command_proposals SET status = 'running'
     WHERE id = (
       SELECT id FROM command_proposals WHERE status = 'approved' ORDER BY approved_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED
     )
     RETURNING *`
  );
  return rows[0] || null;
}

export async function recordCommandResult(
  id: number,
  output: string,
  exitCode: number
): Promise<CommandProposal | null> {
  const db = getPool();
  const status = exitCode === 0 ? "executed" : "failed";
  const { rows } = await db.query(
    `UPDATE command_proposals SET status = $1, output = $2, exit_code = $3, executed_at = now() WHERE id = $4 RETURNING *`,
    [status, output, exitCode, id]
  );
  return rows[0] || null;
}
