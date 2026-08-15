import { Router } from 'express';
import { validateApiKey } from "../../kernel/auth-middleware.js";
import { requireCapability } from "../../kernel/security.js";
import * as dailyAdaptation from "../../adaptation/daily-adaptation.js";

export const adaptationRouter: Router = Router();

adaptationRouter.post("/api/adaptation/run", validateApiKey, requireCapability("adaptation.run"), async (req: any, res: any) => {
  try {
    const result = await dailyAdaptation.runDailyAdaptation(req.username);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ ok: false, error: "Failed to run the daily adaptation engine." });
  }
});
