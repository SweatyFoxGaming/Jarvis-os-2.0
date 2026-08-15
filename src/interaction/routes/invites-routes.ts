import { Router } from "express";
import { validateApiKey } from "../../kernel/auth-middleware.js";
import * as invitesRepo from "../../kernel/state/invites-repo.js";
import { ObservationPlatform } from "../../kernel/observation.js";

const observation = ObservationPlatform.getInstance();

export const invitesRouter = Router();

// Exported so auth-routes.ts can re-check the same cap at
// registration/redemption time, not just here at invite-creation time —
// see the comment on that re-check for why checking only here isn't
// enough (a burst of invites created before any of them are redeemed can
// blow past this limit with no error anywhere, since this route's check
// only ever sees the state of the world at the moment an invite is minted).
export const MAX_NON_ADMIN_USERS = 10;

// The invite link must resolve for the PERSON BEING INVITED, not just for
// whoever's browser is currently loading the admin panel — building it from
// window.location.origin client-side broke the very first real-world test,
// because admin was sitting at the host machine and loaded the panel over
// http://localhost:3000, so every generated link pointed at "localhost"
// (which only ever means "this machine") instead of anywhere the invitee's
// device could actually reach. PUBLIC_BASE_URL is the one place that
// externally-reachable address is configured (e.g. a Tailscale Serve
// hostname); when it's unset, the link is omitted and the admin panel falls
// back to window.location.origin itself, which is at least correct for
// admin's own testing even if it isn't shareable.
function buildInviteUrl(token: string): string | null {
  const base = process.env.PUBLIC_BASE_URL;
  if (!base) return null;
  return `${base.replace(/\/+$/, "")}/invite/${token}`;
}

invitesRouter.get("/api/invites", validateApiKey, async (req: any, res: any) => {
  if (req.username !== "admin") {
    return res.status(403).json({ error: "Only admin can view invites" });
  }
  try {
    const invites = await invitesRepo.listPendingInvites();
    res.json({
      invites: invites.map((i) => ({
        token: i.token,
        createdAt: i.created_at,
        expiresAt: i.expires_at,
        inviteUrl: buildInviteUrl(i.token),
      })),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

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
    res.json({ token: invite.token, expiresAt: invite.expires_at, inviteUrl: buildInviteUrl(invite.token) });
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
