import { Router } from "express";
import { ObservationPlatform } from "../../kernel/observation.js";
import { LongTermLearningEngine } from "../../adaptation/long_term_learning.js";
import { validateApiKey } from "../../kernel/auth-middleware.js";
import { getSession } from "../../cognition/session.js";

const observation = ObservationPlatform.getInstance();
const learningEngine = LongTermLearningEngine.getInstance();

export const learningRouter = Router();

// ---------- Pass XV: Long-Term Learning Endpoints ----------

learningRouter.get("/api/learning/dashboard", validateApiKey, (req, res) => {
  res.json({
    stylePreferences: learningEngine.getStylePreferences(),
    optimizedWorkflows: learningEngine.listOptimizedWorkflows(),
    mistakeLog: learningEngine.getMistakeLog()
  });
});

learningRouter.post("/api/learning/style", validateApiKey, (req, res) => {
  const { namingConvention, tabSize, frameworkPreference, architecturePattern } = req.body;
  learningEngine.updateStylePreference({
    namingConvention,
    tabSize,
    frameworkPreference,
    architecturePattern
  });
  res.json({ status: "success", preferences: learningEngine.getStylePreferences() });
});

learningRouter.post("/api/learning/mistake", validateApiKey, (req, res) => {
  const { errorSignature, affectedFile, rootCause, successfulFix } = req.body;
  if (!errorSignature || !affectedFile) {
    return res.status(400).json({ error: "Missing errorSignature or affectedFile" });
  }
  learningEngine.logMistake(errorSignature, affectedFile, rootCause, successfulFix);
  res.json({ status: "success", count: learningEngine.getMistakeLog().length });
});

// Learn Endpoint — a quick fact added to the CURRENT session's workspace
// knowledge, distinct from the persistent style/mistake learning above
// (LongTermLearningEngine); grouped here by URL namespace, not mechanism.
learningRouter.post("/api/learn", validateApiKey, async (req: any, res: any) => {
  const { message } = req.body;
  const session = await getSession(req.username);
  session.workspace.knowledge.addFact(`Learned from operator: ${message}`);
  observation.logTelemetry("info", "Cognition", `Dynamically learned new concept: "${message}"`);
  res.json({
    status: "success",
    language: message,
    response: `Simulating learning process for topic: ${message}. Knowledge graph updated.`
  });
});
