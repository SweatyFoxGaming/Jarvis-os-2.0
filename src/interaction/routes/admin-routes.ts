import { Router } from "express";
import { validateApiKey } from "../../kernel/auth-middleware.js";
import * as usersRepo from "../../kernel/state/users-repo.js";
import * as oauthRepo from "../../kernel/state/oauth-repo.js";
import { clearGrantsCache } from "../../kernel/security.js";
import { ObservationPlatform } from "../../kernel/observation.js";

const observation = ObservationPlatform.getInstance();

export const adminRouter = Router();

// Admin-only full account removal — see this plan's design doc
// (docs/superpowers/specs/2026-08-01-multi-user-personal-brains-design.md,
// Component 9): "full cascade delete of the account, personal facts/
// history, and connected-account tokens ... plus clearing their capability
// grants. Full removal, not a soft deactivate." The actual Postgres-side
// cascade (which tables need an explicit DELETE vs. which cascade
// automatically via a real FK, verified against db.ts's schema and live
// against a throwaway Postgres) lives in usersRepo.removeUser — see its
// doc comment in users-repo.ts for the full breakdown. This handler is
// just authorization, the best-effort Google-side revocation, and response
// shaping around that one repo call.
adminRouter.delete("/api/admin/users/:username", validateApiKey, async (req: any, res: any) => {
  if (req.username !== "admin") {
    return res.status(403).json({ error: "Only admin can remove a user" });
  }
  const { username } = req.params;
  if (username === "admin") {
    return res.status(400).json({ error: "Cannot remove the admin identity" });
  }
  try {
    // Best-effort, fire-and-forget Google-side revocation — same discipline
    // as the self-service disconnect route (integrations-routes.ts): must
    // not block or fail this response if Google's revoke endpoint errors.
    // Calendar and Gmail share one PROVIDER constant ("google_calendar" —
    // see personal-gmail.ts's own comment on why), so this one lookup
    // covers both connected-account tokens, not just Calendar's.
    const stored = await oauthRepo.getTokens("google_calendar", username);
    if (stored) {
      fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(stored.refresh_token)}`, { method: "POST" })
        .catch((err) => observation.logTelemetry("warn", "Integrations", `Google-side revocation failed removing "${username}": ${err.message}`));
    }

    const existed = await usersRepo.removeUser(username);
    if (!existed) {
      return res.status(404).json({ error: "User not found" });
    }
    // Drops the in-memory capability-grants cache entry for this username
    // (security.ts's own module-level `grants` Map) now that the DB row
    // backing it is gone — the DB delete inside removeUser is the one that
    // matters for correctness (a deleted user can't authenticate at all
    // once api_keys is gone), this just avoids leaving a stale, unreachable
    // cache entry around until the next process restart.
    clearGrantsCache(username);
    observation.logAuditEvent(req.username, "user_removed", "success", `Removed "${username}"`);
    res.json({ status: "success" });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
