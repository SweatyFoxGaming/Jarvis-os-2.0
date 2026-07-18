import { GoogleGenAI, Type } from "@google/genai";
import { ObservationPlatform } from "../observation/index.js";
import * as kgRepo from "../data/knowledge-graph-repo.js";

const observation = ObservationPlatform.getInstance();

const VALID_ENTITY_TYPES = ["person", "project", "preference", "decision", "tool", "organization", "other"];

const EXTRACTION_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    entities: {
      type: Type.ARRAY,
      description: "Only entities with a genuinely new, concrete fact stated this turn. Empty array if nothing new was actually said.",
      items: {
        type: Type.OBJECT,
        properties: {
          name: { type: Type.STRING, description: "Canonical, consistent name for the entity (e.g. always 'PostgreSQL', not sometimes 'Postgres')" },
          entityType: { type: Type.STRING, description: `One of: ${VALID_ENTITY_TYPES.join(", ")}` },
          fact: { type: Type.STRING, description: "A concrete, specific fact actually stated about this entity this turn — not a summary of the whole conversation" },
        },
        required: ["name", "entityType", "fact"],
      },
    },
    relationships: {
      type: Type.ARRAY,
      description: "Only include if a real relationship between two of the entities above was explicitly stated. Empty array if none.",
      items: {
        type: Type.OBJECT,
        properties: {
          fromEntity: { type: Type.STRING },
          toEntity: { type: Type.STRING },
          relationship: { type: Type.STRING, description: "Short verb phrase, e.g. 'works on', 'depends on', 'reports to'" },
        },
        required: ["fromEntity", "toEntity", "relationship"],
      },
    },
  },
  required: ["entities", "relationships"],
};

/**
 * The structured half of "remembers what matters" — pgvector similarity
 * search (memory-store.ts) answers "what sounds like this," which is
 * fundamentally probabilistic. This answers "what do we actually know about
 * X" reliably: a real entity/fact/relationship graph, extracted the same way
 * reflection.ts extracts style/mistakes — a real Gemini call judges whether
 * anything concrete was actually said, not a keyword scan.
 *
 * Fire-and-forget, same as reflectAndLearn: must never block or slow down
 * the reply the user is waiting on.
 */
export async function extractAndStore(ai: GoogleGenAI, userMessage: string, replyText: string): Promise<void> {
  try {
    const response = await ai.models.generateContent({
      model: "gemini-3.1-flash-lite",
      contents: [{
        role: "user",
        parts: [{
          text:
            "Extract any concrete, new facts and relationships about specific named entities (people, projects, tools, preferences, decisions, organizations) " +
            "from this exchange. Only include something if it was actually stated — never invent or infer beyond what's written. " +
            "If nothing concrete was said, return empty arrays.\n\n" +
            `User: ${userMessage}\n\nJarvis: ${replyText.slice(0, 1500)}`,
        }],
      }],
      config: {
        responseMimeType: "application/json",
        responseSchema: EXTRACTION_SCHEMA,
      },
    });

    const parsed = JSON.parse(response.text || "{}");
    const entities: { name: string; entityType: string; fact: string }[] = Array.isArray(parsed.entities) ? parsed.entities : [];
    const relationships: { fromEntity: string; toEntity: string; relationship: string }[] = Array.isArray(parsed.relationships) ? parsed.relationships : [];

    const entityIdByName = new Map<string, number>();
    for (const e of entities) {
      if (!e.name?.trim() || !VALID_ENTITY_TYPES.includes(e.entityType) || !e.fact?.trim()) continue;
      const id = await kgRepo.upsertEntity(e.name.trim(), e.entityType);
      entityIdByName.set(e.name.trim(), id);
      await kgRepo.addFact(id, e.fact.trim());
    }

    for (const r of relationships) {
      const fromId = entityIdByName.get(r.fromEntity?.trim());
      const toId = entityIdByName.get(r.toEntity?.trim());
      if (fromId && toId && r.relationship?.trim()) {
        await kgRepo.addRelationship(fromId, toId, r.relationship.trim());
      }
    }

    if (entities.length > 0) {
      observation.logTelemetry("info", "KnowledgeGraph", `Extracted ${entities.length} entity fact(s), ${relationships.length} relationship(s).`);
    }
  } catch (err: any) {
    observation.logTelemetry("warn", "KnowledgeGraph", `Extraction failed: ${err.message || err}`);
  }
}

export interface KnowledgeQueryResult {
  entityName: string;
  entityType: string;
  facts: string[];
  relationships: string[];
}

/**
 * The reliable "what do we know about X" read path — a real lookup by name,
 * not a similarity guess. Exposed as the query_knowledge_graph chat tool.
 */
export async function queryKnowledge(query: string): Promise<KnowledgeQueryResult[]> {
  const entities = await kgRepo.searchEntities(query);
  const results: KnowledgeQueryResult[] = [];
  for (const entity of entities) {
    const facts = await kgRepo.getFactsForEntity(entity.id);
    const relationships = await kgRepo.getRelationshipsForEntity(entity.id);
    results.push({
      entityName: entity.name,
      entityType: entity.entity_type,
      facts: facts.map(f => f.fact),
      relationships: relationships.map(r => `${r.direction === "from" ? entity.name : r.otherEntityName} ${r.relationship} ${r.direction === "from" ? r.otherEntityName : entity.name}`),
    });
  }
  return results;
}
