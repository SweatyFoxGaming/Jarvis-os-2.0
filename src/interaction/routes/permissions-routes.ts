import { Router } from 'express';
import { validateApiKey } from "../../kernel/auth-middleware.js";
import * as permissions from "../../kernel/security.js";

export const permissionsRouter: Router = Router();

// ---------- Capability grants (permission model) ----------
// Default-deny: a capability (github.issues.create, email.send, ...) only
// works for a user once explicitly granted here. Only the admin key can
// grant/revoke; any authenticated user can see their own grants.

permissionsRouter.get("/api/permissions", validateApiKey, (req: any, res: any) => {
  res.json({ username: req.username, grants: permissions.listGrants(req.username), available: permissions.ALL_CAPABILITIES });
});

permissionsRouter.post("/api/permissions/grant", validateApiKey, async (req: any, res: any) => {
  if (req.username !== "admin") {
    return res.status(403).json({ error: "Only admin can grant capabilities" });
  }
  const { username, capability } = req.body;
  if (!username || !capability) {
    return res.status(400).json({ error: "username and capability are required" });
  }
  if (!(permissions.ALL_CAPABILITIES as readonly string[]).includes(capability)) {
    return res.status(400).json({ error: `Unknown capability "${capability}"` });
  }
  await permissions.grantCapability(username, capability, req.username);
  res.json({ status: "success", username, grants: permissions.listGrants(username) });
});

permissionsRouter.post("/api/permissions/revoke", validateApiKey, async (req: any, res: any) => {
  if (req.username !== "admin") {
    return res.status(403).json({ error: "Only admin can revoke capabilities" });
  }
  const { username, capability } = req.body;
  if (!username || !capability) {
    return res.status(400).json({ error: "username and capability are required" });
  }
  await permissions.revokeCapability(username, capability, req.username);
  res.json({ status: "success", username, grants: permissions.listGrants(username) });
});
