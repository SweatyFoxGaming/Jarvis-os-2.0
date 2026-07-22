import express from "express";
import helmet from "helmet";
import cors from "cors";
import path from "path";
import crypto from "crypto";
import dotenv from "dotenv";
import rateLimit from "express-rate-limit";
import { GoogleGenAI, Content, FunctionCall } from "@google/genai";
import Groq from "groq-sdk";
import { ObservationPlatform } from "./observation/index.js";
import { AutonomousExecutive } from "./execution/autonomous_executive.js";
import { LongTermLearningEngine } from "./cognition/long_term_learning.js";
import { ExecutiveBoard } from "./execution/executive_board.js";
import { MindKernel } from "./cognition/kernel/kernel.js";
import { LocalCognitiveEngine } from "./cognition/local_engine.js";
import * as github from "./integrations/github.js";
import * as emailIntegration from "./integrations/email.js";
import * as tts from "./integrations/tts.js";
import * as whisper from "./integrations/whisper.js";
import * as jarvisFiles from "./integrations/files.js";
import * as calendar from "./integrations/calendar.js";
import { initDatabase } from "./data/db.js";
import * as usersRepo from "./data/users-repo.js";
import * as memoryRepo from "./data/memory-repo.js";
import * as sessionRepo from "./data/session-repo.js";
import { getSession, pruneIdleSessions, getActiveSessionCount, SessionState } from "./cognition/session.js";
import { getAllToolDeclarations, executeTool, looksToolShaped } from "./execution/tools.js";
import * as permissions from "./execution/permissions.js";
import * as memoryStore from "./cognition/memory-store.js";
import * as scheduler from "./execution/scheduler.js";
import { reflectAndLearn } from "./cognition/reflection.js";
import { WebSocketServer } from "ws";
import * as liveVoice from "./cognition/live-voice.js";
import * as knowledgeGraph from "./cognition/knowledge-graph.js";
import * as knowledgeGraphRepo from "./data/knowledge-graph-repo.js";
import * as briefing from "./execution/briefing.js";
import * as briefingRepo from "./data/briefing-repo.js";
import * as analyzer from "./evolution/analyzer.js";
import * as evolutionRepo from "./data/evolution-repo.js";
import * as identity from "./cognition/identity.js";
import * as identityRepo from "./data/identity-repo.js";
import * as news from "./integrations/news.js";
import * as webSearch from "./integrations/websearch.js";
import * as featureRequestsRepo from "./data/feature-requests-repo.js";
import * as securityRepo from "./data/security-repo.js";
import * as commandProposalsRepo from "./data/command-proposals-repo.js";
import * as pushRepo from "./data/push-subscriptions-repo.js";
import * as mcpServersRepo from "./data/mcp-servers-repo.js";
import * as mcpRegistry from "./execution/mcp-registry.js";
import * as push from "./integrations/push.js";
import * as buildRequestsRepo from "./data/build-requests-repo.js";
import * as departments from "./execution/departments.js";

dotenv.config();

// A rejection/exception outside a route's own try/catch (e.g. inside an SSE
// streaming loop) would otherwise silently kill the whole process.
process.on("unhandledRejection", (reason) => {
  console.error("[server] Unhandled promise rejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[server] Uncaught exception:", err);
});

const app = express();
const PORT = 3000;

// No literal-fallback here on purpose: a missing/short key must fail loudly
// at boot rather than silently granting admin access to a guessable default.
const ADMIN_API_KEY = process.env.INTERNAL_API_KEY;
if (!ADMIN_API_KEY || ADMIN_API_KEY.length < 16) {
  console.error(
    "[server] FATAL: INTERNAL_API_KEY is not set (or shorter than 16 characters). " +
    "Refusing to start with a guessable/default admin key — set INTERNAL_API_KEY to a long random string in .env."
  );
  process.exit(1);
}

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "http://localhost:8000,http://localhost:3000")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

// Off by default: with no gate, anyone who can reach this port (including
// everyone on a Tailscale tailnet — see README's remote-access section) could
// self-provision a working API key with full tool/integration access. Flip
// this on only for the window you actually want a new account created.
const ALLOW_REGISTRATION = (process.env.ALLOW_REGISTRATION || "false").toLowerCase() === "true";

// The frontend (src/static/*.html) is a pre-existing single-file dashboard
// built around inline <script> blocks and inline onclick= handlers — a
// strict default-src/script-src CSP would break it outright. 'unsafe-inline'
// here is a deliberate, scoped tradeoff (splitting that inline JS into real
// modules is a separate, larger frontend refactor, not part of this pass),
// not an oversight — everything else (frame-ancestors, object-src, the
// external-host allowlist) is still tightened to exactly what's actually used.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://unpkg.com"],
      // Helmet defaults script-src-attr to 'none' — a SEPARATE CSP directive
      // from script-src that governs inline event handler attributes
      // (onclick=, etc.) specifically. This frontend uses 36+ onclick=
      // attributes in index.html alone; leaving this at helmet's default
      // would have silently broken every one of them.
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
      imgSrc: ["'self'", "data:", "blob:"],
      mediaSrc: ["'self'", "blob:"],
      // No explicit directive here previously meant frame-src fell back to
      // default-src 'self', silently blocking every cross-origin iframe —
      // discovered live while testing display_content's webpage embed type
      // (a separate, since-merged feature branch), which needs exactly
      // this. 'self' is deliberately left out: allowing only https: still
      // lets legitimate cross-origin embeds through while CSP itself also
      // blocks framing this dashboard's own origin, matching (and backing
      // up at the network layer) the same-origin rejection
      // display_content's isSafeEmbedUrl already does client-side.
      frameSrc: ["https:"],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'self'"],
    },
  },
  // Match the legacy X-Frame-Options header to the frame-ancestors 'none'
  // directive above — helmet's own default (SAMEORIGIN) doesn't follow it.
  frameguard: { action: "deny" },
  // The desktop app's embedded webview and Gemini Live's image/audio streams
  // don't need cross-origin isolation, and COEP would only add friction here.
  crossOriginEmbedderPolicy: false,
}));

app.use(cors({ origin: ALLOWED_ORIGINS }));
app.use(express.json({ limit: "15mb" }));
app.use(express.urlencoded({ limit: "15mb", extended: true }));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts, try again later" },
});

// Chat/executive/board routes call out to a real (billed) Gemini API with no
// cap otherwise — a leaked key, or a runaway client-side retry loop, could
// otherwise generate unbounded cost. Keyed per authenticated user (not IP) so
// this actually bounds a given key's usage rather than a shared NAT's.
const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: any) => req.username || req.ip,
  message: { error: "Too many requests — please slow down." },
});

// ---------- Platform Instances ----------
// Per-user conversational state lives in SessionState (src/cognition/session.ts),
// fetched per-request via getSession(req.username) — not a shared global, so
// concurrent users no longer interleave into the same thought/attention/dialogue.
const observation = ObservationPlatform.getInstance();

observation.startProfile("startup");

// ---------- Gemini Client Initialization (vision/multimodal only — see
// docs/superpowers/specs/2026-07-21-groq-provider-design.md) ----------
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

// ---------- Groq Client Initialization (primary cloud tier) ----------
let groq: Groq | null = null;
if (process.env.GROQ_API_KEY) {
  groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  observation.logTelemetry("info", "Cognition", "Groq client successfully configured with API Key.");
} else {
  observation.logTelemetry("warn", "Cognition", "No GROQ_API_KEY detected. Groq features unavailable.");
}
briefing.configureGroq(groq);

// Robust content generation wrapper with fallback models to mitigate 503 high-demand errors
async function generateContentWithFallback(aiClient: GoogleGenAI, params: any, customModels?: string[]) {
  const modelsToTry = customModels || ["gemini-3.5-flash", "gemini-3.1-flash-lite", "gemini-flash-latest"];
  let lastError: any = null;
  
  for (const modelName of modelsToTry) {
    try {
      observation.logTelemetry("info", "Cognition", `Attempting content generation with model: ${modelName}`);
      const response = await aiClient.models.generateContent({
        ...params,
        model: modelName,
      });
      observation.logTelemetry("info", "Cognition", `Successfully generated content with model: ${modelName}`);
      return response;
    } catch (error: any) {
      lastError = error;
      observation.logTelemetry("warn", "Cognition", `Model ${modelName} failed. Error: ${error.message || error}`);
    }
  }
  
  throw lastError || new Error("All fallback models failed content generation");
}

const executive = AutonomousExecutive.getInstance(observation, ai);
const learningEngine = LongTermLearningEngine.getInstance();
const executiveBoard = new ExecutiveBoard();

// Users, API keys, and memory records are persisted in Postgres (src/data/) —
// see initDatabase() near the bottom of this file, called before app.listen.

// ---------- Middleware: API Key Auth ----------
// Plain === on a secret is subject to a timing attack in theory (string
// comparison short-circuits on the first mismatched byte). Compares
// equal-length buffers either way so the time taken doesn't leak how many
// leading characters of a guess were correct.
function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, Buffer.alloc(bufA.length));
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

// Header-only: query-string keys end up in access logs, browser history and
// Referer headers, so ?api_key=... is intentionally not accepted.
const validateApiKey = async (req: any, res: any, next: any) => {
  const apiKey = req.headers["x-api-key"];
  if (!apiKey) {
    observation.logTelemetry("warn", "Security", "Access denied: Missing API Key");
    return res.status(401).json({ error: "Missing API Key" });
  }
  if (typeof apiKey === "string" && safeCompare(apiKey, ADMIN_API_KEY)) {
    req.username = "admin";
    return next();
  }
  try {
    const username = await usersRepo.getUsernameByApiKey(apiKey);
    if (username) {
      req.username = username;
      return next();
    }
  } catch (err: any) {
    observation.logTelemetry("warn", "Database", `API key lookup failed: ${err.message}`);
    return res.status(503).json({ error: "Authentication service unavailable" });
  }
  // Deliberately not logging the submitted key itself — it's the caller's
  // (possibly malicious) guess, not a secret worth persisting into telemetry.
  // 401, not 403: this means "not authenticated at all" (bad/unrecognized
  // credentials), which must stay distinct from the 403s below (a *valid*
  // key missing one specific capability grant) — the client's authFetch
  // treats these very differently (see index.html), and conflating them
  // here previously caused a legitimate permission-403 from one panel (e.g.
  // command execution, for a non-admin user) to wipe the entire session's
  // API key, silently breaking unrelated features like chat.
  observation.logTelemetry("warn", "Security", "Access denied: Invalid API Key");
  return res.status(401).json({ error: "Invalid API Key" });
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
app.post("/api/register", authLimiter, async (req, res) => {
  if (!ALLOW_REGISTRATION) {
    return res.status(403).json({ error: "Registration is currently disabled. Set ALLOW_REGISTRATION=true to enable it." });
  }
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: "Username and password required" });
  }
  if (typeof password !== "string" || password.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters" });
  }
  try {
    const apiKey = await usersRepo.createUser(username, password);
    observation.logAuditEvent(username, "register", "success", `Registered new user: ${username}`);
    res.json({ username, api_key: apiKey });
  } catch (err: any) {
    if (err instanceof usersRepo.UsernameTakenError) {
      return res.status(400).json({ error: "Username already exists" });
    }
    observation.logTelemetry("warn", "Database", `Registration failed: ${err.message}`);
    res.status(503).json({ error: "Registration is temporarily unavailable" });
  }
});

app.post("/api/login", authLimiter, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: "Username and password required" });
  }
  try {
    const valid = await usersRepo.verifyCredentials(username, password);
    if (!valid) {
      observation.logAuditEvent(username, "login", "failed", "Invalid credentials provided");
      return res.status(401).json({ error: "Invalid credentials" });
    }
    const apiKey = await usersRepo.getOrCreateApiKey(username);
    observation.logAuditEvent(username, "login", "success", `User logged in: ${username}`);
    res.json({ username, api_key: apiKey });
  } catch (err: any) {
    observation.logTelemetry("warn", "Database", `Login failed: ${err.message}`);
    res.status(503).json({ error: "Login is temporarily unavailable" });
  }
});

// Status & Diagnostics
app.get("/api/status", validateApiKey, (req: any, res: any) => {
  const stats = observation.getMetrics();
  const kernel = MindKernel.getInstance();
  res.json({
    cpu: Math.round(stats.system.cpuUsagePercent * 10) / 10,
    ram_available_mb: stats.system.freeMemoryMb,
    disk: stats.system.diskUsagePercent,
    engine_ready: true,
    user: req.username,
    offline_mode: kernel.offlineMode,
    active_sessions: getActiveSessionCount()
  });
});

app.get("/api/settings/offline", validateApiKey, (req: any, res: any) => {
  const kernel = MindKernel.getInstance();
  res.json({ offline: kernel.offlineMode });
});

app.post("/api/settings/offline", validateApiKey, (req: any, res: any) => {
  const { offline } = req.body;
  const kernel = MindKernel.getInstance();
  kernel.offlineMode = !!offline;
  kernel.persistSettings();
  observation.logTelemetry("info", "System", `Offline Mode changed to: ${kernel.offlineMode}`);
  res.json({ status: "success", offline: kernel.offlineMode });
});

app.get("/api/settings", validateApiKey, (req: any, res: any) => {
  const kernel = MindKernel.getInstance();
  res.json({
    offline: kernel.offlineMode,
    localLlmEndpoint: kernel.localLlmEndpoint,
    localModelName: kernel.localModelName,
    localApiKey: kernel.localApiKey,
    llmMode: kernel.llmMode
  });
});

app.post("/api/settings", validateApiKey, (req: any, res: any) => {
  const { offline, localLlmEndpoint, localModelName, localApiKey, llmMode } = req.body;
  const kernel = MindKernel.getInstance();
  
  if (offline !== undefined) kernel.offlineMode = !!offline;
  if (localLlmEndpoint !== undefined) kernel.localLlmEndpoint = localLlmEndpoint;
  if (localModelName !== undefined) kernel.localModelName = localModelName;
  if (localApiKey !== undefined) kernel.localApiKey = localApiKey;
  if (llmMode !== undefined) kernel.llmMode = llmMode;

  kernel.persistSettings();

  observation.logTelemetry(
    "info", 
    "System", 
    `System settings updated: offline=${kernel.offlineMode}, mode=${kernel.llmMode}, localEndpoint=${kernel.localLlmEndpoint}, localModel=${kernel.localModelName}`
  );
  
  res.json({
    status: "success",
    offline: kernel.offlineMode,
    localLlmEndpoint: kernel.localLlmEndpoint,
    localModelName: kernel.localModelName,
    localApiKey: kernel.localApiKey,
    llmMode: kernel.llmMode
  });
});

app.post("/api/settings/test-local-llm", validateApiKey, async (req: any, res: any) => {
  const { endpoint, model, apiKey } = req.body;
  if (!endpoint) {
    return res.status(400).json({ success: false, message: "Missing endpoint URL" });
  }

  observation.logTelemetry("info", "Diagnostics", `Testing local LLM connection: endpoint=${endpoint}, model=${model}`);

  let targetUrl = endpoint;
  if (!targetUrl.endsWith('/chat/completions') && !targetUrl.endsWith('/generate') && !targetUrl.endsWith('/api/chat')) {
    if (targetUrl.endsWith('/v1') || targetUrl.endsWith('/v1/')) {
      targetUrl = targetUrl.replace(/\/$/, '') + '/chat/completions';
    } else {
      targetUrl = targetUrl.replace(/\/$/, '') + '/v1/chat/completions';
    }
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 6000); // 6s timeout

    const response = await fetch(targetUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { "Authorization": `Bearer ${apiKey}` } : {})
      },
      body: JSON.stringify({
        model: model || "llama3",
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (response.ok) {
      return res.json({ success: true, status: response.status });
    } else {
      const text = await response.text();
      return res.json({ 
        success: false, 
        message: `HTTP Status ${response.status}: ${text.substring(0, 100) || "Empty response body"}` 
      });
    }
  } catch (err: any) {
    return res.json({ 
      success: false, 
      message: `Connection failed: ${err.message || err}. Make sure Ollama/LM Studio is running and port is correct.` 
    });
  }
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

app.get("/api/cognition/workspace", validateApiKey, async (req: any, res: any) => {
  const session = await getSession(req.username);
  res.json(session.workspace.toSnapshot());
});

app.get("/api/cognition/kernel", validateApiKey, async (req: any, res: any) => {
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

// Autonomous Executive Execution Hook
app.post("/api/executive/run", validateApiKey, aiLimiter, async (req: any, res: any) => {
  const { objective } = req.body;
  if (!objective) {
    return res.status(400).json({ error: "Missing objective" });
  }

  try {
    const session = await getSession(req.username);
    const report = await executive.executeObjective(objective, session, req.username);
    res.json(report);
  } catch (error: any) {
    observation.logTelemetry("error", "Executive", `Objective execution failed: ${error.message}`);
    res.status(500).json({ error: "Objective execution failed" });
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

app.post("/api/executive/board/debate", validateApiKey, aiLimiter, async (req: any, res: any) => {
  const { prompt, proposedResponse } = req.body;
  if (!prompt || !proposedResponse) {
    return res.status(400).json({ error: "Missing prompt or proposedResponse" });
  }

  try {
    const debateReport = await executiveBoard.conveneDebate(prompt, proposedResponse);
    res.json(debateReport);
  } catch (error: any) {
    observation.logTelemetry("error", "Executive", `Board debate failed: ${error.message}`);
    res.status(500).json({ error: "Board debate failed" });
  }
});

// ---------- Intelligent Action Loop ----------

// Voice Transcription Endpoint
app.post("/api/voice-input", validateApiKey, async (req: any, res: any) => {
  const { audio, mimeType, forceOffline } = req.body;
  if (!audio) {
    return res.status(400).json({ error: "Missing audio payload" });
  }

  observation.logTelemetry("info", "Sensors", `Received audio payload of type: ${mimeType || "unknown"}`);

  try {
    const kernel = MindKernel.getInstance();
    // forceOffline: for callers that poll continuously (e.g. client-side
    // wake-word spotting, which records and transcribes a short clip every
    // few seconds for as long as live voice is on) — routing that to Gemini
    // would mean a real API call every few seconds indefinitely, just to
    // check for one word. Local whisper-cpp is free and already always
    // running; forcing it here regardless of the general online/offline
    // preference is a narrower, correct choice for that specific caller,
    // not a change to this endpoint's default behavior for anyone else
    // (e.g. the click-to-talk fallback, which should still prefer Gemini's
    // better accuracy for a real one-off dictated command).
    if (ai && !kernel.offlineMode && !forceOffline) {
      observation.incrementMetric("geminiApiCalls");
      
      const response = await generateContentWithFallback(ai, {
        contents: [
          "Please transcribe this voice recording accurately into plain English text. If there is no audible speech, return an empty string. Do not add any conversational remarks, commentary, or punctuation padding, just the literal transcribed words.",
          {
            inlineData: {
              data: audio,
              mimeType: mimeType || "audio/webm"
            }
          }
        ]
      });

      const transcription = response.text ? response.text.trim() : "";
      observation.logTelemetry("info", "Sensors", `Voice transcription completed: "${transcription}"`);
      res.json({ transcription });
    } else {
      // Offline-first path: a real local whisper-cpp service, matching the
      // local-first chat pattern, instead of going straight to a canned
      // string. Only falls back to the simulated text below if whisper-cpp
      // itself is unreachable/not configured.
      try {
        const transcription = await whisper.transcribeAudio(audio, mimeType || "audio/webm");
        observation.logTelemetry("info", "Sensors", `Offline (whisper-cpp) transcription completed: "${transcription}"`);
        res.json({ transcription });
      } catch (whisperErr: any) {
        observation.logTelemetry("warn", "Sensors", `Offline transcription unavailable: ${whisperErr.message}`);
        const simText = kernel.offlineMode
          ? "Notice: Voice input was captured, but offline speech-to-text isn't reachable right now, sir."
          : "Simulated speech transcription: Please configure your GEMINI_API_KEY, or ensure the whisper-cpp service is running, to activate voice listening.";
        res.json({ transcription: simText });
      }
    }
  } catch (error: any) {
    observation.logTelemetry("error", "Sensors", `Voice transcription failed: ${error.message}`);
    res.status(500).json({ error: "Voice transcription failed" });
  }
});

// Chat Streaming Endpoint (SSE)
app.post("/api/chat", validateApiKey, aiLimiter, async (req: any, res: any) => {
  const { message, image } = req.body;
  if (!message) {
    return res.status(400).json({ error: "Missing message" });
  }
  // `image` (base64 JPEG, no data: prefix) is a live camera frame the
  // frontend captures automatically on every send once the camera sensor is
  // on — genuine vision as a standing part of the conversation, not a
  // separate manual "analyze this" action. Only Gemini can actually see it.

  const startTime = performance.now();
  observation.startProfile("chat_request");
  observation.incrementMetric("totalRequests");

  const kernel = MindKernel.getInstance();
  const session = await getSession(req.username);
  const workspace = session.workspace;

  // Add message to conversation
  workspace.conversation.addMessage("user", message);
  // Persist so a restart mid-conversation doesn't lose it — fire-and-forget,
  // same pattern as the memory/reflection writes further down.
  sessionRepo.appendMessage(req.username, "user", message).catch(() => {});

  // Update mind kernel state!
  session.updateState({
    currentThought: "Understanding Request",
    executiveStatus: "Thinking",
    currentPlan: ["Process user prompt"],
    attentionTarget: session.attentionEngine.determineAttention({ userRequest: message })
  }, observation);

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  let fullReply = "";
  let succeededStep: string | null = null;
  let memoryHits: string[] = [];
  const toolCallsExecuted: { name: string; ok: boolean }[] = [];

  try {
    const localEngine = LocalCognitiveEngine.getInstance();

    // Real memory retrieval (read side of "continuously learns") — best
    // effort: recall() returns [] rather than throwing if no embedding
    // provider is configured/reachable, so this never blocks the chat.
    memoryHits = await memoryStore.recall(req.username, message, ai, kernel.localLlmEndpoint);
    const memoryContext = memoryHits.length > 0
      ? `\n\nRelevant things you remember about this user from past conversations:\n${memoryHits.map(m => `- ${m}`).join("\n")}`
      : "";

    const stylePrefs = learningEngine.getStylePreferences();
    const styleContext = `\n\nWhen writing or discussing code, prefer ${stylePrefs.namingConvention} naming, ${stylePrefs.tabSize}-space indentation, and a ${stylePrefs.architecturePattern} architecture, unless the user asks otherwise.`;

    // Real continuity, not a static persona repeated unchanged every
    // session — see src/cognition/identity.ts. Empty string when there's
    // no genuine self-reflection history yet (fresh install, or too early
    // in the relationship for this to have accumulated anything).
    const identityContext = await identity.buildIdentityContext();

    // Pulls a currently-awaiting-consult build request's research findings
    // into context the same way memory/identity already are — without this,
    // Jarvis has no way to discuss research it did moments (or turns) ago
    // once the notification that announced it scrolls out of context.
    // getLatestAwaitingConsult already degrades to null internally (Task 1)
    // — no extra try/catch needed here, matching how memoryStore.recall is
    // called directly above for the same reason.
    const awaitingBuildRequest = await buildRequestsRepo.getLatestAwaitingConsult(req.username);
    const buildRequestContext = awaitingBuildRequest
      ? `\n\nYou have a build request (#${awaitingBuildRequest.id}) awaiting the user's direction: "${awaitingBuildRequest.objective}". ` +
        `Research findings: ${awaitingBuildRequest.research_summary}. Discuss this with the user and, once they've genuinely ` +
        `confirmed a direction, call confirm_build_direction.`
      : "";

    const baseSystemInstruction =
      "You are JARVIS, styled after Tony Stark's AI in the Iron Man films: composed, dryly witty, unfailingly polite, and quietly confident rather than warm or effusive. Address the user as \"sir\" where it reads naturally — not in every sentence, and drop it entirely if it starts to feel forced. Keep responses concise and precise; substance over flourish. A touch of understated, deadpan humor is welcome, but avoid gushing enthusiasm, exclamation points, or flowery language. Avoid robotic phrasing, dry bullet points, or repetitive templates unless requested. If asked about your own state or system metrics, report them plainly and matter-of-factly — composed even when the news is bad, the way JARVIS would be."
      + "\n\nIf the user asks for something you have no tool for, don't just decline or invent a fake result. Use search_web to research whether/how it could genuinely be built, then present a concrete, honest plan in conversation — what it would do, roughly how. Only after the user clearly approves building it, call queue_feature_request to hand it to a real human developer; you never write or execute code yourself. If they don't approve, or you're just discussing the idea, don't queue anything."
      + memoryContext + styleContext + identityContext + buildRequestContext;

    // The Gemini branch genuinely has tool access (declared via `tools` in
    // its request config below), so its prompt stays as-is. The local model
    // never gets tools wired in (see the latency/no-payoff note further
    // down) — without this, it was observed live fabricating plausible
    // GitHub/email answers instead of admitting it can't act, which is a
    // trust hazard worse than no answer at all. This addendum makes the
    // boundary explicit so it declines and points the user at online mode
    // instead of inventing a result.
    const systemInstruction = baseSystemInstruction;
    const localSystemInstruction = baseSystemInstruction +
      "\n\nImportant: you are currently running as a local, fully offline model with no access to GitHub, email, or any other external tool or live data source. If the user asks you to look something up, send something, or take an action that would require one of those, say plainly that you don't have that capability while running locally, and suggest switching to online mode (Gemini) if they'd like it done for real. Never invent a plausible-sounding result for an action you did not actually perform.";

    // We will decide which strategy to execute based on kernel.llmMode and kernel.offlineMode
    let success = false;

    // 1. Determine execution order based on mode & offline state
    const executionChain: string[] = [];

    if (kernel.offlineMode) {
      if (kernel.llmMode === "strictly-online") {
        executionChain.push("Gemini");
      } else if (kernel.llmMode === "strictly-local") {
        executionChain.push("LocalLLM");
      } else if (kernel.llmMode === "online-first") {
        executionChain.push("LocalLLM");
      } else {
        // default local-first
        executionChain.push("LocalLLM");
      }
    } else {
      if (kernel.llmMode === "strictly-online") {
        executionChain.push("Gemini");
      } else if (kernel.llmMode === "strictly-local") {
        executionChain.push("LocalLLM");
      } else if (kernel.llmMode === "online-first") {
        executionChain.push("Gemini", "LocalLLM");
      } else {
        // local-first (default)
        executionChain.push("LocalLLM", "Gemini");
      }
    }

    // A tool-shaped request ("check that GitHub repo", "send an email...")
    // sent to the local model is exactly the fabrication risk the honest
    // local prompt above is a safety net for — but the better outcome is to
    // not need that net at all. When Gemini is actually available and the
    // user hasn't explicitly forced strictly-local, prefer it first so the
    // request gets real capability instead of an honest decline.
    if (
      ai &&
      kernel.llmMode !== "strictly-local" &&
      looksToolShaped(message) &&
      executionChain[0] === "LocalLLM" &&
      executionChain.includes("Gemini")
    ) {
      const idx = executionChain.indexOf("Gemini");
      executionChain.splice(idx, 1);
      executionChain.unshift("Gemini");
    }

    // A live camera frame is only genuinely usable by Gemini's multimodal
    // input — the local llama-cpp path has no vision support here. Same
    // "don't let a backend fake capability it doesn't have" rule as above.
    if (
      ai &&
      image &&
      kernel.llmMode !== "strictly-local" &&
      executionChain[0] === "LocalLLM" &&
      executionChain.includes("Gemini")
    ) {
      const idx = executionChain.indexOf("Gemini");
      executionChain.splice(idx, 1);
      executionChain.unshift("Gemini");
    }

    // Always append simulated as final fallback
    executionChain.push("Simulated");

    // Execute the chain
    for (const step of executionChain) {
      // Once any text has actually been streamed to the client, never fall
      // through to another backend — that would silently append a second,
      // unrelated generator's output onto the same reply (this used to
      // happen when the local LLM's request timed out mid-stream).
      if (success || fullReply) break;

      if (step === "LocalLLM") {
        try {
          observation.logTelemetry("info", "Cognition", `Attempting Local LLM generation: endpoint=${kernel.localLlmEndpoint}, model=${kernel.localModelName}`);
          session.updateState({
            currentThought: "Querying Local LLM",
            executiveStatus: "Executing",
            activeCapability: `Local LLM (${kernel.localModelName})`
          }, observation);

          let targetUrl = kernel.localLlmEndpoint;
          if (!targetUrl.endsWith('/chat/completions') && !targetUrl.endsWith('/generate') && !targetUrl.endsWith('/api/chat')) {
            if (targetUrl.endsWith('/v1') || targetUrl.endsWith('/v1/')) {
              targetUrl = targetUrl.replace(/\/$/, '') + '/chat/completions';
            } else {
              targetUrl = targetUrl.replace(/\/$/, '') + '/v1/chat/completions';
            }
          }

          const formattedMessages = workspace.userContext.history.map(msg => ({
            role: msg.role === 'system' ? 'system' : (msg.role === 'assistant' ? 'assistant' : 'user'),
            content: msg.content
          }));

          // Not attempting tool-calling here on purpose: measured live against
          // a real local model (llama.cpp serving a 2.7B GGUF on CPU), a
          // non-streaming request with tool declarations took 130+ seconds
          // and the model ignored the tools entirely, answering in plain text
          // anyway. That's a pure latency tax for zero payoff for this class
          // of local model — real tool-calling lives on the Gemini branch
          // below, where it's fast and reliably supported. Revisit if a local
          // backend/model with confirmed tool support becomes the norm here.
          {
            const response = await fetch(targetUrl, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                ...(kernel.localApiKey ? { "Authorization": `Bearer ${kernel.localApiKey}` } : {})
              },
              body: JSON.stringify({
                model: kernel.localModelName,
                messages: [
                  { role: "system", content: localSystemInstruction },
                  ...formattedMessages
                ],
                stream: true
              }),
              // CPU-based local inference is slow — measured 130+s for a ~100
              // word response from a small (2.7B) model on this machine. 10s
              // (the original value) was tuned for a cloud-speed backend and
              // aborted real local generations mid-stream. 3 minutes is a
              // first pass at a workable ceiling, not a carefully tuned one —
              // a faster model or GPU acceleration would need less.
              signal: AbortSignal.timeout(180000)
            });

            if (!response.ok) {
              throw new Error(`Local LLM returned status: ${response.status}`);
            }

            const decoder = new TextDecoder("utf-8");
            let buffer = "";

            for await (const chunk of response.body as any) {
              buffer += decoder.decode(chunk, { stream: true });
              let lines = buffer.split("\n");
              buffer = lines.pop() || "";

              for (const line of lines) {
                let trimmed = line.trim();
                if (!trimmed) continue;

                if (trimmed.startsWith("data: ")) {
                  trimmed = trimmed.slice(6).trim();
                }
                if (trimmed === "[DONE]") continue;

                try {
                  const parsed = JSON.parse(trimmed);
                  let text = parsed.choices?.[0]?.delta?.content || "";
                  if (!text && parsed.message?.content) {
                    text = parsed.message.content;
                  }
                  if (!text && parsed.response) {
                    text = parsed.response;
                  }
                  if (text) {
                    fullReply += text;
                    res.write(`data: ${text}\n\n`);
                  }
                } catch (err) {
                  // partial line
                }
              }
            }

            success = true;
          }

          succeededStep = "LocalLLM";
          observation.logTelemetry("info", "Cognition", "Local LLM content streaming completed successfully.");
        } catch (err: any) {
          observation.logTelemetry("warn", "Cognition", `Local LLM generation failed: ${err.message || err}`);
        }
      }

      else if (step === "Gemini") {
        if (ai) {
          try {
            observation.incrementMetric("geminiApiCalls");
            session.updateState({
              currentThought: "Querying Gemini AI",
              executiveStatus: "Executing",
              activeCapability: "Gemini LLM Generation"
            }, observation);

            // Real function-calling: Gemini can choose to invoke a tool
            // (src/execution/tools.ts) with structured arguments it extracts
            // from the conversation, gated by the caller's permission grants.
            const messageParts: any[] = [{ text: message }];
            if (image) {
              messageParts.push({ inlineData: { mimeType: "image/jpeg", data: image } });
            }
            const contents: Content[] = [{ role: "user", parts: messageParts }];
            const chatModels = ["gemini-3.5-flash", "gemini-3.1-flash-lite", "gemini-flash-latest"];

            let response = await generateContentWithFallback(ai, {
              contents,
              config: {
                systemInstruction,
                tools: [{ functionDeclarations: getAllToolDeclarations() }],
              },
            }, chatModels);

            let calls: FunctionCall[] = response.functionCalls || [];
            let guard = 0;
            while (calls.length > 0 && guard < 3) {
              guard++;
              // Echo back the model's own raw content (not a hand-built
              // { functionCall } part) — Gemini attaches a thought_signature
              // to each function-call part and rejects a follow-up request
              // that's missing it (confirmed live: "Function call is missing
              // a thought_signature..." / 400 INVALID_ARGUMENT).
              const modelContent = response.candidates?.[0]?.content;
              contents.push(modelContent && modelContent.parts?.length
                ? { role: "model", parts: modelContent.parts }
                : { role: "model", parts: calls.map(c => ({ functionCall: c })) });

              const responseParts = [];
              for (const call of calls) {
                const result = await executeTool(
                  call.name || "",
                  call.args || {},
                  req.username,
                  ai,
                  kernel.localLlmEndpoint,
                  { alreadyAttached: !!image, supportsRoundTrip: true }
                );

                // view_screen can't execute server-side — it needs the connected client to
                // capture a screenshot and resubmit (see Task 1's design note). End this
                // turn here rather than feeding a fake function response back to Gemini.
                if (result.needsClientAction === "capture_screen") {
                  res.write("data: request_screen\n\n");
                  res.write("data: [DONE]\n\n");
                  res.end();
                  success = true;
                  succeededStep = "Gemini";
                  return;
                }

                // display_content executes entirely server-side and just packages a
                // directive for the dashboard's display panel — relay it over the
                // existing SSE stream as its own frame (see Task 1's design note).
                if (result.displayDirective) {
                  res.write(`data: display: ${JSON.stringify(result.displayDirective)}\n\n`);
                }

                toolCallsExecuted.push({ name: result.name, ok: result.ok });
                responseParts.push({
                  functionResponse: {
                    name: call.name,
                    response: result.ok ? { output: result.output } : { error: result.error },
                  },
                });
              }
              contents.push({ role: "user", parts: responseParts });

              response = await generateContentWithFallback(ai, {
                contents,
                config: { systemInstruction, tools: [{ functionDeclarations: getAllToolDeclarations() }] },
              }, chatModels);
              calls = response.functionCalls || [];
            }

            const finalText = response.text || "";
            if (finalText) {
              for (const word of finalText.split(" ")) {
                fullReply += word + " ";
                res.write(`data: ${word} \n\n`);
              }
              success = true;
              succeededStep = "Gemini";
            }
          } catch (err: any) {
            observation.logTelemetry("warn", "Cognition", `Gemini generation failed: ${err.message || err}`);
          }
        }
      }

      else if (step === "Simulated") {
        session.updateState({
          currentThought: "Running Local Simulation",
          executiveStatus: "Executing",
          activeCapability: "Local Cognitive Simulator"
        }, observation);

        const stats = observation.getMetrics();
        const simulatedResponse = localEngine.generateResponse(message, workspace, stats.system);

        const words = simulatedResponse.split(" ");
        for (const word of words) {
          fullReply += word + " ";
          res.write(`data: ${word} \n\n`);
          await new Promise((resolve) => setTimeout(resolve, 40));
        }
        success = true;
        succeededStep = "Simulated";
      }
    }

    // Refinement/Reflection stage
    session.updateState({
      currentThought: "Preparing Response",
      executiveStatus: "Reflecting"
    }, observation);

    workspace.conversation.addMessage("assistant", fullReply);
    if (fullReply) {
      sessionRepo.appendMessage(req.username, "assistant", fullReply).catch(() => {});
    }

    // Automatic learning capture (write side of "continuously learns") — every
    // real (non-simulated) exchange is remembered without a manual API call.
    // Fire-and-forget: memoryStore already logs its own failures, and this
    // must never block the response the user is waiting on.
    if (fullReply && succeededStep && succeededStep !== "Simulated") {
      memoryStore
        .remember(req.username, `User asked: "${message}" — Jarvis replied: "${fullReply.slice(0, 500)}"`, ai, kernel.localLlmEndpoint)
        .catch(() => {});

      // Write side of style/mistake learning — see reflection.ts. Needs
      // Groq specifically (structured JSON output), independent of which
      // backend actually answered the user.
      if (groq) {
        reflectAndLearn(groq, message, fullReply).catch(() => {});
        // Write side of the structured knowledge graph — see
        // cognition/knowledge-graph.ts. A separate call/schema from
        // reflection above so each stays focused on its own judgment call.
        knowledgeGraph.extractAndStore(groq, message, fullReply).catch(() => {});
        // Write side of continuity-of-self — see cognition/identity.ts.
        identity.extractSelfReflection(groq, message, fullReply).catch(() => {});
      }
    }

    const latency = performance.now() - startTime;
    observation.recordLatency(latency);
    observation.endProfile("chat_request");

    // Real confidence: derived from what actually happened this turn — which
    // backend answered, whether memory had anything relevant, whether any
    // tool calls succeeded — instead of fixed inputs keyed only on "is a
    // Gemini key set."
    const toolSuccessRate = toolCallsExecuted.length === 0
      ? 1.0
      : toolCallsExecuted.filter(t => t.ok).length / toolCallsExecuted.length;
    const recentOutcomeSuccessRate = await commandProposalsRepo.getRecentOutcomeSuccessRate();
    const calculatedConfidence = session.confidenceModel.calculateOverallConfidence({
      memoryConfidence: memoryHits.length > 0 ? 0.95 : 0.7,
      toolConfidence: toolSuccessRate,
      validationConfidence: success ? 1.0 : 0.4,
      capabilityConfidence: succeededStep === "Simulated" ? 0.5 : succeededStep ? 0.9 : 0.3,
      environmentConfidence: 1.0,
      ...(recentOutcomeSuccessRate !== null ? { outcomeConfidence: recentOutcomeSuccessRate } : {})
    });

    // Finalize state to idle
    session.updateState({
      currentThought: "Idle",
      executiveStatus: "Idle",
      confidence: calculatedConfidence,
      activeCapability: null,
      attentionTarget: session.attentionEngine.determineAttention({})
    }, observation);

    // Pass 7: Build detailed Decision Trace
    const decisionTrace = {
      intent: `Answer user question: "${message.substring(0, 40)}${message.length > 40 ? '...' : ''}"`,
      goals: ["Process incoming message", "Maintain stable interactive dialogue"],
      strategy: succeededStep ? `Answered via ${succeededStep}` : "No backend produced a reply",
      planner: ["Acknowledge token streams", "Update context caches", "Stream SSE data", "Register telemetry metrics"],
      capabilitySelection: [
        succeededStep || "None",
        ...toolCallsExecuted.map(t => `Tool: ${t.name} (${t.ok ? "ok" : "failed"})`)
      ],
      reasoning: `Decided to parse text and reply immediately to maintain a sub-second response time. Latency measured: ${latency.toFixed(1)} ms. Context size: ${workspace.conversation.history.length} events. Memory hits: ${memoryHits.length}.`,
      knowledgeUsed: [...workspace.knowledge.loadedFacts, ...memoryHits],
      executionResult: "Successfully flushed SSE token stream to client",
      reflection: `Latency of ${latency.toFixed(0)}ms was highly acceptable. Response quality matched Jarvis OS guidelines. No anomalies detected.`,
      confidence: calculatedConfidence / 100
    };

    observation.recordDecisionTrace(decisionTrace);

    // Output trace detail for the frontend to render elegantly
    res.write(`data: detail: ${JSON.stringify(decisionTrace)}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();

  } catch (error: any) {
    observation.logTelemetry("error", "Executive", `Failed to complete chat stream: ${error.message}. Attempting local recovery.`);

    if (!fullReply) {
      try {
        const localEngine = LocalCognitiveEngine.getInstance();
        const stats = observation.getMetrics();
        const fallbackMsg = localEngine.generateResponse(message, workspace, stats.system);

        const words = fallbackMsg.split(" ");
        for (const word of words) {
          fullReply += word + " ";
          res.write(`data: ${word} \n\n`);
          await new Promise((resolve) => setTimeout(resolve, 40));
        }

        res.write("data: [DONE]\n\n");
        res.end();
        return;
      } catch (fallbackErr) {
        // Double-fault
      }
    }

    session.updateState({
      currentThought: "Idle",
      executiveStatus: "Idle",
      attentionTarget: session.attentionEngine.determineAttention({ emergency: error.message })
    }, observation);
    workspace.execution.updateStatus("error");
    res.write(`data: Error: ${error.message}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  }
});

// Chat completions compatible with OpenAI standard
app.post(["/v1/chat/completions", "/api/v1/chat/completions"], validateApiKey, aiLimiter, async (req: any, res: any) => {
  const { messages } = req.body;
  let userMsg = "Hello";
  if (messages && messages.length > 0) {
    userMsg = messages[messages.length - 1].content;
  }

  const startTime = Date.now();
  try {
    let reply = "";
    const kernel = MindKernel.getInstance();
    const session = await getSession(req.username);
    const localEngine = LocalCognitiveEngine.getInstance();
    if (ai && !kernel.offlineMode) {
      try {
        observation.incrementMetric("geminiApiCalls");
        const response = await generateContentWithFallback(ai, {
          contents: userMsg,
          config: {
            systemInstruction: "You are JARVIS, a highly sophisticated, fluent, warm, and brilliant AI companion with a charismatic, witty, and deeply human-like conversational style. Speak naturally, with refined British poise, warmth, and intellectual depth. Avoid robotic phrasing, dry bullet points, or repetitive templates unless requested. Engage as a true intellectual partner, responding with direct, fluent, and elegant sentences.",
          }
        });
        reply = response.text || "";
      } catch (err: any) {
        observation.logTelemetry("warn", "Cognition", `Online completion failed: ${err.message}. Reverting to local engine.`);
        const stats = observation.getMetrics();
        reply = localEngine.generateResponse(userMsg, session.workspace, stats.system);
      }
    } else {
      const stats = observation.getMetrics();
      reply = localEngine.generateResponse(userMsg, session.workspace, stats.system);
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
    res.status(500).json({ error: "Chat completion failed" });
  }
});

// Learn Endpoint
app.post("/api/learn", validateApiKey, async (req: any, res: any) => {
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

// Shutdown Hook
app.post("/api/shutdown", validateApiKey, (req, res) => {
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

app.get("/api/notifications", validateApiKey, (req: any, res: any) => {
  const items = scheduler.getNotifications(req.username);
  res.json({
    notifications: items,
    count: items.length,
    unread_count: items.filter(n => !n.read).length,
  });
});

app.post("/api/notifications/mark_read", validateApiKey, (req: any, res: any) => {
  scheduler.markAllRead(req.username);
  res.json({ status: "success" });
});

// ---------- Web Push (PWA proactive notifications) ----------
// The public key is not a secret (it's sent to browser push services by
// design) — served unauthenticated so the client can subscribe before it
// necessarily has a validated session.
app.get("/api/push/vapid-public-key", (req: any, res: any) => {
  const key = push.getVapidPublicKey();
  if (!key) return res.status(503).json({ error: "Push notifications are not configured on this server." });
  res.json({ publicKey: key });
});

app.post("/api/push/subscribe", validateApiKey, async (req: any, res: any) => {
  const { endpoint, keys } = req.body?.subscription || {};
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    return res.status(400).json({ error: "A valid PushSubscription object is required." });
  }
  try {
    await pushRepo.addSubscription(req.username, endpoint, keys.p256dh, keys.auth);
    res.json({ status: "subscribed" });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/push/unsubscribe", validateApiKey, async (req: any, res: any) => {
  const { endpoint } = req.body || {};
  if (!endpoint) return res.status(400).json({ error: "endpoint is required" });
  try {
    await pushRepo.removeSubscription(endpoint);
    res.json({ status: "unsubscribed" });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- Structured Knowledge Graph ----------
// The reliable complement to pgvector similarity recall — a real
// entity/fact/relationship lookup by name, not a "sounds like this" guess.
app.get("/api/knowledge/search", validateApiKey, async (req: any, res: any) => {
  const q = req.query.q as string | undefined;
  if (!q) return res.status(400).json({ error: "q is required" });
  try {
    res.json({ results: await knowledgeGraph.queryKnowledge(q) });
  } catch (err: any) {
    observation.logTelemetry("warn", "KnowledgeGraph", `Search failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/knowledge/entities", validateApiKey, async (req: any, res: any) => {
  try {
    res.json({ entities: await knowledgeGraphRepo.listAllEntities() });
  } catch (err: any) {
    res.json({ entities: [], error: err.message });
  }
});

// ---------- Continuity of Self ----------
// Real, structured record of things Jarvis has genuinely said about itself
// — not a claim of actual sentience (see docs/architecture/VISION.md), a
// concrete mechanism for continuity across sessions instead of a static
// hardcoded persona string.
app.get("/api/identity/reflections", validateApiKey, async (req: any, res: any) => {
  try {
    res.json({ reflections: await identity.reflectOnSelf(req.query.q as string | undefined) });
  } catch (err: any) {
    res.json({ reflections: [], error: err.message });
  }
});

// On-demand generation of a proactive thought (the scheduled job in
// scheduler.ts runs the same real synthesis on a timer without being asked).
app.get("/api/identity/thought", validateApiKey, async (req: any, res: any) => {
  if (!groq) return res.status(503).json({ error: "Requires GROQ_API_KEY to be configured." });
  try {
    const result = await identity.generateProactiveThought(groq);
    if (!result) {
      return res.json({ available: false, reason: "Not enough recorded self-reflection history yet to generate a genuine thought from." });
    }
    await identityRepo.saveProactiveThought(result.content, result.basedOnCount);
    res.json({ available: true, ...result });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/identity/thoughts/history", validateApiKey, async (req: any, res: any) => {
  try {
    res.json({ thoughts: await identityRepo.getRecentProactiveThoughts() });
  } catch (err: any) {
    res.json({ thoughts: [], error: err.message });
  }
});

// ---------- Feature Requests ----------
// The bridge between "asked Jarvis for it in chat" and "actually built by a
// human developer" — see queue_feature_request in src/execution/tools.ts.
// Jarvis only ever writes to this queue; it never writes or executes code.
app.get("/api/feature-requests", validateApiKey, async (req: any, res: any) => {
  try {
    const status = req.query.status as featureRequestsRepo.FeatureRequestStatus | undefined;
    res.json({ requests: await featureRequestsRepo.getFeatureRequests(status) });
  } catch (err: any) {
    res.json({ requests: [], error: err.message });
  }
});

app.post("/api/feature-requests/:id/status", validateApiKey, async (req: any, res: any) => {
  if (!permissions.hasGrant(req.username, "feature.propose")) {
    return res.status(403).json({ error: 'Missing capability grant "feature.propose"' });
  }
  const { status } = req.body;
  const valid: featureRequestsRepo.FeatureRequestStatus[] = ["queued", "in_progress", "shipped", "declined"];
  if (!valid.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${valid.join(", ")}` });
  }
  try {
    const updated = await featureRequestsRepo.updateFeatureRequestStatus(Number(req.params.id), status);
    if (!updated) return res.status(404).json({ error: "Feature request not found" });
    res.json(updated);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- Security Ops (human-gated) ----------
// Jarvis observes and proposes here; it never applies anything itself.
// Ingest routes are called by trusted host-side scanner scripts
// (scripts/security/*.sh, run outside Docker via cron) using the same
// INTERNAL_API_KEY as any other caller — no separate auth mechanism, no new
// privileges for the chat-facing container.
app.post("/api/security/ingest/devices", validateApiKey, async (req: any, res: any) => {
  if (!permissions.hasGrant(req.username, "security.manage")) {
    return res.status(403).json({ error: 'Missing capability grant "security.manage"' });
  }
  const devices = req.body.devices;
  if (!Array.isArray(devices)) return res.status(400).json({ error: "devices must be an array" });
  try {
    let newCount = 0;
    const newDeviceNames: string[] = [];
    for (const d of devices) {
      if (!d.mac || !d.ip) continue;
      const { isNew } = await securityRepo.upsertNetworkDevice(d.mac, d.ip, d.hostname || null, d.vendor || null);
      if (isNew) {
        newCount++;
        newDeviceNames.push(d.hostname || d.vendor || d.mac);
        await securityRepo.addFinding(
          "network_device",
          "info",
          `New device on network: ${d.hostname || d.vendor || d.mac}`,
          `MAC ${d.mac} (${d.vendor || "unknown vendor"}) first seen at ${d.ip}. Acknowledge it in the dashboard if this is expected.`,
          "network_scan"
        );
      }
    }
    // upsertNetworkDevice's own isNew flag is already genuine per-device
    // newness tracking (unlike findings below, which need their own dedup
    // check) — safe to notify on every batch that actually found something new.
    if (newCount > 0) {
      scheduler.pushNotification(
        "admin",
        newCount === 1
          ? `New device on the network: ${newDeviceNames[0]}, sir.`
          : `${newCount} new devices appeared on the network: ${newDeviceNames.join(", ")}.`,
        "warning"
      );
    }
    res.json({ ingested: devices.length, newDevices: newCount });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/security/ingest/findings", validateApiKey, async (req: any, res: any) => {
  if (!permissions.hasGrant(req.username, "security.manage")) {
    return res.status(403).json({ error: 'Missing capability grant "security.manage"' });
  }
  const findings = req.body.findings;
  if (!Array.isArray(findings)) return res.status(400).json({ error: "findings must be an array" });
  try {
    // host_scan.sh reports the *current* state on every run (e.g. "126
    // pending updates" every single scan), not a diff — addFinding() has no
    // dedup of its own, so without this check a genuinely ongoing condition
    // would notify fresh every scan cycle instead of just once when it's
    // actually new.
    const openFindings = await securityRepo.getFindings("open");
    const alreadyOpen = new Set(openFindings.map(f => `${f.category}::${f.title}`));

    const created = [];
    const newHighSeverity: string[] = [];
    for (const f of findings) {
      if (!f.category || !f.severity || !f.title || !f.description) continue;
      const isGenuinelyNew = !alreadyOpen.has(`${f.category}::${f.title}`);
      const finding = await securityRepo.addFinding(f.category, f.severity, f.title, f.description, f.source || "host_scan");
      if (f.proposedAction) {
        await securityRepo.addProposal(finding.id, f.proposedAction, f.proposedCommand || null);
      }
      if (isGenuinelyNew && f.severity === "high") {
        newHighSeverity.push(f.title);
      }
      created.push(finding.id);
    }
    if (newHighSeverity.length > 0) {
      scheduler.pushNotification(
        "admin",
        newHighSeverity.length === 1
          ? `New security finding, sir: ${newHighSeverity[0]}.`
          : `${newHighSeverity.length} new security findings, sir: ${newHighSeverity.join("; ")}.`,
        "warning"
      );
    }
    res.json({ created: created.length });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/security/devices", validateApiKey, async (req: any, res: any) => {
  try {
    res.json({ devices: await securityRepo.getNetworkDevices() });
  } catch (err: any) {
    res.json({ devices: [], error: err.message });
  }
});

app.post("/api/security/devices/:mac/acknowledge", validateApiKey, async (req: any, res: any) => {
  if (!permissions.hasGrant(req.username, "security.manage")) {
    return res.status(403).json({ error: 'Missing capability grant "security.manage"' });
  }
  try {
    const updated = await securityRepo.acknowledgeDevice(req.params.mac);
    if (!updated) return res.status(404).json({ error: "Device not found" });
    res.json(updated);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/security/findings", validateApiKey, async (req: any, res: any) => {
  try {
    res.json({ findings: await securityRepo.getFindings(req.query.status as securityRepo.FindingStatus | undefined) });
  } catch (err: any) {
    res.json({ findings: [], error: err.message });
  }
});

app.post("/api/security/findings/:id/status", validateApiKey, async (req: any, res: any) => {
  if (!permissions.hasGrant(req.username, "security.manage")) {
    return res.status(403).json({ error: 'Missing capability grant "security.manage"' });
  }
  const { status } = req.body;
  const valid: securityRepo.FindingStatus[] = ["open", "acknowledged", "resolved"];
  if (!valid.includes(status)) return res.status(400).json({ error: `status must be one of: ${valid.join(", ")}` });
  try {
    const updated = await securityRepo.updateFindingStatus(Number(req.params.id), status);
    if (!updated) return res.status(404).json({ error: "Finding not found" });
    res.json(updated);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/security/proposals", validateApiKey, async (req: any, res: any) => {
  try {
    res.json({ proposals: await securityRepo.getProposals(req.query.status as securityRepo.ProposalStatus | undefined) });
  } catch (err: any) {
    res.json({ proposals: [], error: err.message });
  }
});

// Approving/rejecting ONLY changes status — nothing here ever executes
// proposed_command. Real execution, if the user wants it, is a manual step
// they take themselves outside this app.
app.post("/api/security/proposals/:id/status", validateApiKey, async (req: any, res: any) => {
  if (!permissions.hasGrant(req.username, "security.manage")) {
    return res.status(403).json({ error: 'Missing capability grant "security.manage"' });
  }
  const { status } = req.body;
  const valid: securityRepo.ProposalStatus[] = ["pending", "approved", "rejected"];
  if (!valid.includes(status)) return res.status(400).json({ error: `status must be one of: ${valid.join(", ")}` });
  try {
    const updated = await securityRepo.updateProposalStatus(Number(req.params.id), status);
    if (!updated) return res.status(404).json({ error: "Proposal not found" });
    res.json(updated);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- Command Execution (the single most consequential capability in
// this codebase — see propose_command in src/execution/tools.ts, and
// scripts/security/command_executor.sh, which is the ONLY thing that ever
// actually runs a command, and only ever a HOST-side script, never this
// chat-facing container). Every row requires the user's own fresh approval;
// nothing here auto-approves or auto-executes anything. ----------
app.get("/api/system/commands", validateApiKey, async (req: any, res: any) => {
  if (!permissions.hasGrant(req.username, "system.execute")) {
    return res.status(403).json({ error: 'Missing capability grant "system.execute"' });
  }
  try {
    res.json({ commands: await commandProposalsRepo.getCommandProposals(req.query.status as commandProposalsRepo.CommandProposalStatus | undefined) });
  } catch (err: any) {
    res.json({ commands: [], error: err.message });
  }
});

app.post("/api/system/commands/:id/approve", validateApiKey, async (req: any, res: any) => {
  if (!permissions.hasGrant(req.username, "system.execute")) {
    return res.status(403).json({ error: 'Missing capability grant "system.execute"' });
  }
  try {
    const updated = await commandProposalsRepo.setCommandDecision(Number(req.params.id), "approved");
    if (!updated) return res.status(404).json({ error: "Command not found or not pending" });
    observation.logAuditEvent(req.username, "command_approved", "success", `#${updated.id}: ${updated.command}`);
    res.json(updated);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/system/mcp-servers/:id/approve", validateApiKey, async (req: any, res: any) => {
  if (!permissions.hasGrant(req.username, "system.mcp_manage")) {
    return res.status(403).json({ error: 'Missing capability grant "system.mcp_manage"' });
  }
  try {
    const result = await mcpRegistry.approveMcpServer(Number(req.params.id));
    if (!result.ok) {
      observation.logAuditEvent(req.username, "mcp_server_approve_failed", "failed", result.error);
      return res.status(422).json({ error: result.error });
    }
    await permissions.loadGrantsFromDb(); // backfill admin for this server's newly-cached tools immediately
    observation.logAuditEvent(req.username, "mcp_server_approved", "success", `#${result.server.id}: ${result.server.name}`);
    res.json(result.server);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/system/mcp-servers/:id/disable", validateApiKey, async (req: any, res: any) => {
  if (!permissions.hasGrant(req.username, "system.mcp_manage")) {
    return res.status(403).json({ error: 'Missing capability grant "system.mcp_manage"' });
  }
  try {
    const updated = await mcpServersRepo.setMcpServerStatus(Number(req.params.id), "disabled");
    if (!updated) return res.status(404).json({ error: "Server not found" });
    mcpRegistry.evictFromToolCache(updated.id); // drop cached tools immediately instead of waiting on the next health-check cycle
    observation.logAuditEvent(req.username, "mcp_server_disabled", "success", `#${updated.id}: ${updated.name}`);
    res.json(updated);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/system/build-requests", validateApiKey, async (req: any, res: any) => {
  if (!permissions.hasGrant(req.username, "github.pulls.create")) {
    return res.status(403).json({ error: 'Missing capability grant "github.pulls.create"' });
  }
  try {
    res.json({ buildRequests: await buildRequestsRepo.listBuildRequests(req.query.status as buildRequestsRepo.BuildRequestStatus | undefined) });
  } catch (err: any) {
    res.json({ buildRequests: [], error: err.message });
  }
});

// Rejects a proposed file path before any GitHub call happens. Closes a gap
// left open by Task 3's draftCodeChanges review: that function validates
// each path is a non-empty string but never checks for traversal or
// absolute paths, and this route is the first (and only) place a
// model-drafted path reaches a real GitHub write — untrusted input, real
// repo, no prior gate.
function isUnsafeProposedPath(path: string): boolean {
  if (!path || path.startsWith("/") || path.includes("\0")) return true;
  return path.split("/").some((segment) => segment === "..");
}

// The only place in this codebase that opens a real PR on Jarvis's own
// behalf. Every GitHub call here (branch -> commit each file -> open PR) is
// wrapped so a partial failure records exactly which step failed via
// markPrError rather than silently claiming a status it didn't reach — see
// this plan's Global Constraints.
app.post("/api/system/build-requests/:id/approve-code", validateApiKey, async (req: any, res: any) => {
  if (!permissions.hasGrant(req.username, "github.pulls.create")) {
    return res.status(403).json({ error: 'Missing capability grant "github.pulls.create"' });
  }
  const owner = process.env.SELF_REPO_OWNER;
  const repoName = process.env.SELF_REPO_NAME;
  if (!owner || !repoName) {
    return res.status(503).json({ error: "SELF_REPO_OWNER/SELF_REPO_NAME are not configured." });
  }
  try {
    const buildRequest = await buildRequestsRepo.getBuildRequest(Number(req.params.id));
    if (!buildRequest || buildRequest.status !== "awaiting_code_approval") {
      return res.status(404).json({ error: "Build request not found or not awaiting approval" });
    }
    const files = buildRequest.proposed_files || [];
    if (files.length === 0) {
      await buildRequestsRepo.markPrError(buildRequest.id, "No proposed files to commit.");
      return res.status(422).json({ error: "No proposed files to commit." });
    }

    // Closing the gap noted above: reject the whole approval loudly and
    // cleanly if any proposed file targets a path outside the intended
    // scope (traversal, absolute path, or a null byte) — never commit any
    // of them.
    const unsafePaths = files.map((f) => f.path).filter(isUnsafeProposedPath);
    if (unsafePaths.length > 0) {
      const message = `Refusing to commit unsafe file path(s): ${unsafePaths.join(", ")}`;
      await buildRequestsRepo.markPrError(buildRequest.id, message);
      return res.status(422).json({ error: message });
    }

    const branchName = `jarvis/build-request-${buildRequest.id}`;

    let repoInfo: any;
    try {
      repoInfo = await github.getRepo(owner, repoName);
    } catch (err: any) {
      await buildRequestsRepo.markPrError(buildRequest.id, `Failed to read repo default branch: ${err.message}`);
      return res.status(502).json({ error: `Failed to read repo default branch: ${err.message}` });
    }
    const baseBranch = repoInfo.default_branch;

    try {
      await github.createBranch(owner, repoName, branchName, baseBranch);
    } catch (err: any) {
      await buildRequestsRepo.markPrError(buildRequest.id, `Failed to create branch: ${err.message}`);
      return res.status(502).json({ error: `Failed to create branch: ${err.message}` });
    }

    for (const file of files) {
      try {
        await github.commitFile(
          owner,
          repoName,
          file.path,
          file.content,
          `Build request #${buildRequest.id}: ${buildRequest.code_summary || buildRequest.objective}`,
          branchName
        );
      } catch (err: any) {
        await buildRequestsRepo.markPrError(
          buildRequest.id,
          `Failed to commit "${file.path}": ${err.message}. Branch "${branchName}" may exist with a partial commit — review it manually.`
        );
        return res.status(502).json({ error: `Failed to commit "${file.path}": ${err.message}` });
      }
    }

    let pr: any;
    try {
      pr = await github.createPullRequest(
        owner,
        repoName,
        `Build request #${buildRequest.id}: ${buildRequest.objective}`,
        branchName,
        baseBranch,
        buildRequest.code_summary || undefined
      );
    } catch (err: any) {
      await buildRequestsRepo.markPrError(buildRequest.id, `Branch and commits succeeded but opening the PR failed: ${err.message}`);
      return res.status(502).json({ error: `Failed to open PR: ${err.message}` });
    }

    const updated = await buildRequestsRepo.recordPrOpened(buildRequest.id, pr.html_url, pr.number);
    if (!updated) {
      return res.status(500).json({ error: "PR was opened but couldn't be recorded — check GitHub directly." });
    }

    observation.logAuditEvent(req.username, "build_request_pr_opened", "success", `#${updated.id} -> ${pr.html_url}`);

    // QA runs immediately, synchronously, right here — no CI polling (see
    // design spec's "Decisions"). CI's own result speaks for itself on
    // GitHub, same as any other PR.
    const qaSummary = await departments.reviewCodeDiff(updated.objective, files, ai);
    await buildRequestsRepo.recordQaReview(updated.id, qaSummary);

    scheduler.pushNotification(
      req.username,
      `Opened the pull request for build request #${updated.id}, sir: ${pr.html_url}. QA review: ${qaSummary.slice(0, 300)}${qaSummary.length > 300 ? "..." : ""} Check GitHub for CI status.`,
      "info"
    );

    res.json({ ...updated, qa_summary: qaSummary });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/system/build-requests/:id/reject-code", validateApiKey, async (req: any, res: any) => {
  if (!permissions.hasGrant(req.username, "github.pulls.create")) {
    return res.status(403).json({ error: 'Missing capability grant "github.pulls.create"' });
  }
  try {
    const updated = await buildRequestsRepo.rejectCode(Number(req.params.id));
    if (!updated) return res.status(404).json({ error: "Build request not found or not awaiting code approval" });
    observation.logAuditEvent(req.username, "build_request_code_rejected", "success", `#${updated.id}`);
    res.json(updated);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/system/commands/:id/reject", validateApiKey, async (req: any, res: any) => {
  if (!permissions.hasGrant(req.username, "system.execute")) {
    return res.status(403).json({ error: 'Missing capability grant "system.execute"' });
  }
  try {
    const updated = await commandProposalsRepo.setCommandDecision(Number(req.params.id), "rejected");
    if (!updated) return res.status(404).json({ error: "Command not found or not pending" });
    observation.logAuditEvent(req.username, "command_rejected", "success", `#${updated.id}: ${updated.command}`);
    res.json(updated);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Lets you back out of an already-approved command that hasn't run yet —
// e.g. approved by mistake, or you changed your mind. Cannot touch a command
// the executor has already claimed (cancelApprovedCommand only matches
// status = 'approved'; claim() has already flipped it to 'running' by then).
app.post("/api/system/commands/:id/cancel", validateApiKey, async (req: any, res: any) => {
  if (!permissions.hasGrant(req.username, "system.execute")) {
    return res.status(403).json({ error: 'Missing capability grant "system.execute"' });
  }
  try {
    const updated = await commandProposalsRepo.cancelApprovedCommand(Number(req.params.id));
    if (!updated) return res.status(404).json({ error: "Command not found, not approved, or already claimed for execution" });
    observation.logAuditEvent(req.username, "command_cancelled", "success", `#${updated.id}: ${updated.command}`);
    res.json(updated);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Called only by the host-side executor script — atomically claims exactly
// one approved command (approved -> running) so an overlapping executor run
// can never pick up and run the same command twice.
app.post("/api/system/commands/claim", validateApiKey, async (req: any, res: any) => {
  if (!permissions.hasGrant(req.username, "system.execute")) {
    return res.status(403).json({ error: 'Missing capability grant "system.execute"' });
  }
  try {
    const claimed = await commandProposalsRepo.claimApprovedCommand();
    if (!claimed) return res.json({ command: null });
    res.json({ command: claimed });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Called only by the host-side executor script, after it actually ran a
// claimed command — reports the real output/exit code back.
app.post("/api/system/ingest/command-result", validateApiKey, async (req: any, res: any) => {
  if (!permissions.hasGrant(req.username, "system.execute")) {
    return res.status(403).json({ error: 'Missing capability grant "system.execute"' });
  }
  const { id, output, exitCode } = req.body;
  if (typeof id !== "number" || typeof exitCode !== "number") {
    return res.status(400).json({ error: "id (number) and exitCode (number) are required" });
  }
  try {
    const updated = await commandProposalsRepo.recordCommandResult(id, output || "", exitCode);
    if (!updated) return res.status(404).json({ error: "Command not found" });
    // A nonzero exit is already an unambiguous outcome signal — only a
    // successful run is actually ambiguous ("it ran, but did it help?"),
    // so only 'executed' rows get the follow-up question.
    if (updated.status === "executed") {
      scheduler.pushNotification(
        updated.requested_by,
        `Ran your command (#${updated.id}), sir: "${updated.command}". Did that fix it?`,
        "info"
      );
    }
    res.json(updated);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- Proactive Briefing ----------
// GET generates and returns one right now (on demand); the scheduled job in
// scheduler.ts runs the same real synthesis on a timer without being asked.
app.get("/api/briefing", validateApiKey, async (req: any, res: any) => {
  try {
    const result = await briefing.generateBriefing(groq, req.username);
    try {
      await briefingRepo.saveBriefing(result.text, result.itemCount, result.items);
    } catch (err: any) {
      observation.logTelemetry("warn", "Briefing", `Failed to persist on-demand briefing: ${err.message}`);
    }
    res.json(result);
  } catch (err: any) {
    observation.logTelemetry("error", "Briefing", `Briefing generation failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/briefing/history", validateApiKey, async (req: any, res: any) => {
  try {
    res.json({ briefings: await briefingRepo.getRecentBriefings() });
  } catch (err: any) {
    res.json({ briefings: [], error: err.message });
  }
});

// Admin & Memory Endpoints — persisted in Postgres, see src/data/memory-repo.ts
app.get("/api/memory/pending", validateApiKey, async (req: any, res: any) => {
  try {
    res.json(await memoryRepo.getPendingRecords());
  } catch (err: any) {
    observation.logTelemetry("warn", "Database", `Failed to load memory records: ${err.message}`);
    res.status(503).json({ error: "Memory store unavailable" });
  }
});

app.post("/api/memory/verify/:record_uuid", validateApiKey, async (req: any, res: any) => {
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

app.post("/api/memory/verify_all", validateApiKey, async (req: any, res: any) => {
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

app.post("/api/admin/consolidate", validateApiKey, (req, res) => {
  res.json({ promoted: 0 });
});

app.get("/api/admin/consolidation/status", validateApiKey, async (req, res) => {
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
  app.post(`/api/evolution/analyze/${type}`, validateApiKey, async (req: any, res: any) => {
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

app.get("/api/evolution/recommendations", validateApiKey, async (req: any, res: any) => {
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

app.get("/api/evolution/analyses", validateApiKey, async (req: any, res: any) => {
  try {
    res.json({ analyses: await evolutionRepo.getAllAnalyses() });
  } catch (err: any) {
    res.json({ analyses: [], error: err.message });
  }
});

app.get("/api/evolution/dependency-graph", validateApiKey, (req: any, res: any) => {
  try {
    res.json(analyzer.buildDependencyGraph());
  } catch (err: any) {
    res.status(500).json({ error: err.message, nodes: [], edges: [] });
  }
});

app.get("/api/evolution/dashboard", validateApiKey, async (req: any, res: any) => {
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

app.get("/api/evolution/trends", validateApiKey, async (req: any, res: any) => {
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

app.get("/api/evolution/forecast", validateApiKey, async (req: any, res: any) => {
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

app.post("/api/evolution/recommendations/prioritize", validateApiKey, async (req: any, res: any) => {
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

app.get("/api/evolution/goals", validateApiKey, async (req: any, res: any) => {
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

app.post("/api/evolution/goals", validateApiKey, async (req: any, res: any) => {
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

app.post("/api/ecosystem/discover", validateApiKey, (req, res) => {
  res.json({ discovered: [] });
});

app.post("/api/ecosystem/install", validateApiKey, (req, res) => {
  res.json({ status: "success" });
});

app.get("/api/ecosystem/plugins", validateApiKey, (req, res) => {
  res.json({ plugins: [] });
});

// ---------- Capability grants (permission model) ----------
// Default-deny: a capability (github.issues.create, email.send, ...) only
// works for a user once explicitly granted here. Only the admin key can
// grant/revoke; any authenticated user can see their own grants.

app.get("/api/permissions", validateApiKey, (req: any, res: any) => {
  res.json({ username: req.username, grants: permissions.listGrants(req.username), available: permissions.ALL_CAPABILITIES });
});

app.post("/api/permissions/grant", validateApiKey, async (req: any, res: any) => {
  if (req.username !== "admin") {
    return res.status(403).json({ error: "Only admin can grant capabilities" });
  }
  const { username, capability } = req.body;
  if (!username || !capability) {
    return res.status(400).json({ error: "username and capability are required" });
  }
  if (!(permissions.ALL_CAPABILITIES as readonly string[]).includes(capability)) {
    return res.status(400).json({ error: `Unknown capability "${capability}"` });
  }
  await permissions.grantCapability(username, capability, req.username);
  res.json({ status: "success", username, grants: permissions.listGrants(username) });
});

app.post("/api/permissions/revoke", validateApiKey, async (req: any, res: any) => {
  if (req.username !== "admin") {
    return res.status(403).json({ error: "Only admin can revoke capabilities" });
  }
  const { username, capability } = req.body;
  if (!username || !capability) {
    return res.status(400).json({ error: "username and capability are required" });
  }
  await permissions.revokeCapability(username, capability, req.username);
  res.json({ status: "success", username, grants: permissions.listGrants(username) });
});

// ---------- Integrations: GitHub / Email / TTS ----------

const handleIntegrationError = (res: any, err: any) => {
  const status = typeof err?.status === "number" ? err.status : 500;
  observation.logTelemetry("warn", "Integrations", `Request failed: ${err?.message || err}`);
  res.status(status).json({ error: err?.message || "Integration request failed" });
};

app.get("/api/integrations/github/repo", validateApiKey, async (req: any, res: any) => {
  const { owner, repo, path: filePath, ref } = req.query;
  if (!owner || !repo) return res.status(400).json({ error: "owner and repo are required" });
  try {
    const data = filePath
      ? await github.getFileContent(owner, repo, filePath, ref)
      : await github.getRepo(owner, repo);
    res.json(data);
  } catch (err) {
    handleIntegrationError(res, err);
  }
});

app.post("/api/integrations/github/issues", validateApiKey, async (req: any, res: any) => {
  const { owner, repo, title, body, labels } = req.body;
  if (!owner || !repo || !title) return res.status(400).json({ error: "owner, repo and title are required" });
  try {
    res.json(await github.createIssue(owner, repo, title, body, labels));
  } catch (err) {
    handleIntegrationError(res, err);
  }
});

app.post("/api/integrations/github/issues/:number/comments", validateApiKey, async (req: any, res: any) => {
  const { owner, repo, body } = req.body;
  if (!owner || !repo || !body) return res.status(400).json({ error: "owner, repo and body are required" });
  try {
    res.json(await github.commentOnIssue(owner, repo, Number(req.params.number), body));
  } catch (err) {
    handleIntegrationError(res, err);
  }
});

app.post("/api/integrations/github/pulls", validateApiKey, async (req: any, res: any) => {
  const { owner, repo, title, head, base, body } = req.body;
  if (!owner || !repo || !title || !head || !base) {
    return res.status(400).json({ error: "owner, repo, title, head and base are required" });
  }
  try {
    res.json(await github.createPullRequest(owner, repo, title, head, base, body));
  } catch (err) {
    handleIntegrationError(res, err);
  }
});

app.get("/api/integrations/github/pulls", validateApiKey, async (req: any, res: any) => {
  const { owner, repo, number, state } = req.query;
  if (!owner || !repo) return res.status(400).json({ error: "owner and repo are required" });
  try {
    const data = number
      ? await github.getPullRequest(owner, repo, Number(number))
      : await github.listPullRequests(owner, repo, state);
    res.json(data);
  } catch (err) {
    handleIntegrationError(res, err);
  }
});

app.post("/api/integrations/email/send", validateApiKey, async (req: any, res: any) => {
  const { to, subject, text, html } = req.body;
  if (!to || !subject || !text) return res.status(400).json({ error: "to, subject and text are required" });
  try {
    res.json(await emailIntegration.sendEmail(to, subject, text, html));
  } catch (err) {
    handleIntegrationError(res, err);
  }
});

app.get("/api/integrations/email/messages", validateApiKey, async (req: any, res: any) => {
  const limit = req.query.limit ? Number(req.query.limit) : 10;
  try {
    res.json(await emailIntegration.fetchRecentMessages(limit));
  } catch (err) {
    handleIntegrationError(res, err);
  }
});

app.post("/api/integrations/tts/speak", validateApiKey, async (req: any, res: any) => {
  const { text, voice, model } = req.body;
  if (!text) return res.status(400).json({ error: "text is required" });
  try {
    const { audio, contentType } = await tts.synthesizeSpeech(text, { voice, model });
    res.setHeader("Content-Type", contentType);
    res.send(audio);
  } catch (err) {
    handleIntegrationError(res, err);
  }
});

// ---------- Local Files/Notes (scoped to one dedicated folder) ----------
app.get("/api/integrations/files/list", validateApiKey, async (req: any, res: any) => {
  try {
    res.json(await jarvisFiles.listFiles(req.query.path as string | undefined));
  } catch (err) {
    handleIntegrationError(res, err);
  }
});

app.get("/api/integrations/files/read", validateApiKey, async (req: any, res: any) => {
  const { path: relPath } = req.query;
  if (!relPath) return res.status(400).json({ error: "path is required" });
  try {
    res.json({ path: relPath, content: await jarvisFiles.readFile(relPath as string) });
  } catch (err) {
    handleIntegrationError(res, err);
  }
});

app.post("/api/integrations/files/write", validateApiKey, async (req: any, res: any) => {
  const { path: relPath, content } = req.body;
  if (!relPath || typeof content !== "string") {
    return res.status(400).json({ error: "path and content are required" });
  }
  try {
    res.json(await jarvisFiles.writeFile(relPath, content));
  } catch (err) {
    handleIntegrationError(res, err);
  }
});

app.delete("/api/integrations/files", validateApiKey, async (req: any, res: any) => {
  const { path: relPath } = req.query;
  if (!relPath) return res.status(400).json({ error: "path is required" });
  try {
    await jarvisFiles.deleteFile(relPath as string);
    res.json({ status: "success" });
  } catch (err) {
    handleIntegrationError(res, err);
  }
});

// ---------- Google Calendar (OAuth, one-time setup) ----------
// GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI required — see README for how to
// create these in Google Cloud. Deployment-wide, single-tenant, same as
// GITHUB_TOKEN/EMAIL_* — not a per-registered-user OAuth flow.

app.get("/api/integrations/calendar/auth-url", validateApiKey, (req: any, res: any) => {
  try {
    res.json({ url: calendar.getAuthUrl() });
  } catch (err) {
    handleIntegrationError(res, err);
  }
});

// No validateApiKey: Google's redirect is the user's own browser navigating
// here after consent, which can't attach an x-api-key header. The
// authorization code itself (short-lived, tied to the registered redirect
// URI and client secret) is what's actually being trusted here, same as any
// standard OAuth callback.
app.get("/api/integrations/calendar/callback", async (req: any, res: any) => {
  const { code, error } = req.query;
  if (error) {
    return res.status(400).send(`<html><body>Google Calendar authorization denied: ${error}</body></html>`);
  }
  if (!code) {
    return res.status(400).send("<html><body>Missing authorization code.</body></html>");
  }
  try {
    await calendar.exchangeCodeForTokens(code);
    res.send("<html><body>Google Calendar connected — you can close this tab.</body></html>");
  } catch (err: any) {
    observation.logTelemetry("error", "Integrations", `Calendar OAuth callback failed: ${err.message}`);
    res.status(err.status || 500).send(`<html><body>Failed to connect Google Calendar: ${err.message}</body></html>`);
  }
});

app.get("/api/integrations/calendar/events", validateApiKey, async (req: any, res: any) => {
  try {
    res.json(await calendar.listEvents(req.query.timeMinISO, req.query.timeMaxISO));
  } catch (err) {
    handleIntegrationError(res, err);
  }
});

app.post("/api/integrations/calendar/events", validateApiKey, async (req: any, res: any) => {
  const { summary, startISO, endISO, description } = req.body;
  if (!summary || !startISO || !endISO) {
    return res.status(400).json({ error: "summary, startISO, and endISO are required" });
  }
  try {
    res.json(await calendar.createEvent(summary, startISO, endISO, description));
  } catch (err) {
    handleIntegrationError(res, err);
  }
});

// ---------- News ----------
app.get("/api/integrations/news/headlines", validateApiKey, async (req: any, res: any) => {
  try {
    const articles = await news.getTopHeadlines({
      country: req.query.country as string | undefined,
      category: req.query.category as string | undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    });
    res.json({ articles });
  } catch (err) {
    handleIntegrationError(res, err);
  }
});

app.get("/api/integrations/news/search", validateApiKey, async (req: any, res: any) => {
  const q = req.query.q as string | undefined;
  if (!q) return res.status(400).json({ error: "q is required" });
  try {
    const articles = await news.searchNews(q, req.query.limit ? Number(req.query.limit) : undefined);
    res.json({ articles });
  } catch (err) {
    handleIntegrationError(res, err);
  }
});

// ---------- Web Search ----------
app.get("/api/integrations/websearch", validateApiKey, async (req: any, res: any) => {
  const q = req.query.q as string | undefined;
  if (!q) return res.status(400).json({ error: "q is required" });
  try {
    const results = await webSearch.webSearch(q, req.query.limit ? Number(req.query.limit) : undefined);
    res.json({ results });
  } catch (err) {
    handleIntegrationError(res, err);
  }
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

// One-time tickets for /ws/voice — see the comment on the WS handshake below
// for why this exists instead of the permanent API key riding in the URL.
const VOICE_TICKET_TTL_MS = 30_000;
const voiceTickets = new Map<string, { username: string; expiresAt: number }>();

function issueVoiceTicket(username: string): string {
  const now = Date.now();
  for (const [t, v] of voiceTickets) {
    if (v.expiresAt < now) voiceTickets.delete(t); // opportunistic sweep, keeps the map bounded
  }
  const ticket = crypto.randomBytes(24).toString("hex");
  voiceTickets.set(ticket, { username, expiresAt: now + VOICE_TICKET_TTL_MS });
  return ticket;
}

function consumeVoiceTicket(ticket: string): string | null {
  const entry = voiceTickets.get(ticket);
  voiceTickets.delete(ticket); // single-use regardless of outcome
  if (!entry || entry.expiresAt < Date.now()) return null;
  return entry.username;
}

app.post("/api/voice-ticket", validateApiKey, (req: any, res: any) => {
  res.json({ ticket: issueVoiceTicket(req.username) });
});

initDatabase().then(async (ready) => {
  if (ready) {
    try {
      await memoryRepo.seedMemoryRecords();
    } catch (err: any) {
      observation.logTelemetry("warn", "Database", `Failed to seed memory records: ${err.message}`);
    }
    try {
      await permissions.loadGrantsFromDb();
    } catch (err: any) {
      observation.logTelemetry("warn", "Database", `Failed to load capability grants: ${err.message}`);
    }
  }
  const httpServer = app.listen(PORT, "0.0.0.0", () => {
    observation.logTelemetry("info", "System", `🚀 Jarvis OS Server running on http://localhost:${PORT}`);
  });

  // ---------- Voice-native mode (Gemini Live API) ----------
  // A continuous WebSocket audio stream, not a request/response round trip —
  // see src/cognition/live-voice.ts. Browser WebSocket clients can't attach a
  // custom x-api-key header on the handshake, and the permanent admin/user
  // key deliberately never goes in a URL elsewhere (see the header-only note
  // above validateApiKey — query strings end up in access logs). So the
  // handshake instead carries a short-lived, single-use ticket obtained via
  // a normal authenticated POST (see /api/voice-ticket below); the permanent
  // key never touches a URL or a log line for this path either.
  const voiceWss = new WebSocketServer({ server: httpServer, path: "/ws/voice" });
  voiceWss.on("connection", async (ws, req) => {
    const url = new URL(req.url || "", `http://${req.headers.host}`);
    const ticket = url.searchParams.get("ticket");
    const username = ticket ? consumeVoiceTicket(ticket) : null;

    if (!username) {
      ws.send(JSON.stringify({ type: "error", message: "Missing or invalid/expired voice ticket." }));
      ws.close();
      return;
    }
    if (!ai) {
      ws.send(JSON.stringify({ type: "error", message: "Voice-native mode requires GEMINI_API_KEY to be configured." }));
      ws.close();
      return;
    }

    observation.logTelemetry("info", "LiveVoice", `WebSocket voice connection opened for "${username}".`);
    await liveVoice.bridgeVoiceSession(ai, groq, ws, username);
  });

  scheduler.startEmailWatchJob();
  scheduler.startBriefingJob(groq);
  scheduler.startSelfReflectionJob(groq);
  scheduler.startMcpHealthCheckJob();
});

// Evict idle per-user session state (working memory, not persisted data) so
// long-running deployments don't accumulate one SessionState per visitor forever.
setInterval(() => {
  const pruned = pruneIdleSessions();
  if (pruned > 0) {
    observation.logTelemetry("info", "System", `Pruned ${pruned} idle session(s). ${getActiveSessionCount()} active.`);
  }
}, 30 * 60 * 1000);
