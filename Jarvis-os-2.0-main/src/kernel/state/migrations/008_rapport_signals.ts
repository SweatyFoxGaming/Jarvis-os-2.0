import type { Migration } from "./runner.js";

// Backs per-user rapport/tone modeling (see
// docs/superpowers/specs/2026-08-08-rapport-tone-modeling-design.md) — one
// row per real chat turn, a short LLM-extracted tone descriptor of the
// USER's message (not Jarvis's reply). Read back by rapport.ts to
// synthesize a short "how this user has been coming across lately"
// fragment into the system prompt, adjusting tone within (never against)
// the user's own personality-dial settings.
const migration: Migration = {
  id: "008_rapport_signals",
  description:
    "Create rapport_signals (one row per per-user LLM-extracted tone observation) so Jarvis can adapt tone to each user's real recent communication pattern.",
  up: async (client) => {
    await client.query(`
      CREATE TABLE rapport_signals (
        id SERIAL PRIMARY KEY,
        username TEXT NOT NULL,
        tone_descriptor TEXT NOT NULL,
        formality_observed INTEGER,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await client.query(`CREATE INDEX rapport_signals_username_created_idx ON rapport_signals(username, created_at DESC);`);
  },
};

export default migration;
