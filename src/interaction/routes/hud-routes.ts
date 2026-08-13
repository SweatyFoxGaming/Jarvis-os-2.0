import { Router } from 'express';
import { validateApiKey } from "../../kernel/auth-middleware.js";
import { requireCapability } from "../../kernel/security.js";
import { getSession } from "../../cognition/session.js";
import { ObservationPlatform } from "../../kernel/observation.js";
import * as vaultRepo from "../../kernel/state/vault-repo.js";
import * as buildRequestsRepo from "../../kernel/state/build-requests-repo.js";
import { deriveHudBadge } from "../hud-badge.js";
import { recordCompanionVersionReport } from "../../self/health-watchdog.js";

export { deriveHudBadge };

export const hudRouter: Router = Router();

const observation = ObservationPlatform.getInstance();
const RECENT_FAILURE_WINDOW_MS = 60_000;

// Audit log lines look like: "[2026-07-31T10:00:00.000Z] Actor: X | Action:
// Y | Outcome: failed | Details: Z" — cheap substring/timestamp check
// rather than a new structured error-tracking mechanism, since this is the
// only place that needs it.
function hasRecentFailure(): boolean {
  if (!line || !line.includes("Outcome: failed")) return false;
  const match = line.match(/^\[([^\]]+)\]/);
  if (match?.[1] && new Date(match[1]).getTime() >= cutoff) return true;
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

// Self-reported by the EWW HUD bridge (src/ipc/eww-bridge.ts) on its own
// startup, and again on a slow periodic re-report -- see health-watchdog.ts's
// own comment on why this is stored in-memory only. Gated by the dedicated
// hud.report_version capability, NOT hud.read (see security.ts's own comment
// on why: hud.read is documented read-only, and this route performs a real
// write -- recording a value the self-health-check job trusts as evidence of
// what code is actually running -- so reusing hud.read would let any
// principal holding that "harmless" read grant spoof or suppress the
// companion-staleness signal). The deploy script's own env-file comment
// already requires the bridge's configured JARVIS_API_KEY to be the real
// admin key (which holds every capability, including this one) for its
// /ws/events connection to be accepted at all, so this doesn't add any new
// operational burden for the one real caller (the bridge itself).
hudRouter.post("/api/hud/report-version", validateApiKey, requireCapability("hud.report_version"), (req: any, res: any) => {
  const sha = req.body?.sha;
  if (typeof sha !== "string" || !/^[0-9a-f]{40}$/i.test(sha)) {
    return res.status(400).json({ error: "Body must be { sha: <40-character git SHA> }." });
  }
  recordCompanionVersionReport(sha);
  res.json({ ok: true });
});
