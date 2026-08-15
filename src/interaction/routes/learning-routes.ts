import { Router, type Request, type Response } from 'express';
import { ObservationPlatform } from "../../kernel/observation.js";
import { LongTermLearningEngine } from "../../adaptation/long_term_learning.js";
import { validateApiKey } from "../../kernel/auth-middleware.js";
import { getSession } from "../../cognition/session.js";

const observation = ObservationPlatform.getInstance();
const learningEngine = LongTermLearningEngine.getInstance();

export const learningRouter: Router = Router();

// ---------- Pass XV: Long-Term Learning Endpoints ----------
//
// Admin-only, on all three routes below: LongTermLearningEngine.getInstance()
// is a process-wide singleton with NO per-user scoping, and its state (style
// preferences, mistake log) is interpolated directly into the system prompt
// of EVERY chat session — including admin's own (see server.ts's /api/chat
// handler building `styleContext` from getStylePreferences()). Without this
// gate, any authenticated personal user — even one with only the default
// capability bundle — could write arbitrary strings via POST
// /api/learning/style or /api/learning/mistake that get injected straight
// into the admin's own AI system prompt: a cross-tenant prompt-injection
// primitive, not just a data leak. The GET dashboard route is gated the same
// way rather than left open for personal users to read, because there are no
// per-user preferences here to read — it's the same global state, so even a
// read would leak admin's real coding-session mistake log to every other
// user. Mirrors the req.username !== "admin" pattern used in
// permissions-routes.ts/admin-routes.ts/invites-routes.ts rather than
// inventing a new capability, since this data was only ever meant to be
// touched by the single admin identity.
const requireAdmin = (req: any, res: any, next: any) => {
  if (req.username !== "admin") {
    return res.status(403).json({ error: "Only admin can access long-term learning data" });
  }
  next();
};

learningRouter.get("/api/learning/dashboard", validateApiKey, requireAdmin, (req: Request, res: Response) => {
  res.json({
    stylePreferences: learningEngine.getStylePreferences(),
    optimizedWorkflows: learningEngine.listOptimizedWorkflows(),
    mistakeLog: learningEngine.getMistakeLog()
  });
});

learningRouter.post("/api/learning/style", validateApiKey, requireAdmin, (req: Request, res: Response) => {
  const { namingConvention, tabSize, frameworkPreference, architecturePattern } = req.body;
  learningEngine.updateStylePreference({
    namingConvention,
    tabSize,
    frameworkPreference,
    architecturePattern
  });
  res.json({ status: "success", preferences: learningEngine.getStylePreferences() });
});

learningRouter.post("/api/learning/mistake", validateApiKey, requireAdmin, (req: Request, res: Response) => {
  const { errorSignature, affectedFile, rootCause, successfulFix } = req.body;
  if (!errorSignature || !affectedFile) {
    res.status(400).json({ error: "Missing errorSignature or affectedFile" });
    return;
  }
  learningEngine.logMistake(errorSignature, affectedFile, rootCause, successfulFix);
  res.json({ status: "success", count: learningEngine.getMistakeLog().length });
});

// Learn Endpoint — a quick fact added to the CURRENT session's workspace
learningRouter.post("/api/learn", validateApiKey, async (req: Request, res: Response) => {
  const { message } = req.body;
  const username = (req as any).username ?? 'operator';
  const session = await getSession(username);
  
  session.workspace.knowledge.addFact(`Learned from operator: ${message}`);
  observation.logTelemetry("info", "Cognition", `Dynamically learned new concept: "${message}"`);
  
  res.json({
    status: "success",
    language: message,
    response: `Simulating learning process for topic: ${message}. Knowledge graph updated.`
  });
});