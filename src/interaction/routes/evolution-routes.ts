import { Router } from "express";
import { ObservationPlatform } from "../../kernel/observation.js";
import { validateApiKey } from "../../kernel/auth-middleware.js";
import * as analyzer from "../../adaptation/analyzer.js";
import * as evolutionRepo from "../../kernel/state/evolution-repo.js";

const observation = ObservationPlatform.getInstance();

export const evolutionRouter = Router();

// ---------- Evolution: real self-analysis ----------
// Every analysis below is computed from something actually measured (a
// parsed import graph, real tsc/grep output, real telemetry, a real secret
// pattern scan) and persisted to Postgres so /trends and /forecast reflect
// real history — this used to be four endpoints returning the same
// hardcoded { score: 98/99/95/100, issues: [] } no matter what.

const ANALYZERS: Record<string, () => analyzer.AnalysisResult> = {
  architecture: analyzer.analyzeArchitecture,
  quality: analyzer.analyzeQuality,
  performance: analyzer.analyzePerformance,
  security: analyzer.analyzeSecurity,
};

function registerAnalysisRoute(type: string) {
  evolutionRouter.post(`/api/evolution/analyze/${type}`, validateApiKey, async (req: any, res: any) => {
    try {
      const result = ANALYZERS[type]();
      const stored = await evolutionRepo.saveAnalysis(type, result.score, result.issues);
      res.json({ analysis_id: `${type}-${stored.id}`, score: result.score, issues: result.issues });
    } catch (err: any) {
      observation.logTelemetry("error", "Evolution", `${type} analysis failed: ${err.message}`);
      res.status(500).json({ error: `${type} analysis failed: ${err.message}` });
    }
  });
}
for (const type of Object.keys(ANALYZERS)) registerAnalysisRoute(type);

evolutionRouter.get("/api/evolution/recommendations", validateApiKey, async (req: any, res: any) => {
  try {
    const latest = await evolutionRepo.getLatestAnalysisPerType();
    const severityRank: Record<string, number> = { high: 3, medium: 2, low: 1 };
    const recommendations = latest
      .flatMap(a => a.issues.map(issue => ({ type: a.analysis_type, ...issue })))
      .sort((a, b) => (severityRank[b.severity] || 0) - (severityRank[a.severity] || 0));
    res.json({ recommendations });
  } catch (err: any) {
    res.json({ recommendations: [], error: err.message });
  }
});

evolutionRouter.get("/api/evolution/analyses", validateApiKey, async (req: any, res: any) => {
  try {
    res.json({ analyses: await evolutionRepo.getAllAnalyses() });
  } catch (err: any) {
    res.json({ analyses: [], error: err.message });
  }
});

evolutionRouter.get("/api/evolution/dependency-graph", validateApiKey, (req: any, res: any) => {
  try {
    res.json(analyzer.buildDependencyGraph());
  } catch (err: any) {
    res.status(500).json({ error: err.message, nodes: [], edges: [] });
  }
});

evolutionRouter.get("/api/evolution/dashboard", validateApiKey, async (req: any, res: any) => {
  try {
    const latest = await evolutionRepo.getLatestAnalysisPerType();
    const health_score = latest.length > 0
      ? Math.round(latest.reduce((sum, a) => sum + a.score, 0) / latest.length)
      : null;
    const recommendations_pending = latest.reduce((sum, a) => sum + a.issues.length, 0);
    res.json({
      health_score,
      recommendations_pending,
      analyzed_categories: latest.map(a => a.analysis_type),
      note: health_score === null ? "No analyses run yet — POST to /api/evolution/analyze/* first." : undefined,
    });
  } catch (err: any) {
    res.json({ health_score: null, recommendations_pending: 0, error: err.message });
  }
});

evolutionRouter.get("/api/evolution/trends", validateApiKey, async (req: any, res: any) => {
  try {
    const trends: Record<string, { score: number; created_at: Date }[]> = {};
    for (const type of Object.keys(ANALYZERS)) {
      trends[type] = await evolutionRepo.getTrend(type);
    }
    res.json({ trends });
  } catch (err: any) {
    res.json({ trends: {}, error: err.message });
  }
});

evolutionRouter.get("/api/evolution/forecast", validateApiKey, async (req: any, res: any) => {
  try {
    const forecast: Record<string, any> = {};
    for (const type of Object.keys(ANALYZERS)) {
      const points = await evolutionRepo.getTrend(type);
      if (points.length < 3) {
        forecast[type] = { available: false, reason: `Need at least 3 analysis runs for a real trend projection (have ${points.length}).` };
        continue;
      }
      // Real (simple) linear regression over run index vs score — not a
      // fabricated number, and honestly labeled as a naive projection.
      const n = points.length;
      const xs = points.map((_, i) => i);
      const ys = points.map(p => p.score);
      const meanX = xs.reduce((a, b) => a + b, 0) / n;
      const meanY = ys.reduce((a, b) => a + b, 0) / n;
      const slope = xs.reduce((sum, x, i) => sum + (x - meanX) * (ys[i] - meanY), 0) /
        Math.max(1e-9, xs.reduce((sum, x) => sum + (x - meanX) ** 2, 0));
      const intercept = meanY - slope * meanX;
      const nextScore = Math.max(0, Math.min(100, Math.round(intercept + slope * n)));
      forecast[type] = { available: true, method: "linear-regression-naive", projectedNextScore: nextScore, trendDirection: slope > 0.5 ? "improving" : slope < -0.5 ? "declining" : "stable" };
    }
    res.json({ forecast });
  } catch (err: any) {
    res.json({ forecast: {}, error: err.message });
  }
});

evolutionRouter.post("/api/evolution/recommendations/prioritize", validateApiKey, async (req: any, res: any) => {
  try {
    const latest = await evolutionRepo.getLatestAnalysisPerType();
    const severityRank: Record<string, number> = { high: 3, medium: 2, low: 1 };
    const recommendations = latest
      .flatMap(a => a.issues.map(issue => ({ type: a.analysis_type, ...issue })))
      .sort((a, b) => (severityRank[b.severity] || 0) - (severityRank[a.severity] || 0));
    res.json({ recommendations });
  } catch (err: any) {
    res.json({ recommendations: [], error: err.message });
  }
});

evolutionRouter.get("/api/evolution/goals", validateApiKey, async (req: any, res: any) => {
  try {
    const goals = await evolutionRepo.listGoals();
    const metrics = observation.getMetrics().counters;
    const latest = await evolutionRepo.getLatestAnalysisPerType();
    const latestByType = Object.fromEntries(latest.map(a => [a.analysis_type, a.score]));

    const goalsWithStatus = goals.map(g => {
      let currentValue: number | null = null;
      if (g.metric === "averageLatencyMs") currentValue = metrics.averageLatencyMs;
      else if (g.metric === "errorsLogged") currentValue = metrics.errorsLogged;
      else if (g.metric in latestByType) currentValue = latestByType[g.metric];

      const met = currentValue === null ? null : g.comparator === "lte" ? currentValue <= g.target_value : currentValue >= g.target_value;
      return { ...g, currentValue, met };
    });
    res.json({ goals: goalsWithStatus });
  } catch (err: any) {
    res.json({ goals: [], error: err.message });
  }
});

evolutionRouter.post("/api/evolution/goals", validateApiKey, async (req: any, res: any) => {
  const { metric, targetValue, comparator } = req.body;
  if (!metric || typeof targetValue !== "number" || !["lte", "gte"].includes(comparator)) {
    return res.status(400).json({ error: "metric, targetValue (number), and comparator ('lte'|'gte') are required" });
  }
  try {
    const goal = await evolutionRepo.createGoal(metric, targetValue, comparator);
    res.json({ status: "success", goal });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- Ecosystem (stub — no real plugin system exists yet) ----------
evolutionRouter.post("/api/ecosystem/discover", validateApiKey, (req, res) => {
  res.json({ discovered: [] });
});

evolutionRouter.post("/api/ecosystem/install", validateApiKey, (req, res) => {
  res.json({ status: "success" });
});

evolutionRouter.get("/api/ecosystem/plugins", validateApiKey, (req, res) => {
  res.json({ plugins: [] });
});
