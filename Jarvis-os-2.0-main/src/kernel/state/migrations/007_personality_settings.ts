import type { Migration } from "./runner.js";

// Three new dials on the existing system_settings singleton (see
// 003_system_settings.ts's own comment on why this stays a singleton row):
// how Jarvis's tone should skew across every real LLM call, not just a
// display-only preference. Each is an integer 0-100 with the same default
// the hardcoded persona already implies today (see identity.ts's
// buildPersonalityPromptFragment) — formality/verbosity start at a neutral
// midpoint, humor starts low-but-present to match the existing "understated,
// deadpan" baseline in server.ts's system prompt, not zero.
const migration: Migration = {
  id: "007_personality_settings",
  description:
    "Add personality_formality/personality_humor/personality_verbosity (integer 0-100) to system_settings, so the persona sliders are backed by real persisted state consumed by the actual system prompt.",
  up: async (client) => {
    await client.query(`ALTER TABLE system_settings ADD COLUMN personality_formality INTEGER NOT NULL DEFAULT 50;`);
    await client.query(`ALTER TABLE system_settings ADD COLUMN personality_humor INTEGER NOT NULL DEFAULT 30;`);
    await client.query(`ALTER TABLE system_settings ADD COLUMN personality_verbosity INTEGER NOT NULL DEFAULT 50;`);
  },
};

export default migration;
