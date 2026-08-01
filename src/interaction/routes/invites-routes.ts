import { Router } from "express";
import { validateApiKey } from "../../kernel/auth-middleware.js";
import * as invitesRepo from "../../kernel/state/invites-repo.js";
import { ObservationPlatform } from "../../kernel/observation.js";

const observation = ObservationPlatform.getInstance();

export const invitesRouter = Router();

const MAX_NON_ADMIN_USERS = 10;

invitesRouter.post("/api/invites", validateApiKey, async (req: any, res: any) => {
  if (req.username !== "admin") {
    return res.status(403).json({ error: "Only admin can create invites" });
  }
  try {
    const count = await invitesRepo.countNonAdminUsers();
    if (count >= MAX_NON_ADMIN_USERS) {
      return res.status(403).json({ error: `Already at the ${MAX_NON_ADMIN_USERS}-person limit — remove someone before inviting another.` });
    }
    const invite = await invitesRepo.createInvite(req.username);
    observation.logAuditEvent(req.username, "invite_created", "success", `Invite created, expires ${invite.expires_at.toISOString()}`);
    res.json({ token: invite.token, expiresAt: invite.expires_at });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

invitesRouter.delete("/api/invites/:token", validateApiKey, async (req: any, res: any) => {
  if (req.username !== "admin") {
    return res.status(403).json({ error: "Only admin can revoke invites" });
  }
  try {
    const revoked = await invitesRepo.revokeInvite(req.params.token);
    if (!revoked) {
      return res.status(404).json({ error: "Invite not found, or already used" });
    }
    observation.logAuditEvent(req.username, "invite_revoked", "success", `Invite ${req.params.token.slice(0, 8)}... revoked`);
    res.json({ status: "success" });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
