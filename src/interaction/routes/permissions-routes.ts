import { Router } from "express";
import { validateApiKey } from "../../kernel/auth-middleware.js";
import * as permissions from "../../kernel/security.js";

export const permissionsRouter = Router();

// ---------- Capability grants (permission model) ----------
// Default-deny: a capability (github.issues.create, email.send, ...) only
// works for a user once explicitly granted here. Only the admin key can
// grant/revoke; any authenticated user can see their own grants.

permissionsRouter.get("/api/permissions", validateApiKey, (req: any, res: any) => {
  // `available` stays exactly what it always was (the default-seeded set).
  // `extraGrantable` is reported separately rather than merged into it, so
  // this response never implies an off-by-default capability is part of the
  // ordinary set — it's grantable, but only by deliberate request.
  res.json({
    username: req.username,
    grants: permissions.listGrants(req.username),
    available: permissions.ALL_CAPABILITIES,
    extraGrantable: permissions.EXTRA_GRANTABLE_CAPABILITIES,
  });
});

permissionsRouter.post("/api/permissions/grant", validateApiKey, async (req: any, res: any) => {
  if (req.username !== "admin") {
    return res.status(403).json({ error: "Only admin can grant capabilities" });
  }
  const { username, capability } = req.body;
  if (!username || !capability) {
    return res.status(400).json({ error: "username and capability are required" });
  }
  // ALL_CAPABILITIES *or* EXTRA_GRANTABLE_CAPABILITIES — the latter holds the
  // off-by-default capabilities (executive.autonomous_merge) that must remain
  // grantable through this exact route, but are never auto-seeded to admin by
  // loadGrantsFromDb()'s bootstrap backfill. Validating against
  // ALL_CAPABILITIES alone used to make them ungrantable by any supported
  // path at all; see src/kernel/security.ts for why the two lists are
  // separate and must stay that way.
  if (!permissions.isGrantableCapability(capability)) {
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
