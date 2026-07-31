import { Router } from "express";
import { validateApiKey } from "../../kernel/auth-middleware.js";
import { requireCapability } from "../../kernel/security.js";
import * as rewardEventsRepo from "../../kernel/state/reward-events-repo.js";
import { DEFAULT_MODELS } from "../../runtime/groq-agent-client.js";

export const rewardRouter = Router();

// Aliased rather than referenced directly so it reads alongside
// KNOWN_CATEGORIES below, while still being the one source of truth — the
// candidate lineup lives with the client that actually calls these models.
const KNOWN_MODELS = DEFAULT_MODELS;
const KNOWN_CATEGORIES = ["database", "frontend", "security", "general"];

// Read-only introspection into the coding agent's reward ledger — see
// docs/superpowers/specs/2026-07-27-reward-punishment-coding-agent-design.md.
// Numbers only, no history list — matches the "just report it honestly"
// scope this dashboard panel was built for, not a full analytics view.
rewardRouter.get("/api/reward/summary", validateApiKey, requireCapability("reward.read"), async (req, res) => {
  try {
    const overall = await rewardEventsRepo.getOverallScore();
    const byModel: Record<string, { score: number; count: number } | null> = {};
    for (const model of KNOWN_MODELS) {
      byModel[model] = await rewardEventsRepo.getModelScore(model);
    }
    const byCategory: Record<string, { score: number; count: number } | null> = {};
    for (const category of KNOWN_CATEGORIES) {
      byCategory[category] = await rewardEventsRepo.getCategoryScore(category);
    }
    res.json({ overall, byModel, byCategory });
  } catch (err: any) {
    res.status(500).json({ overall: null, byModel: {}, byCategory: {}, error: "Failed to load the reward summary." });
  }
});
