import { Router } from "express";
import { ObservationPlatform } from "../../kernel/observation.js";
import { validateApiKey } from "../../kernel/auth-middleware.js";
import { requireCapability } from "../../kernel/security.js";
import * as briefing from "../../world/briefing.js";
import * as briefingRepo from "../../kernel/state/briefing-repo.js";
import * as obsidian from "../../capabilities/providers/obsidian.js";
import * as memoryRepo from "../../kernel/state/memory-repo.js";
import { getGroq } from "../../runtime/clients.js";

const observation = ObservationPlatform.getInstance();

export const briefingMemoryRouter = Router();

// No dedicated capability exists for the memory-review queue or admin
// consolidation controls (unlike briefing.read below) — these operate on
// global, not per-user, state (approving/clearing the whole system's pending
// memory queue), so they're gated the same way permissions-routes.ts already
// gates grant/revoke: admin only. Safe to key off the literal username again
// now that a normal account can no longer register as "admin" (closed
// separately).
function requireAdmin(req: any, res: any, next: any) {
  if (req.username !== "admin") {
    return res.status(403).json({ error: "Admin access required" });
  }
  next();
}

// ---------- Proactive Briefing ----------
// GET generates and returns one right now (on demand); the scheduled job in
// scheduler.ts runs the same real synthesis on a timer without being asked.
briefingMemoryRouter.get("/api/briefing", validateApiKey, requireCapability("briefing.read"), async (req: any, res: any) => {
  try {
    const result = await briefing.generateBriefing(getGroq(), req.username);
    try {
      await briefingRepo.saveBriefing(result.text, result.itemCount, result.items);
      obsidian.appendBriefingEntry(result.text, result.itemCount).catch((err: any) => {
        observation.logTelemetry("warn", "Interaction", `Failed to write briefing vault entry: ${err.message}`);
      });
    } catch (err: any) {
      observation.logTelemetry("warn", "Briefing", `Failed to persist on-demand briefing: ${err.message}`);
    }
    res.json(result);
  } catch (err: any) {
    observation.logTelemetry("error", "Briefing", `Briefing generation failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

briefingMemoryRouter.get("/api/briefing/history", validateApiKey, requireCapability("briefing.read"), async (req: any, res: any) => {
  try {
    res.json({ briefings: await briefingRepo.getRecentBriefings() });
  } catch (err: any) {
    res.json({ briefings: [], error: err.message });
  }
});

// Admin & Memory Endpoints — persisted in Postgres, see src/data/memory-repo.ts
briefingMemoryRouter.get("/api/memory/pending", validateApiKey, requireAdmin, async (req: any, res: any) => {
  try {
    res.json(await memoryRepo.getPendingRecords());
  } catch (err: any) {
    observation.logTelemetry("warn", "Database", `Failed to load memory records: ${err.message}`);
    res.status(503).json({ error: "Memory store unavailable" });
  }
});

briefingMemoryRouter.post("/api/memory/verify/:record_uuid", validateApiKey, requireAdmin, async (req: any, res: any) => {
  const { record_uuid } = req.params;
  try {
    const record = await memoryRepo.removeMemoryRecord(record_uuid);
    if (record) {
      observation.logAuditEvent(req.username || "admin", "verify_memory", "success", `Approved memory record ${record_uuid}: "${record.content}"`);
    }
    res.json({ status: "success" });
  } catch (err: any) {
    observation.logTelemetry("warn", "Database", `Failed to verify memory record: ${err.message}`);
    res.status(503).json({ error: "Memory store unavailable" });
  }
});

briefingMemoryRouter.post("/api/memory/verify_all", validateApiKey, requireAdmin, async (req: any, res: any) => {
  try {
    const removed = await memoryRepo.clearMemoryRecords();
    removed.forEach(rec => {
      observation.logAuditEvent(req.username || "admin", "verify_memory", "success", `Approved memory record ${rec.uuid}: "${rec.content}"`);
    });
    res.json({ processed: removed.length });
  } catch (err: any) {
    observation.logTelemetry("warn", "Database", `Failed to verify all memory records: ${err.message}`);
    res.status(503).json({ error: "Memory store unavailable" });
  }
});

briefingMemoryRouter.post("/api/admin/consolidate", validateApiKey, requireAdmin, (req, res) => {
  res.json({ promoted: 0 });
});

briefingMemoryRouter.get("/api/admin/consolidation/status", validateApiKey, requireAdmin, async (req, res) => {
  let pendingCount = 0;
  try {
    pendingCount = await memoryRepo.countMemoryRecords();
  } catch (err: any) {
    observation.logTelemetry("warn", "Database", `Failed to count memory records: ${err.message}`);
  }
  res.json({
    pending_records: pendingCount,
    enabled: true,
    interval_minutes: 30,
  });
});
