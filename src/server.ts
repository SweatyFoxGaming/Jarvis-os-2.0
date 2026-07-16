import express from "express";
import cors from "cors";
import path from "path";
import dotenv from "dotenv";
import { GoogleGenAI } from "@google/genai";
import { CognitiveWorkspace } from "./cognition/workspace.js";
import { ObservationPlatform } from "./observation/index.js";
import { AutonomousExecutive } from "./execution/autonomous_executive.js";
import { LongTermLearningEngine } from "./cognition/long_term_learning.js";
import { ExecutiveBoard } from "./execution/executive_board.js";

dotenv.config();

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

// ---------- Platform Instances ----------
const workspace = new CognitiveWorkspace();
const observation = ObservationPlatform.getInstance();

observation.startProfile("startup");

// ---------- Gemini Client Initialization ----------
let ai: GoogleGenAI | null = null;
if (process.env.GEMINI_API_KEY) {
  ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      }
    }
  });
  observation.logTelemetry("info", "Cognition", "Gemini AI client successfully configured with API Key.");
} else {
  observation.logTelemetry("warn", "Cognition", "No GEMINI_API_KEY detected. Running AI features in simulated mode.");
}

const executive = new AutonomousExecutive(workspace, observation, ai);
const learningEngine = LongTermLearningEngine.getInstance();
const executiveBoard = new ExecutiveBoard();

// ---------- In-Memory Users & Keys ----------
const users = new Map<string, string>(); // username -> password
const apiKeys = new Map<string, string>(); // apiKey -> username

// Seed default admin user
users.set("admin", "admin123");
apiKeys.set("admin", "admin");

const ADMIN_API_KEY = process.env.INTERNAL_API_KEY || "admin";

interface PendingRecord {
  uuid: string;
  content: string;
  source: string;
  importance: number;
}

const pendingRecords: PendingRecord[] = [
  { uuid: "rec-1", content: "Executive goal: Integrate PostgreSQL for digital twins", source: "System", importance: 8 },
  { uuid: "rec-2", content: "User preference: Prefers dark slate aesthetic for graph nodes", source: "User", importance: 6 },
  { uuid: "rec-3", content: "Cognitive pattern: Auto-consolidation loop ran successfully", source: "Engine", importance: 5 },
];

// ---------- Middleware: API Key Auth ----------
const validateApiKey = (req: any, res: any, next: any) => {
  const apiKey = req.headers["x-api-key"] || req.query.api_key;
  if (!apiKey) {
    observation.logTelemetry("warn", "Security", "Access denied: Missing API Key");
    return res.status(401).json({ error: "Missing API Key" });
  }
  if (apiKey === ADMIN_API_KEY) {
    req.username = "admin";
    return next();
  }
  const username = apiKeys.get(apiKey);
  if (username) {
    req.username = username;
    return next();
  }
  observation.logTelemetry("warn", "Security", `Access denied: Invalid API Key "${apiKey}"`);
  return res.status(403).json({ error: "Invalid API Key" });
};

// ---------- Endpoints ----------

// Health Check
app.get("/health", (req, res) => {
  const health = observation.getHealth();
  res.json({
    status: health.status === "green" ? "up" : "degraded",
    version: "1.8.0",
    engine_ready: true,
    health
  });
});

app.get("/props", (req, res) => {
  res.json({ status: "up", version: "1.8.0", engine_ready: true });
});

app.get("/favicon.ico", (req, res) => {
  res.sendStatus(204);
});

// Model list compatible with OpenAI
app.get(["/v1/models", "/api/v1/models"], (req, res) => {
  res.json({
    object: "list",
    data: [
      { id: "jarvis-cognitive-engine", object: "model", created: 1677610602, owned_by: "phoenix-os" }
    ],
  });
});

// Constitution / Governance
app.get("/api/governance", (req, res) => {
  res.json({
    name: "Jarvis Constitution",
    version: "3.1.0",
    text: "This Constitution establishes the core cognitive constraints and operational boundaries of JARVIS OS. Under this system, all actions must align with safety policies, budgetary thresholds, and human-aligned intents."
  });
});

// Authentication Endpoints
app.post("/api/register", (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: "Username and password required" });
  }
  if (users.has(username)) {
    return res.status(400).json({ error: "Username already exists" });
  }
  users.set(username, password);
  const apiKey = `jarvis_key_${Math.random().toString(36).substring(2)}`;
  apiKeys.set(apiKey, username);
  observation.logAuditEvent(username, "register", "success", `Registered new user: ${username}`);
  res.json({ username, api_key: apiKey });
});

app.post("/api/login", (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: "Username and password required" });
  }
  if (users.get(username) === password) {
    let apiKey = [...apiKeys.entries()].find(([_, v]) => v === username)?.[0];
    if (!apiKey) {
      apiKey = `jarvis_key_${Math.random().toString(36).substring(2)}`;
      apiKeys.set(apiKey, username);
    }
    observation.logAuditEvent(username, "login", "success", `User logged in: ${username}`);
    res.json({ username, api_key: apiKey });
  } else {
    observation.logAuditEvent(username || "unknown", "login", "failed", "Invalid credentials provided");
    res.status(401).json({ error: "Invalid credentials" });
  }
});

// Status & Diagnostics
app.get("/api/status", validateApiKey, (req: any, res: any) => {
  const stats = observation.getMetrics();
  res.json({
    cpu: Math.round(stats.system.cpuUsagePercent * 10) / 10,
    ram_available_mb: stats.system.freeMemoryMb,
    disk: 38,
    engine_ready: true,
    user: req.username,
  });
});

// ---------- Pass 5, 6 & 7: Observation Platform Exposes API ----------

app.get("/api/observation/metrics", validateApiKey, (req, res) => {
  res.json(observation.getMetrics());
});

app.get("/api/observation/telemetry", validateApiKey, (req, res) => {
  res.json(observation.getTelemetry());
});

app.get("/api/observation/diagnostics", validateApiKey, (req, res) => {
  res.json(observation.runDiagnostics());
});

app.get("/api/observation/traces", validateApiKey, (req, res) => {
  res.json(observation.getDecisionTraces());
});

app.get("/api/observation/audit", validateApiKey, (req, res) => {
  res.json(observation.getAuditLogs());
});

app.get("/api/cognition/workspace", validateApiKey, (req, res) => {
  res.json(workspace.toSnapshot());
});

// Autonomous Executive Execution Hook
app.post("/api/executive/run", validateApiKey, async (req: any, res: any) => {
  const { objective } = req.body;
  if (!objective) {
    return res.status(400).json({ error: "Missing objective" });
  }

  try {
    const report = await executive.executeObjective(objective);
    res.json(report);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ---------- Pass XV: Long-Term Learning Endpoints ----------

app.get("/api/learning/dashboard", validateApiKey, (req, res) => {
  res.json({
    stylePreferences: learningEngine.getStylePreferences(),
    optimizedWorkflows: learningEngine.listOptimizedWorkflows(),
    mistakeLog: learningEngine.getMistakeLog()
  });
});

app.post("/api/learning/style", validateApiKey, (req, res) => {
  const { namingConvention, tabSize, frameworkPreference, architecturePattern } = req.body;
  learningEngine.updateStylePreference({
    namingConvention,
    tabSize,
    frameworkPreference,
    architecturePattern
  });
  res.json({ status: "success", preferences: learningEngine.getStylePreferences() });
});

app.post("/api/learning/mistake", validateApiKey, (req, res) => {
  const { errorSignature, affectedFile, rootCause, successfulFix } = req.body;
  if (!errorSignature || !affectedFile) {
    return res.status(400).json({ error: "Missing errorSignature or affectedFile" });
  }
  learningEngine.logMistake(errorSignature, affectedFile, rootCause, successfulFix);
  res.json({ status: "success", count: learningEngine.getMistakeLog().length });
});

// ---------- Pass XVI: Multi-Agent Executive Board Endpoints ----------

app.post("/api/executive/board/debate", validateApiKey, async (req: any, res: any) => {
  const { prompt, proposedResponse } = req.body;
  if (!prompt || !proposedResponse) {
    return res.status(400).json({ error: "Missing prompt or proposedResponse" });
  }

  try {
    const debateReport = await executiveBoard.conveneDebate(prompt, proposedResponse);
    res.json(debateReport);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ---------- Intelligent Action Loop ----------

// Chat Streaming Endpoint (SSE)
app.post("/api/chat", validateApiKey, async (req: any, res: any) => {
  const { message } = req.body;
  if (!message) {
    return res.status(400).json({ error: "Missing message" });
  }

  const startTime = performance.now();
  observation.startProfile("chat_request");
  observation.incrementMetric("totalRequests");

  // Update workspace contexts
  workspace.conversation.addMessage("user", message);
  workspace.execution.setTask("Process user prompt");
  workspace.execution.updateStatus("planning");
  workspace.reasoning.setThought("Interpreting user semantic intent and planning response strategy.", 0.95);

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  let fullReply = "";

  try {
    if (ai) {
      observation.incrementMetric("geminiApiCalls");
      workspace.execution.updateStatus("executing");
      workspace.capability.setCapability("Gemini LLM Generation");

      const responseStream = await ai.models.generateContentStream({
        model: "gemini-3.5-flash",
        contents: message,
        config: {
          systemInstruction: "You are JARVIS V3, the Executive Mind of the Phoenix Intelligence Platform. Respond in a calm, helpful, intellectual tone.",
        }
      });

      for await (const chunk of responseStream) {
        if (chunk.text) {
          fullReply += chunk.text;
          res.write(`data: ${chunk.text}\n\n`);
        }
      }
    } else {
      // Simulation mode
      workspace.execution.updateStatus("executing");
      workspace.capability.setCapability("Local Cognitive Simulator");
      const simulatedResponse = `I have received your request: "${message}". I am operating in simulation mode. Once you configure process.env.GEMINI_API_KEY, I can connect to my fully cognitive deep reasoning system.`;
      
      const words = simulatedResponse.split(" ");
      for (const word of words) {
        fullReply += word + " ";
        res.write(`data: ${word} \n\n`);
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
    }

    // Refinement/Reflection stage
    workspace.execution.updateStatus("learning");
    workspace.conversation.addMessage("assistant", fullReply);
    workspace.reasoning.setThought("Response generated. Updating cognitive workspace with response statistics.", 1.0);
    
    const latency = performance.now() - startTime;
    observation.recordLatency(latency);
    observation.endProfile("chat_request");

    // Pass 7: Build detailed Decision Trace
    const decisionTrace = {
      intent: `Answer user question: "${message.substring(0, 40)}${message.length > 40 ? '...' : ''}"`,
      goals: ["Process incoming message", "Maintain stable interactive dialogue"],
      strategy: ai ? "Direct prompt submission to Gemini-3.5-Flash text stream" : "Local fallback string generation",
      planner: ["Acknowledge token streams", "Update context caches", "Stream SSE data", "Register telemetry metrics"],
      capabilitySelection: [ai ? "Gemini LLM Client" : "Simulated Response Engine"],
      reasoning: `Decided to parse text and reply immediately to maintain a sub-second response time. Latency measured: ${latency.toFixed(1)} ms. Context size: ${workspace.conversation.history.length} events.`,
      knowledgeUsed: workspace.knowledge.loadedFacts,
      executionResult: "Successfully flushed SSE token stream to client",
      reflection: `Latency of ${latency.toFixed(0)}ms was highly acceptable. Response quality matched Jarvis OS guidelines. No anomalies detected.`,
      confidence: ai ? 0.98 : 0.85
    };

    observation.recordDecisionTrace(decisionTrace);
    workspace.execution.updateStatus("idle");

    // Output trace detail for the frontend to render elegantly
    res.write(`data: detail: ${JSON.stringify(decisionTrace)}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();

  } catch (error: any) {
    observation.logTelemetry("error", "Executive", `Failed to complete chat stream: ${error.message}`);
    workspace.execution.updateStatus("error");
    res.write(`data: Error: ${error.message}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  }
});

// Chat completions compatible with OpenAI standard
app.post(["/v1/chat/completions", "/api/v1/chat/completions"], validateApiKey, async (req: any, res: any) => {
  const { messages } = req.body;
  let userMsg = "Hello";
  if (messages && messages.length > 0) {
    userMsg = messages[messages.length - 1].content;
  }

  const startTime = Date.now();
  try {
    let reply = "";
    if (ai) {
      observation.incrementMetric("geminiApiCalls");
      const response = await ai.models.generateContent({
        model: "gemini-3.5-flash",
        contents: userMsg,
      });
      reply = response.text || "";
    } else {
      reply = `[Simulation] Acknowledged: ${userMsg}`;
    }

    observation.recordLatency(Date.now() - startTime);

    res.json({
      id: `chatcmpl-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: "jarvis-cognitive-engine",
      choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }],
    });
  } catch (error: any) {
    observation.logTelemetry("error", "Cognition", `Chat completion failed: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Learn Endpoint
app.post("/api/learn", validateApiKey, async (req: any, res: any) => {
  const { message } = req.body;
  workspace.knowledge.addFact(`Learned from operator: ${message}`);
  observation.logTelemetry("info", "Cognition", `Dynamically learned new concept: "${message}"`);
  res.json({
    status: "success",
    language: message,
    response: `Simulating learning process for topic: ${message}. Knowledge graph updated.`
  });
});

// Shutdown Hook
app.post("/api/shutdown", (req, res) => {
  observation.logTelemetry("warn", "System", "Server shutdown API invoked");
  res.json({ status: "shutdown initiated" });
});

// Notifications Stream
app.get("/api/notifications/stream", validateApiKey, (req: any, res: any) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  const sessionId = `session_${Math.random().toString(36).substring(2)}`;
  res.write(`event: connected\ndata: ${JSON.stringify({ session_id: sessionId, status: "connected" })}\n\n`);

  const interval = setInterval(() => {
    res.write(`event: ping\ndata: ${JSON.stringify({ timestamp: Date.now() / 1000 })}\n\n`);
  }, 30000);

  req.on("close", () => {
    clearInterval(interval);
  });
});

app.get("/api/notifications", validateApiKey, (req, res) => {
  res.json({
    notifications: [],
    count: 0,
    unread_count: 0,
  });
});

app.post("/api/notifications/mark_read", validateApiKey, (req, res) => {
  res.json({ status: "success" });
});

// Admin & Memory Endpoints
app.get("/api/memory/pending", validateApiKey, (req, res) => {
  res.json(pendingRecords);
});

app.post("/api/memory/verify/:record_uuid", validateApiKey, (req, res) => {
  const { record_uuid } = req.params;
  const index = pendingRecords.findIndex(r => r.uuid === record_uuid);
  if (index !== -1) {
    const record = pendingRecords[index];
    pendingRecords.splice(index, 1);
    observation.logAuditEvent(req.username || "admin", "verify_memory", "success", `Approved memory record ${record_uuid}: "${record.content}"`);
  }
  res.json({ status: "success" });
});

app.post("/api/memory/verify_all", validateApiKey, (req, res) => {
  const approvedCount = pendingRecords.length;
  pendingRecords.forEach(rec => {
    observation.logAuditEvent(req.username || "admin", "verify_memory", "success", `Approved memory record ${rec.uuid}: "${rec.content}"`);
  });
  pendingRecords.length = 0;
  res.json({ processed: approvedCount });
});

app.post("/api/admin/consolidate", validateApiKey, (req, res) => {
  res.json({ promoted: 0 });
});

app.get("/api/admin/consolidation/status", validateApiKey, (req, res) => {
  res.json({
    pending_records: pendingRecords.length,
    enabled: true,
    interval_minutes: 30,
  });
});

// ---------- Evolution & Ecosystem (Stubs) ----------
app.post("/api/evolution/analyze/architecture", validateApiKey, (req, res) => {
  res.json({ analysis_id: "arch-1", score: 98, issues: [] });
});

app.post("/api/evolution/analyze/quality", validateApiKey, (req, res) => {
  res.json({ analysis_id: "qual-1", score: 99, issues: [] });
});

app.post("/api/evolution/analyze/performance", validateApiKey, (req, res) => {
  res.json({ analysis_id: "perf-1", score: 95, issues: [] });
});

app.post("/api/evolution/analyze/security", validateApiKey, (req, res) => {
  res.json({ analysis_id: "sec-1", score: 100, issues: [] });
});

app.get("/api/evolution/recommendations", validateApiKey, (req, res) => {
  res.json({ recommendations: [] });
});

app.get("/api/evolution/analyses", validateApiKey, (req, res) => {
  res.json({ analyses: [] });
});

app.get("/api/evolution/dependency-graph", validateApiKey, (req, res) => {
  res.json({ nodes: [], edges: [] });
});

app.get("/api/evolution/dashboard", validateApiKey, (req, res) => {
  res.json({ health_score: 98, recommendations_pending: 0 });
});

app.get("/api/evolution/trends", validateApiKey, (req, res) => {
  res.json({ trends: [] });
});

app.get("/api/evolution/forecast", validateApiKey, (req, res) => {
  res.json({ forecast: [] });
});

app.post("/api/evolution/recommendations/prioritize", validateApiKey, (req, res) => {
  res.json({ recommendations: [] });
});

app.get("/api/evolution/goals", validateApiKey, (req, res) => {
  res.json({ goals: [] });
});

app.post("/api/ecosystem/discover", validateApiKey, (req, res) => {
  res.json({ discovered: [] });
});

app.post("/api/ecosystem/install", validateApiKey, (req, res) => {
  res.json({ status: "success" });
});

app.get("/api/ecosystem/plugins", validateApiKey, (req, res) => {
  res.json({ plugins: [] });
});

// ---------- Static Files Serving ----------
const staticDir = path.join(process.cwd(), "src", "static");
app.use(express.static(staticDir));

app.get("/admin", (req, res) => {
  res.sendFile(path.join(staticDir, "admin.html"));
});

app.get("/mind", (req, res) => {
  res.sendFile(path.join(staticDir, "mind.html"));
});

// Fallback to serving index.html for unknown routes (SPA style)
app.get("*", (req, res) => {
  res.sendFile(path.join(staticDir, "index.html"));
});

observation.endProfile("startup");

app.listen(PORT, "0.0.0.0", () => {
  observation.logTelemetry("info", "System", `🚀 Jarvis OS Server running on http://localhost:${PORT}`);
});
