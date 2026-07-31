import { Router } from "express";
import { validateApiKey } from "../../kernel/auth-middleware.js";
import { requireCapability } from "../../kernel/security.js";
import * as rewardEventsRepo from "../../kernel/state/reward-events-repo.js";

export const rewardRouter = Router();

const KNOWN_MODELS = ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"];
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
    res.json({ overall: null, byModel: {}, byCategory: {}, error: err.message });
  }
});
