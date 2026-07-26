import { Router } from "express";
import { validateApiKey } from "../../kernel/auth-middleware.js";
import * as permissions from "../../kernel/security.js";
import * as featureRequestsRepo from "../../kernel/state/feature-requests-repo.js";

export const featureRequestsRouter = Router();

// ---------- Feature Requests ----------
// The bridge between "asked Jarvis for it in chat" and "actually built by a
// human developer" — see queue_feature_request in src/execution/tools.ts.
// Jarvis only ever writes to this queue; it never writes or executes code.
featureRequestsRouter.get("/api/feature-requests", validateApiKey, async (req: any, res: any) => {
  try {
    const status = req.query.status as featureRequestsRepo.FeatureRequestStatus | undefined;
    res.json({ requests: await featureRequestsRepo.getFeatureRequests(status) });
  } catch (err: any) {
    res.json({ requests: [], error: err.message });
  }
});

featureRequestsRouter.post("/api/feature-requests/:id/status", validateApiKey, async (req: any, res: any) => {
  if (!permissions.hasGrant(req.username, "feature.propose")) {
    return res.status(403).json({ error: 'Missing capability grant "feature.propose"' });
  }
  const { status } = req.body;
  const valid: featureRequestsRepo.FeatureRequestStatus[] = ["queued", "in_progress", "shipped", "declined"];
  if (!valid.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${valid.join(", ")}` });
  }
  try {
    const updated = await featureRequestsRepo.updateFeatureRequestStatus(Number(req.params.id), status);
    if (!updated) return res.status(404).json({ error: "Feature request not found" });
    res.json(updated);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
