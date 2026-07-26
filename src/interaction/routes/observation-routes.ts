import { Router } from "express";
import { ObservationPlatform } from "../../kernel/observation.js";
import { validateApiKey } from "../../kernel/auth-middleware.js";
import { requireCapability } from "../../kernel/security.js";
import * as permissions from "../../kernel/security.js";
import { getSession } from "../../cognition/session.js";

const observation = ObservationPlatform.getInstance();

export const observationRouter = Router();

// ---------- Pass 5, 6 & 7: Observation Platform Exposes API ----------

observationRouter.get("/api/observation/metrics", validateApiKey, (req, res) => {
  res.json(observation.getMetrics());
});

// Telemetry/diagnostics/traces are system-wide operational detail (internal
// error messages, per-turn reasoning, latency) rather than a per-user
// resource that can be meaningfully scoped by username — gated behind the
// same security.read grant get_security_status already requires, instead of
// being readable by any authenticated account regardless of trust level.
observationRouter.get("/api/observation/telemetry", validateApiKey, requireCapability("security.read"), (req, res) => {
  res.json(observation.getTelemetry());
});

observationRouter.get("/api/observation/diagnostics", validateApiKey, requireCapability("security.read"), (req, res) => {
  res.json(observation.runDiagnostics());
});

observationRouter.get("/api/observation/traces", validateApiKey, requireCapability("security.read"), (req, res) => {
  res.json(observation.getDecisionTraces());
});

// Unlike the above, audit *is* a per-account resource — every tool call,
// command proposal, and grant change an account performed. A non-privileged
// caller gets their own history (still useful for "what did I just do"); a
// security.read grant gets the full unfiltered feed, matching how
// /api/security/* already treats that same capability.
observationRouter.get("/api/observation/audit", validateApiKey, (req: any, res: any) => {
  const logs = permissions.hasGrant(req.username, "security.read")
    ? observation.getAuditLogs()
    : observation.getAuditLogsForActor(req.username);
  res.json(logs);
});

observationRouter.get("/api/cognition/workspace", validateApiKey, async (req: any, res: any) => {
  const session = await getSession(req.username);
  res.json(session.workspace.toSnapshot());
});

observationRouter.get("/api/cognition/kernel", validateApiKey, async (req: any, res: any) => {
  const session = await getSession(req.username);
  res.json({
    state: session.getState(),
    attention: session.attentionEngine.getCurrentAttention(),
    thoughtStage: session.thoughtEngine.getStage(),
    thoughtStages: session.thoughtEngine.getStages(),
    dialogueHistory: session.dialogue.getHistory(),
    summarizedDecision: session.dialogue.getSummarizedDecision(),
    confidence: session.getState().confidence
  });
});
