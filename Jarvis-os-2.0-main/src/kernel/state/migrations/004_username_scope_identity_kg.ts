import type { Migration } from "./runner.js";

// Closes a real cross-user data leak, confirmed live on a multi-user
// deployment: kg_entities/kg_facts/kg_relationships (the structured
// knowledge graph — see src/cognition/knowledge-graph.ts) and
// self_reflections/proactive_thoughts (continuity-of-self — see
// src/self/identity.ts) had no username column at all. Every user shared
// one global knowledge graph and one global self-reflection history, so
// anything Jarvis learned about (or said to) one user was readable by, or
// surfaced into the system prompt for, every other user. kg_facts/
// kg_relationships don't need their own username column — they're only
// ever looked up via an entity_id already scoped through kg_entities
// (upsertEntity/searchEntities), never passed in directly by a caller.
//
// Existing rows are backfilled to 'admin' rather than left NULL or guessed
// at some other way: 'admin' is the one username guaranteed to exist in
// every deployment (auth-middleware.ts's INTERNAL_API_KEY identity, never
// a row in the `users` table itself), and this data predates per-user
// scoping entirely, so there's no way to recover which real user it
// actually came from — attributing it to the operator account is the
// least-surprising honest default. The column is NOT NULL with no default
// going forward: every application-level write path is being updated in
// the same change to always pass an explicit username, so a future
// caller forgetting to do so should fail loudly (a missing required
// argument) rather than silently mis-scoping new data to 'admin'.
const migration: Migration = {
  id: "004_username_scope_identity_kg",
  description:
    "Add a username column to kg_entities/self_reflections/proactive_thoughts (backfilled to 'admin') and re-scope kg_entities' " +
    "uniqueness to (username, name, entity_type), closing a cross-user data leak in the knowledge graph and identity-continuity data.",
  up: async (client) => {
    await client.query(`ALTER TABLE kg_entities ADD COLUMN username TEXT;`);
    await client.query(`UPDATE kg_entities SET username = 'admin' WHERE username IS NULL;`);
    await client.query(`ALTER TABLE kg_entities ALTER COLUMN username SET NOT NULL;`);
    await client.query(`ALTER TABLE kg_entities DROP CONSTRAINT IF EXISTS kg_entities_name_entity_type_key;`);
    await client.query(`ALTER TABLE kg_entities ADD CONSTRAINT kg_entities_username_name_entity_type_key UNIQUE (username, name, entity_type);`);
    await client.query(`CREATE INDEX IF NOT EXISTS kg_entities_username_idx ON kg_entities(username);`);

    await client.query(`ALTER TABLE self_reflections ADD COLUMN username TEXT;`);
    await client.query(`UPDATE self_reflections SET username = 'admin' WHERE username IS NULL;`);
    await client.query(`ALTER TABLE self_reflections ALTER COLUMN username SET NOT NULL;`);
    await client.query(`CREATE INDEX IF NOT EXISTS self_reflections_username_idx ON self_reflections(username);`);

    await client.query(`ALTER TABLE proactive_thoughts ADD COLUMN username TEXT;`);
    await client.query(`UPDATE proactive_thoughts SET username = 'admin' WHERE username IS NULL;`);
    await client.query(`ALTER TABLE proactive_thoughts ALTER COLUMN username SET NOT NULL;`);
    await client.query(`CREATE INDEX IF NOT EXISTS proactive_thoughts_username_idx ON proactive_thoughts(username);`);
  },
};

export default migration;
