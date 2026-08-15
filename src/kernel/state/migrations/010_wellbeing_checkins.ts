import type { Migration } from "./runner.js";

// Backs proactive wellbeing monitoring (see
// docs/superpowers/specs/2026-08-08-wellbeing-monitoring-design.md) — one
// row per user, tracking when they last received a wellbeing check-in, so
// a real, persistent signal doesn't produce a check-in every single day.
const migration: Migration = {
  id: "010_wellbeing_checkins",
  description:
    "Create wellbeing_checkins (one row per user, last check-in timestamp) so proactive wellbeing check-ins don't repeat too often.",
  up: async (client) => {
    await client.query(`
      CREATE TABLE wellbeing_checkins (
        username TEXT PRIMARY KEY,
        last_checkin_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
  },
};

export default migration;
