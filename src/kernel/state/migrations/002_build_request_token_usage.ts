import type { Migration } from "./runner.js";

// The coding agent's only spend control used to be turn counts (MAX_TASK_TURNS
// × MAX_PLAN_TASKS) — no tracking of actual token usage, so there was no way
// to enforce a real cost ceiling or show one on the dashboard before a build
// starts. This column is the persistence side of that; the enforcement side
// lives in coding-agent.ts.
const migration: Migration = {
  id: "002_build_request_token_usage",
  description: "Add build_requests.tokens_used to track cumulative NVIDIA token usage per coding session.",
  up: async (client) => {
    await client.query(`ALTER TABLE build_requests ADD COLUMN tokens_used INTEGER NOT NULL DEFAULT 0;`);
  },
};

export default migration;
