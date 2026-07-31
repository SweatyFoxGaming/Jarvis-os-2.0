import { Router } from "express";
import { validateApiKey } from "../../kernel/auth-middleware.js";
import { requireCapability } from "../../kernel/security.js";
import { aiLimiter } from "../../kernel/rate-limiters.js";
import * as dailyAdaptation from "../../adaptation/daily-adaptation.js";

export const adaptationRouter = Router();

// aiLimiter: this triggers a real Groq call (and, via the coding pipeline,
// potentially a full autonomous objective attempt) — unlimited like every
// other AI-cost route, not just the systemd timer that normally fires it
// once a day.
adaptationRouter.post("/api/adaptation/run", validateApiKey, requireCapability("adaptation.run"), aiLimiter, async (req: any, res: any) => {
  try {
    const result = await dailyAdaptation.runDailyAdaptation(req.username);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ ok: false, error: "Failed to run the daily adaptation engine." });
  }
});
