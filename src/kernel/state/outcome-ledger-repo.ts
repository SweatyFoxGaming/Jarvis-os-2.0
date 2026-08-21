import { getPool } from "./db.js";
import { ObservationPlatform } from "../observation.js";

const observation = ObservationPlatform.getInstance();

// Actions that mutate something outside Jarvis's own head — where being
// wrong costs the user something they have to notice or undo. Everything
// else still gets logged (execution_ok), just never flagged for a
// "did that work?" follow-up. propose_command/record_command_outcome are
// deliberately absent — command_proposals already has their full lifecycle;
// see docs/superpowers/specs/2026-08-21-outcome-ledger-design.md.
const CONSEQUENTIAL_ACTIONS = new Set([
  "send_email",
  "send_personal_email",
  "github_create_issue",
  "calendar_create_event",
  "write_file",
  "write_vault_note",
  "set_objective",
  "update_objective_status",
]);

export function isConsequentialAction(actionName: string): boolean {
  return CONSEQUENTIAL_ACTIONS.has(actionName);
}

// Never throws — a logging failure must never break the tool call it's
// logging. Fire-and-forget from the caller's perspective.
export async function logAction(
  username: string,
  actionName: string,
  actionSummary: string | null,
  executionOk: boolean
): Promise<void> {
  try {
    const db = getPool();
    await db.query(
      `INSERT INTO outcome_ledger (username, action_name, action_summary, execution_ok, needs_follow_up)
       VALUES ($1, $2, $3, $4, $5)`,
      [username, actionName, actionSummary, executionOk, isConsequentialAction(actionName)]
    );
  } catch (err: any) {
    observation.logTelemetry("warn", "OutcomeLedger", `logAction(${username}, ${actionName}) failed: ${err.message}`);
  }
}

// Resolves against the most recent still-open row for this (username,
// actionName) rather than an id, so the model never has to remember an
// opaque identifier across a conversation that might get compacted — "the
// most recent still-open thing of this type" survives that. A repeat call
// or the user answering twice is a safe no-op, the same guarantee
// command-proposals-repo.ts's recordCommandOutcome gives today.
export async function recordActionOutcome(
  username: string,
  actionName: string,
  outcome: "worked" | "not_worked"
): Promise<boolean> {
  try {
    const db = getPool();
    const { rowCount } = await db.query(
      `UPDATE outcome_ledger SET outcome = $1, outcome_recorded_at = now()
       WHERE id = (
         SELECT id FROM outcome_ledger
         WHERE username = $2 AND action_name = $3 AND needs_follow_up AND outcome IS NULL
         ORDER BY executed_at DESC LIMIT 1
       )`,
      [outcome, username, actionName]
    );
    return (rowCount ?? 0) > 0;
  } catch (err: any) {
    observation.logTelemetry("warn", "OutcomeLedger", `recordActionOutcome(${username}, ${actionName}, ${outcome}) failed: ${err.message}`);
    return false;
  }
}

// Returns null when zero outcomes have ever been recorded for this user —
// callers must treat that as "no data yet," never as "0% success."
// Windowed to the most recent 20 recorded outcomes. Scoped to one user
// (unlike command-proposals-repo.ts's getRecentOutcomeSuccessRate, which is
// intentionally global because command_proposals is effectively
// admin-only) — this ledger covers every user's actions, so a global rate
// would let one user's failures lower the confidence number shown to
// every other user.
export async function getRecentActionSuccessRate(username: string): Promise<number | null> {
  try {
    const db = getPool();
    const { rows } = await db.query(
      `SELECT outcome FROM outcome_ledger
       WHERE username = $1 AND outcome IS NOT NULL
       ORDER BY outcome_recorded_at DESC
       LIMIT 20`,
      [username]
    );
    if (rows.length === 0) return null;
    const worked = rows.filter((r: { outcome: string }) => r.outcome === "worked").length;
    return worked / rows.length;
  } catch (err: any) {
    observation.logTelemetry("warn", "OutcomeLedger", `getRecentActionSuccessRate(${username}) failed: ${err.message}`);
    return null;
  }
}
