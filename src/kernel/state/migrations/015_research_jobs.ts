import type { Migration } from "./runner.js";

// Backs persistent, time-boxed deep research (see
// docs/superpowers/specs/2026-07-24-obsidian-vault-integration-design.md).
// A job is a real standing process: the scheduler advances it one research
// round per tick until the user's explicitly approved wall-clock duration is
// reached, then performs one final synthesis and closes the job.
const migration: Migration = {
  id: "015_research_jobs",
  description:
    "Create research_jobs for persistent, time-boxed deep research with explicit start/stop state and round accounting.",
  up: async (client) => {
    await client.query(`
      CREATE TABLE research_jobs (
        id SERIAL PRIMARY KEY,
        topic TEXT NOT NULL,
        target_duration_hours DOUBLE PRECISION NOT NULL,
        status TEXT NOT NULL DEFAULT 'running',
        vault_note_path TEXT NOT NULL,
        rounds_completed INTEGER NOT NULL DEFAULT 0,
        requested_by TEXT NOT NULL,
        started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_round_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ
      );
    `);
    await client.query(`CREATE INDEX research_jobs_status_idx ON research_jobs(status);`);
    await client.query(`CREATE INDEX research_jobs_requested_by_idx ON research_jobs(requested_by, started_at DESC);`);
  },
};

export default migration;
