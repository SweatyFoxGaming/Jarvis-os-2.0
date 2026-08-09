import type { Migration } from "./runner.js";

// Backs per-user fair-share usage tracking for the cognition router (see
// .superpowers/sdd/2026-08-07-jarvis-cognition-router) — one row per
// token-usage event, per user. The router sums recent rows to compute a
// user's share of overall traffic and throttle whoever is consuming more
// than an equal per-user share — see usage-repo.ts.
const migration: Migration = {
  id: "009_usage_events",
  description:
    "Create usage_events (one row per per-user token-usage event) so the cognition router can compute a user's recent token share relative to overall traffic for fair-share throttling.",
  up: async (client) => {
    await client.query(`
      CREATE TABLE usage_events (
        id SERIAL PRIMARY KEY,
        username TEXT NOT NULL,
        tokens INTEGER NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await client.query(`CREATE INDEX usage_events_created_at_idx ON usage_events(created_at);`);
    await client.query(`CREATE INDEX usage_events_username_idx ON usage_events(username);`);
  },
};

export default migration;
