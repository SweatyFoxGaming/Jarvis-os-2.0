import type { Migration } from "./runner.js";

// Backs the reward/punishment system for the coding agent (see
// docs/superpowers/specs/2026-07-27-reward-punishment-coding-agent-design.md).
// This is RL-flavored, not RL — a persistent reward ledger over real
// outcomes (per-task review verdicts, terminal build outcomes) that biases
// model preference and prompting, never a weight update (impossible
// against hosted LLM APIs regardless). One write path, several read-side
// aggregations — see reward-events-repo.ts.
const migration: Migration = {
  id: "006_reward_events",
  description:
    "Create reward_events (one row per reward-worthy coding-agent signal) and add build_requests.coding_model_used/task_category so a build request's terminal outcome can be tagged with the same model/category its earlier task-review events used.",
  up: async (client) => {
    await client.query(`
      CREATE TABLE reward_events (
        id SERIAL PRIMARY KEY,
        build_request_id INTEGER NOT NULL REFERENCES build_requests(id) ON DELETE CASCADE,
        source TEXT NOT NULL,
        model_used TEXT,
        category TEXT NOT NULL,
        reward_value INTEGER NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await client.query(`CREATE INDEX reward_events_model_idx ON reward_events(model_used);`);
    await client.query(`CREATE INDEX reward_events_category_idx ON reward_events(category);`);
    await client.query(`CREATE INDEX reward_events_source_idx ON reward_events(source);`);
    await client.query(`ALTER TABLE build_requests ADD COLUMN coding_model_used TEXT;`);
    await client.query(`ALTER TABLE build_requests ADD COLUMN task_category TEXT;`);
  },
};

export default migration;
