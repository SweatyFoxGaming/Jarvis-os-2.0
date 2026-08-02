import { Router } from "express";
import { validateApiKey } from "../../kernel/auth-middleware.js";
import * as permissions from "../../kernel/security.js";
import * as featureRequestsRepo from "../../kernel/state/feature-requests-repo.js";

export const featureRequestsRouter = Router();

// ---------- Feature Requests ----------
// The bridge between "asked Jarvis for it in chat" and "actually built by a
// human developer" — see queue_feature_request in src/execution/tools.ts.
// Jarvis only ever writes to this queue; it never writes or executes code.
// Every authenticated user (even a fresh personal user with only the
// default capability bundle) can hit this route — validateApiKey alone, no
// requireCapability — because reading your OWN queue of feature requests
// isn't a privileged action. What WAS a bug: the underlying query had no
// per-user filter at all, so any authenticated user could read every OTHER
// user's (and admin's) titles/descriptions/research notes too. Non-admin
// callers are now scoped to their own rows; admin still sees everything, to
// actually triage the queue.
featureRequestsRouter.get("/api/feature-requests", validateApiKey, async (req: any, res: any) => {
  try {
    const status = req.query.status as featureRequestsRepo.FeatureRequestStatus | undefined;
    const scopeToOwnRequests = req.username !== "admin" ? req.username : undefined;
    res.json({ requests: await featureRequestsRepo.getFeatureRequests(status, scopeToOwnRequests) });
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
    // feature.propose is in DEFAULT_PERSONAL_CAPABILITIES, so every personal
    // user holds it — without this ownership check, any of them could change
    // the status of ANY other user's (or admin's) feature request. Fetch
    // first, confirm ownership (or admin), only then apply the update.
    const existing = await featureRequestsRepo.getFeatureRequestById(Number(req.params.id));
    if (!existing) return res.status(404).json({ error: "Feature request not found" });
    if (existing.requested_by !== req.username && req.username !== "admin") {
      return res.status(403).json({ error: "You can only update the status of your own feature requests" });
    }
    const updated = await featureRequestsRepo.updateFeatureRequestStatus(Number(req.params.id), status);
    if (!updated) return res.status(404).json({ error: "Feature request not found" });
    res.json(updated);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
