import type { Migration } from "./runner.js";

// Replaces the bare in-memory SessionState singleton as the source of truth
// for "is an objective currently running for this user" — two concurrent
// /api/executive/run calls used to race on shared mutable state with
// nothing stopping them. A real row per run, with a partial unique index
// enforcing at most one 'running' row per username, turns that into a
// structural guarantee a second INSERT simply can't violate, instead of
// relying on caller discipline.
const migration: Migration = {
  id: "001_objective_runs",
  description:
    "Create objective_runs — one row per executeObjective() invocation, with a unique index enforcing at most one running row per user.",
  up: async (client) => {
    await client.query(`
      CREATE TABLE objective_runs (
        id SERIAL PRIMARY KEY,
        username TEXT NOT NULL,
        objective TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running',
        build_request_id INTEGER REFERENCES build_requests(id) ON DELETE SET NULL,
        started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        finished_at TIMESTAMPTZ,
        error_detail TEXT
      );
    `);
    await client.query(`
      CREATE UNIQUE INDEX objective_runs_one_running_per_user_idx
      ON objective_runs (username) WHERE status = 'running';
    `);
    await client.query(`CREATE INDEX objective_runs_username_idx ON objective_runs (username, started_at DESC);`);
  },
};

export default migration;
