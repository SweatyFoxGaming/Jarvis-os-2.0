import type { Migration } from "./runner.js";

// addFact/addRelationship (knowledge-graph-repo.ts) were a check-then-insert:
// SELECT for an existing row, then INSERT if none was found — no
// transaction, no unique constraint. Two concurrent extraction calls for
// the same entity/fact (e.g. the same user chatting from two devices at
// once, or a retried request) could both pass the SELECT and both INSERT,
// producing duplicate rows, directly contradicting addFact's own comment
// ("shouldn't pile up duplicate rows"). This adds the unique constraint
// that was missing (matching kg_entities' own UNIQUE (username, name,
// entity_type), and the ON CONFLICT pattern security-repo.ts's
// upsertNetworkDevice already uses correctly) so the repo functions can
// become a single INSERT ... ON CONFLICT DO NOTHING — no race window.
//
// Existing duplicate rows are removed first (keeping the earliest one, by
// id) since ADD CONSTRAINT UNIQUE fails outright if any duplicates already
// exist on a live deployment.
const migration: Migration = {
  id: "007_dedupe_knowledge_graph",
  description:
    "Deduplicate existing kg_facts/kg_relationships rows and add unique constraints, so addFact/addRelationship can become a race-free INSERT ... ON CONFLICT DO NOTHING instead of a check-then-insert.",
  up: async (client) => {
    await client.query(`
      DELETE FROM kg_facts a USING kg_facts b
      WHERE a.id > b.id AND a.entity_id = b.entity_id AND a.fact = b.fact;
    `);
    await client.query(`
      ALTER TABLE kg_facts ADD CONSTRAINT kg_facts_entity_fact_key UNIQUE (entity_id, fact);
    `);

    await client.query(`
      DELETE FROM kg_relationships a USING kg_relationships b
      WHERE a.id > b.id
        AND a.from_entity_id = b.from_entity_id
        AND a.to_entity_id = b.to_entity_id
        AND a.relationship = b.relationship;
    `);
    await client.query(`
      ALTER TABLE kg_relationships ADD CONSTRAINT kg_relationships_from_to_rel_key
        UNIQUE (from_entity_id, to_entity_id, relationship);
    `);
  },
};

export default migration;
