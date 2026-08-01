import type { Migration } from "./runner.js";

// Backs Phase 1 of the coding agent's full-autonomy work (see
// docs/superpowers/specs/2026-08-01-full-autonomy-production-readiness-design.md).
// One column, set at merge time by build-approval.ts, read by the daily-cap
// query (countAutonomousMergesToday) and by the dashboard/revert tooling —
// no separate tracking table, this is the single source of truth for "was
// this merge autonomous."
const migration: Migration = {
  id: "007_autonomous_merge",
  description: "Add build_requests.autonomous_merge, set at merge time, so the daily autonomous-merge cap and revert tooling can read off one column.",
  up: async (client) => {
    await client.query(`ALTER TABLE build_requests ADD COLUMN autonomous_merge BOOLEAN NOT NULL DEFAULT false;`);
  },
};

export default migration;
