import { Router } from "express";
import { validateApiKey } from "../../kernel/auth-middleware.js";
import { requireCapability } from "../../kernel/security.js";
import { getSession } from "../../cognition/session.js";
import { ObservationPlatform } from "../../kernel/observation.js";
import * as vaultRepo from "../../kernel/state/vault-repo.js";
import * as buildRequestsRepo from "../../kernel/state/build-requests-repo.js";
import { deriveHudBadge } from "../hud-badge.js";

export { deriveHudBadge };

export const hudRouter = Router();

const observation = ObservationPlatform.getInstance();
const RECENT_FAILURE_WINDOW_MS = 60_000;

// Audit log lines look like: "[2026-07-31T10:00:00.000Z] Actor: X | Action:
// Y | Outcome: failed | Details: Z" — cheap substring/timestamp check
// rather than a new structured error-tracking mechanism, since this is the
// only place that needs it.
function hasRecentFailure(): boolean {
  const logs = observation.getAuditLogs();
  const cutoff = Date.now() - RECENT_FAILURE_WINDOW_MS;
  for (let i = logs.length - 1; i >= 0 && i >= logs.length - 50; i--) {
    const line = logs[i];
    if (!line.includes("Outcome: failed")) continue;
    const match = line.match(/^\[([^\]]+)\]/);
    if (match && new Date(match[1]).getTime() >= cutoff) return true;
  }
  return false;
}

hudRouter.get("/api/hud/status", validateApiKey, requireCapability("hud.read"), async (req: any, res: any) => {
  try {
    const hudUsername = process.env.JARVIS_HUD_USERNAME || "admin";
    if (req.username !== hudUsername) {
      return res.status(403).json({ error: `HUD status is scoped to the "${hudUsername}" account.` });
    }

    const session = await getSession(hudUsername);
    const state = session.getState();
    const recentFailure = hasRecentFailure();
    const badge = deriveHudBadge(state.executiveStatus, recentFailure);

    const traces = observation.getDecisionTraces();
    const thoughtLines = traces.map(t => t.reasoning).filter(Boolean).slice(-3);

    let recentNotes: { path: string; title: string }[] = [];
    try {
      const notes = await vaultRepo.listNotes(3);
      recentNotes = notes.map(n => ({ path: n.path, title: n.title }));
    } catch {
      // Degrade cleanly — no live Postgres shouldn't break the rest of the HUD.
    }

    let activeTask: string | null = null;
    try {
      activeTask = await buildRequestsRepo.getActiveTaskForUser(hudUsername);
    } catch {
      // Degrade cleanly — no live Postgres shouldn't break the rest of the HUD.
    }

    res.json({
      badge,
      statusLabel: state.executiveStatus,
      thoughtLines,
      recentNotes,
      activeTask,
    });
  } catch (err: any) {
    res.status(500).json({ badge: "error", statusLabel: "Unavailable", thoughtLines: [], recentNotes: [], activeTask: null, error: "Failed to load HUD status." });
  }
});
