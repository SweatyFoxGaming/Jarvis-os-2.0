import type { Migration } from "./runner.js";

// Backs the Outcome Ledger (see
// docs/superpowers/specs/2026-08-21-outcome-ledger-design.md), Phase 2 of
// the Verified Autonomy roadmap (docs/architecture/AUTONOMY_VISION.md).
// Logs every tool call executeTool() handles; command_proposals already
// has its own full lifecycle for shell commands and is deliberately left
// alone rather than folded into this table.
const migration: Migration = {
  id: "014_outcome_ledger",
  description:
    "Create outcome_ledger (one row per tool call executeTool() handles, flagged needs_follow_up for a curated 'consequential' subset) so Jarvis's actions outside the command-proposal path can be verified and their success rate fed into the confidence calculation.",
  up: async (client) => {
    await client.query(`
      CREATE TABLE outcome_ledger (
        id SERIAL PRIMARY KEY,
        username TEXT NOT NULL,
        action_name TEXT NOT NULL,
        action_summary TEXT,
        executed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        execution_ok BOOLEAN NOT NULL,
        needs_follow_up BOOLEAN NOT NULL,
        outcome TEXT,
        outcome_recorded_at TIMESTAMPTZ
      );
    `);
    await client.query(`CREATE INDEX outcome_ledger_username_idx ON outcome_ledger(username);`);
    await client.query(`
      CREATE INDEX outcome_ledger_pending_idx ON outcome_ledger(username, action_name)
        WHERE needs_follow_up AND outcome IS NULL;
    `);
  },
};

export default migration;
