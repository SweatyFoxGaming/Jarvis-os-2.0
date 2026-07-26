import { Router } from "express";
import { ObservationPlatform } from "../../kernel/observation.js";
import { validateApiKey } from "../../kernel/auth-middleware.js";
import * as knowledgeGraph from "../../cognition/knowledge-graph.js";
import * as knowledgeGraphRepo from "../../kernel/state/knowledge-graph-repo.js";
import * as identity from "../../self/identity.js";
import * as identityRepo from "../../kernel/state/identity-repo.js";
import * as obsidian from "../../capabilities/providers/obsidian.js";
import { getGroq } from "../../runtime/clients.js";

const observation = ObservationPlatform.getInstance();

export const knowledgeRouter = Router();

// ---------- Structured Knowledge Graph ----------
// The reliable complement to pgvector similarity recall — a real
// entity/fact/relationship lookup by name, not a "sounds like this" guess.
knowledgeRouter.get("/api/knowledge/search", validateApiKey, async (req: any, res: any) => {
  const q = req.query.q as string | undefined;
  if (!q) return res.status(400).json({ error: "q is required" });
  try {
    res.json({ results: await knowledgeGraph.queryKnowledge(q) });
  } catch (err: any) {
    observation.logTelemetry("warn", "KnowledgeGraph", `Search failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

knowledgeRouter.get("/api/knowledge/entities", validateApiKey, async (req: any, res: any) => {
  try {
    res.json({ entities: await knowledgeGraphRepo.listAllEntities() });
  } catch (err: any) {
    res.json({ entities: [], error: err.message });
  }
});

// ---------- Continuity of Self ----------
// Real, structured record of things Jarvis has genuinely said about itself
// — not a claim of actual sentience (see docs/architecture/VISION.md), a
// concrete mechanism for continuity across sessions instead of a static
// hardcoded persona string.
knowledgeRouter.get("/api/identity/reflections", validateApiKey, async (req: any, res: any) => {
  try {
    res.json({ reflections: await identity.reflectOnSelf(req.query.q as string | undefined) });
  } catch (err: any) {
    res.json({ reflections: [], error: err.message });
  }
});

// On-demand generation of a proactive thought (the scheduled job in
// scheduler.ts runs the same real synthesis on a timer without being asked).
knowledgeRouter.get("/api/identity/thought", validateApiKey, async (req: any, res: any) => {
  const groq = getGroq();
  if (!groq) return res.status(503).json({ error: "Requires GROQ_API_KEY to be configured." });
  try {
    const result = await identity.generateProactiveThought(groq);
    if (!result) {
      return res.json({ available: false, reason: "Not enough recorded self-reflection history yet to generate a genuine thought from." });
    }
    await identityRepo.saveProactiveThought(result.content, result.basedOnCount);
    obsidian.appendReflectionEntry("proactive-thought", result.content).catch((err: any) => {
      observation.logTelemetry("warn", "Interaction", `Failed to write reflection vault entry: ${err.message}`);
    });
    res.json({ available: true, ...result });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

knowledgeRouter.get("/api/identity/thoughts/history", validateApiKey, async (req: any, res: any) => {
  try {
    res.json({ thoughts: await identityRepo.getRecentProactiveThoughts() });
  } catch (err: any) {
    res.json({ thoughts: [], error: err.message });
  }
});
