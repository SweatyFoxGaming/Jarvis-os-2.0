import { Router } from "express";
import { validateApiKey } from "../../kernel/auth-middleware.js";
import * as permissions from "../../kernel/security.js";
import * as usersRepo from "../../kernel/state/users-repo.js";

export const permissionsRouter = Router();

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

// Bulk rollout: grants a capability to every existing user who doesn't
// already have it — for the case where a new capability ships and the
// admin wants every current user on it in one click, instead of one
// /grant call per username.
permissionsRouter.post("/api/permissions/grant-all", validateApiKey, async (req: any, res: any) => {
  if (req.username !== "admin") {
    return res.status(403).json({ error: "Only admin can bulk-grant capabilities" });
  }
  const { capability } = req.body;
  if (!capability) {
    return res.status(400).json({ error: "capability is required" });
  }
  if (!(permissions.ALL_CAPABILITIES as readonly string[]).includes(capability)) {
    return res.status(400).json({ error: `Unknown capability "${capability}"` });
  }
  const usernames = await usersRepo.listUsernames();
  const granted: string[] = [];
  for (const username of usernames) {
    if (username === "admin") continue; // admin already has every ALL_CAPABILITIES entry via bootstrap
    if (!permissions.hasGrant(username, capability)) {
      await permissions.grantCapability(username, capability, req.username);
      granted.push(username);
    }
  }
  res.json({ status: "success", capability, grantedTo: granted });
});
