import { Router, type Request, type Response } from 'express';
import { ObservationPlatform } from "../../kernel/observation.js";
import { LongTermLearningEngine } from "../../adaptation/long_term_learning.js";
import { validateApiKey } from "../../kernel/auth-middleware.js";
import { getSession } from "../../cognition/session.js";

const observation = ObservationPlatform.getInstance();
const learningEngine = LongTermLearningEngine.getInstance();

export const learningRouter: Router = Router();

// ---------- Pass XV: Long-Term Learning Endpoints ----------

learningRouter.get("/api/learning/dashboard", validateApiKey, (req: Request, res: Response) => {
  res.json({
    stylePreferences: learningEngine.getStylePreferences(),
    optimizedWorkflows: learningEngine.listOptimizedWorkflows(),
    mistakeLog: learningEngine.getMistakeLog()
  });
});

learningRouter.post("/api/learning/style", validateApiKey, (req: Request, res: Response) => {
  const { namingConvention, tabSize, frameworkPreference, architecturePattern } = req.body;
  learningEngine.updateStylePreference({
    namingConvention,
    tabSize,
    frameworkPreference,
    architecturePattern
  });
  res.json({ status: "success", preferences: learningEngine.getStylePreferences() });
});

learningRouter.post("/api/learning/mistake", validateApiKey, (req: Request, res: Response) => {
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