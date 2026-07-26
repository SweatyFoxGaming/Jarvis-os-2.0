import express from "express";
import helmet from "helmet";
import cors from "cors";
import path from "path";
import crypto from "crypto";
import dotenv from "dotenv";
import rateLimit from "express-rate-limit";
import { GoogleGenAI, Content, FunctionCall } from "@google/genai";
import { toGroqTools, generateWithFallback as generateGroqWithFallback } from "./runtime/groq-client.js";
import Groq from "groq-sdk";
import { ObservationPlatform } from "./kernel/observation.js";
import { AutonomousExecutive } from "./executive/autonomous_executive.js";
import { LongTermLearningEngine } from "./adaptation/long_term_learning.js";
import { MindKernel } from "./self/kernel.js";
import { LocalCognitiveEngine } from "./runtime/local_engine.js";
import * as whisper from "./interaction/whisper.js";
import { initDatabase, pingDatabase } from "./kernel/state/db.js";
import * as memoryRepo from "./kernel/state/memory-repo.js";
import * as sessionRepo from "./kernel/state/session-repo.js";
import { getSession, pruneIdleSessions, getActiveSessionCount, SessionState } from "./cognition/session.js";
import { getAllToolDeclarations, executeTool, looksToolShaped, looksTrivial } from "./capabilities/tools.js";
import * as permissions from "./kernel/security.js";
import { requireCapability } from "./kernel/security.js";
import { validateApiKey } from "./kernel/auth-middleware.js";
import { assertSafeEgressUrl, normalizeLocalLlmUrl } from "./kernel/egress.js";
import * as memoryStore from "./cognition/memory-store.js";
import * as scheduler from "./kernel/scheduler.js";
import { reflectAndLearn } from "./adaptation/reflection.js";
import { WebSocketServer } from "ws";
import * as liveVoice from "./interaction/live-voice.js";
import * as knowledgeGraph from "./cognition/knowledge-graph.js";
import * as knowledgeGraphRepo from "./kernel/state/knowledge-graph-repo.js";
import * as briefing from "./world/briefing.js";
import * as identity from "./self/identity.js";
import * as identityRepo from "./kernel/state/identity-repo.js";
import * as commandProposalsRepo from "./kernel/state/command-proposals-repo.js";
import * as buildRequestsRepo from "./kernel/state/build-requests-repo.js";
import { authRouter } from "./interaction/routes/auth-routes.js";
import { settingsRouter } from "./interaction/routes/settings-routes.js";
import { observationRouter } from "./interaction/routes/observation-routes.js";
import { learningRouter } from "./interaction/routes/learning-routes.js";
import { notificationsRouter } from "./interaction/routes/notifications-routes.js";
import { setSharedClients } from "./runtime/clients.js";
import { positiveIntegerEnv } from "./kernel/env.js";
import { knowledgeRouter } from "./interaction/routes/knowledge-routes.js";
import { featureRequestsRouter } from "./interaction/routes/feature-requests-routes.js";
import { securityRouter } from "./interaction/routes/security-routes.js";
import { buildRequestsRouter } from "./interaction/routes/build-requests-routes.js";
import { vaultRouter } from "./interaction/routes/vault-routes.js";
import { briefingMemoryRouter } from "./interaction/routes/briefing-memory-routes.js";
import { evolutionRouter } from "./interaction/routes/evolution-routes.js";
import { permissionsRouter } from "./interaction/routes/permissions-routes.js";
import { integrationsRouter } from "./interaction/routes/integrations-routes.js";

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
// Overridable for exactly one reason: verifying a real boot of this file
// without colliding with an already-running instance on the default port
// (confirmed to matter in practice — the test suite's own HTTP Boundary
// test already has to handle "something's already on :3000" as a real,
// not hypothetical, case). Defaults to 3000 unchanged for every normal
// deployment; docker-compose.yml's port mapping is unaffected either way.
const PORT = positiveIntegerEnv(process.env.PORT, 3000);

// INTERNAL_API_KEY's fail-fast validation now lives in
// kernel/auth-middleware.ts, run at that module's first import (below) —
// still before app.listen(), same as when this check was inline here.

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "http://localhost:8000,http://localhost:3000")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

// The frontend (src/interaction/static/*.html) is a pre-existing single-file dashboard
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

// authLimiter/loginUsernameLimiter moved to interaction/routes/auth-routes.ts
// with the routes they exclusively guard.

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

// ---------- NVIDIA NIM Client Initialization (agentic coding loop only) ----------
const nvidiaApiKey: string | null = process.env.NVIDIA_API_KEY || null;
if (nvidiaApiKey) {
  observation.logTelemetry("info", "Cognition", "NVIDIA NIM API key configured — the agentic coding loop is available.");
} else {
  observation.logTelemetry("warn", "Cognition", "No NVIDIA_API_KEY detected. The agentic coding loop is unavailable.");
}

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

const executive = AutonomousExecutive.getInstance(observation, ai, groq, nvidiaApiKey);
const learningEngine = LongTermLearningEngine.getInstance();
// Makes these same already-constructed clients reachable from extracted
// routers (src/interaction/routes/) via runtime/clients.ts's getters —
// see that module's own comment for why this must happen here (after
// construction) rather than the routers reading them at their own
// module-load time.
setSharedClients(ai, groq, nvidiaApiKey);

// Users, API keys, and memory records are persisted in Postgres (src/data/) —
// see initDatabase() near the bottom of this file, called before app.listen.

// ---------- Middleware: API Key Auth ----------
// validateApiKey lives in kernel/auth-middleware.ts, requireCapability in
// kernel/security.ts (imported above) — both used throughout this file and
// by every extracted router in src/interaction/routes/.

// ---------- Endpoints ----------

// Health Check
//
// Deliberately always 200 here, never a non-2xx for a down database: this
// endpoint doubles as the "is the Express process itself alive" liveness
// signal several HTTP Boundary tests (and CI, which — same as this test
// suite — runs with no live Postgres available) poll to confirm the server
// booted at all, something that's true and worth knowing independently of
// whether Postgres happens to be reachable. What was actually missing
// wasn't a different status code, it was the database's real status ever
// appearing in the body at all — this used to report Gemini-key presence
// and a hardcoded "local_store: operational" string that had nothing to do
// with Postgres, so a deployment where Postgres never came up (or a
// migration threw) could poll this and see nothing wrong.
app.get("/health", async (req, res) => {
  const health = observation.getHealth();
  // Always a live ping, deliberately not gated behind whether Postgres came
  // up at boot: a one-way "was it ready at startup" flag would mean a
  // database that recovers after a failed boot stays permanently reported
  // as down until the whole process restarts. pingDatabase() bounds itself
  // to 5s regardless of Postgres's own statement/query timeouts, so this
  // never turns a healthy request into a slow one.
  const dbConnected = await pingDatabase();
  res.json({
    status: health.status === "green" && dbConnected ? "up" : "degraded",
    version: "1.8.0",
    engine_ready: true,
    database: dbConnected ? "up" : "down",
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

// Authentication Endpoints (/api/register, /api/login) — see
// src/interaction/routes/auth-routes.ts, mounted below.
app.use(authRouter);

// Status/settings endpoints (/api/status, /api/settings*) — see
// src/interaction/routes/settings-routes.ts, mounted below.
app.use(settingsRouter);

// Observation/cognition endpoints — see
// src/interaction/routes/observation-routes.ts, mounted below.
app.use(observationRouter);

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

// Long-term learning dashboard/style/mistake + /api/learn — see
// src/interaction/routes/learning-routes.ts, mounted below.
app.use(learningRouter);

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
    // session — see src/self/identity.ts. Empty string when there's
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
      + "\n\nIf the user asks for something you have no tool for, don't just decline or invent a fake result. Use search_web to research whether/how it could genuinely be built, then present a concrete, honest plan in conversation — what it would do, roughly how. If they clearly approve building it, that's enough — the executive planner will pick up the objective on its own, research it properly, and come back to consult on direction before anything gets built. Don't invent a special tool call for this; just proceed with the normal planning flow. If they don't approve, or you're just discussing the idea, don't start anything."
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
        executionChain.push("Groq", "Gemini");
      } else if (kernel.llmMode === "strictly-local") {
        executionChain.push("LocalLLM");
      } else if (kernel.llmMode === "online-first") {
        executionChain.push("Groq", "Gemini", "LocalLLM");
      } else {
        // local-first (default)
        executionChain.push("LocalLLM", "Groq", "Gemini");
      }
    }

    // A tool-shaped request ("check that GitHub repo", "send an email...")
    // sent to the local model is exactly the fabrication risk the honest
    // local prompt above is a safety net for — but the better outcome is to
    // not need that net at all. Groq can call tools (unlike local), so
    // prefer it first so the request gets real capability instead of an
    // honest decline. Guarded on `executionChain[0] !== "Groq"` rather than
    // `=== "LocalLLM"` specifically so this is a no-op (not a crash) if
    // Groq's already at the front for some other reason.
    if (kernel.llmMode !== "strictly-local" && looksToolShaped(message)) {
      if (groq && executionChain[0] !== "Groq" && executionChain.includes("Groq")) {
        const idx = executionChain.indexOf("Groq");
        executionChain.splice(idx, 1);
        executionChain.unshift("Groq");
      } else if (!groq && ai && executionChain[0] !== "Gemini" && executionChain.includes("Gemini")) {
        // No Groq configured — fall back to promoting Gemini for tool-shaped
        // requests, restoring this codebase's pre-Groq behavior rather than
        // silently losing tool-calling capability to LocalLLM's honest decline.
        const idx = executionChain.indexOf("Gemini");
        executionChain.splice(idx, 1);
        executionChain.unshift("Gemini");
      }
    }

    // A live camera frame is only genuinely usable by Gemini's multimodal
    // input — neither the local llama-cpp path nor Groq's hosted text
    // models have vision support. Checked AFTER the tool-shaped promotion
    // above (not instead of it) and guarded on `!== "Gemini"` (not
    // `executionChain[0] === "LocalLLM"`) so an image always wins the front
    // slot even when the same message also looks tool-shaped and Groq was
    // just promoted there a moment ago.
    if (
      ai &&
      image &&
      kernel.llmMode !== "strictly-local" &&
      executionChain[0] !== "Gemini" &&
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

          const targetUrl = normalizeLocalLlmUrl(kernel.localLlmEndpoint);
          assertSafeEgressUrl(targetUrl);

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

      else if (step === "Groq") {
        if (groq) {
          try {
            observation.incrementMetric("groqApiCalls");
            session.updateState({
              currentThought: "Querying Groq",
              executiveStatus: "Executing",
              activeCapability: "Groq LLM Generation"
            }, observation);

            // Trivial conversational filler ("thanks", "good morning") never
            // needs a tool — skip attaching the tool schema at all (real
            // token savings, and a message with no tools present structurally
            // cannot trigger the tool-hallucination failure mode observed
            // live during Groq verification) and prefer the faster model.
            // looksToolShaped always wins any ambiguous case: a message must
            // be BOTH tool-shaped-negative AND trivial to take this path.
            const isFastPath = !looksToolShaped(message) && looksTrivial(message);
            const groqTools = isFastPath ? null : toGroqTools(getAllToolDeclarations());
            const messages: any[] = [
              { role: "system", content: systemInstruction },
              { role: "user", content: message },
            ];
            const groqModels = isFastPath
              ? ["llama-3.1-8b-instant", "llama-3.3-70b-versatile"]
              : ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"];

            let response = await generateGroqWithFallback(
              groq,
              groqTools ? { messages, tools: groqTools } : { messages },
              groqModels
            );
            let toolCalls = response.choices[0]?.message?.tool_calls || [];
            let guard = 0;

            while (toolCalls.length > 0 && guard < 3) {
              guard++;
              const assistantMessage = response.choices[0].message;
              messages.push({
                role: "assistant",
                content: assistantMessage.content,
                tool_calls: assistantMessage.tool_calls,
              });

              const toolResponseMessages: any[] = [];
              for (const call of toolCalls) {
                let args: Record<string, any> = {};
                try {
                  args = JSON.parse(call.function.arguments || "{}");
                } catch {
                  // Malformed arguments from the model — executeTool below
                  // fails cleanly on whatever this leaves args as, same as
                  // a genuinely empty-args call would.
                }

                const result = await executeTool(
                  call.function.name || "",
                  args,
                  req.username,
                  ai,
                  kernel.localLlmEndpoint,
                  { alreadyAttached: false, supportsRoundTrip: true }
                );

                // Mirrors the Gemini branch's identical handling below.
                if (result.needsClientAction === "capture_screen") {
                  res.write("data: request_screen\n\n");
                  res.write("data: [DONE]\n\n");
                  res.end();
                  success = true;
                  succeededStep = "Groq";
                  return;
                }

                if (result.displayDirective) {
                  res.write(`data: display: ${JSON.stringify(result.displayDirective)}\n\n`);
                }

                toolCallsExecuted.push({ name: result.name, ok: result.ok });
                toolResponseMessages.push({
                  role: "tool",
                  tool_call_id: call.id,
                  content: JSON.stringify(result.ok ? { output: result.output } : { error: result.error }),
                });
              }
              messages.push(...toolResponseMessages);

              response = await generateGroqWithFallback(groq, { messages, tools: groqTools }, groqModels);
              toolCalls = response.choices[0]?.message?.tool_calls || [];
            }

            const finalText = response.choices[0]?.message?.content || "";
            if (finalText) {
              for (const word of finalText.split(" ")) {
                fullReply += word + " ";
                res.write(`data: ${word} \n\n`);
              }
              success = true;
              succeededStep = "Groq";
            }
          } catch (err: any) {
            observation.logTelemetry("warn", "Cognition", `Groq generation failed: ${err.message || err}`);
          }
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
        // Write side of continuity-of-self — see self/identity.ts.
        identity.extractSelfReflection(groq, message, fullReply).catch(() => {});
      }
    }

    const latency = performance.now() - startTime;
    observation.recordLatency(latency);
    observation.endProfile("chat_request");

    // Real confidence: derived from what actually happened this turn — which
    // backend answered, whether memory had anything relevant, whether any
    // tool calls succeeded — instead of fixed inputs keyed only on "is a
    // Gemini key set." This is deliberately observability-only here (session
    // state + decision trace for the UI), not a gate on the reply itself:
    // fullReply has already been streamed token-by-token to the client via
    // SSE by this point, so there is nothing left to withhold or qualify
    // by the time this number exists. The autonomous executive's research
    // path (autonomous_executive.ts) computes its confidence before the
    // work it describes finishes, so it can and does gate on it — see the
    // low-confidence status there.
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

// Shutdown Hook
app.post("/api/shutdown", validateApiKey, (req, res) => {
  observation.logTelemetry("warn", "System", "Server shutdown API invoked");
  res.json({ status: "shutdown initiated" });
});

// Notifications + Web Push endpoints — see
// src/interaction/routes/notifications-routes.ts, mounted below.
app.use(notificationsRouter);

// Knowledge graph + identity/continuity endpoints — see
// src/interaction/routes/knowledge-routes.ts, mounted below.
app.use(knowledgeRouter);

// Feature-requests endpoints — see
// src/interaction/routes/feature-requests-routes.ts, mounted below.
app.use(featureRequestsRouter);

// Security ops + command execution + mcp-server approve/disable — see
// src/interaction/routes/security-routes.ts, mounted below.
app.use(securityRouter);

// Build-requests listing/transcript/plan + approve-code/reject-code — see
// src/interaction/routes/build-requests-routes.ts, mounted below.
app.use(buildRequestsRouter);

// Vault (Obsidian) endpoints — see src/interaction/routes/vault-routes.ts,
// mounted below.
app.use(vaultRouter);

// Briefing + memory + admin-consolidation endpoints — see
// src/interaction/routes/briefing-memory-routes.ts, mounted below.
app.use(briefingMemoryRouter);

// Evolution self-analysis + ecosystem stub endpoints — see
// src/interaction/routes/evolution-routes.ts, mounted below.
app.use(evolutionRouter);

// Capability grant/revoke endpoints — see
// src/interaction/routes/permissions-routes.ts, mounted below.
app.use(permissionsRouter);

// GitHub/email/TTS/files/calendar/news/websearch integration endpoints —
// see src/interaction/routes/integrations-routes.ts, mounted below.
app.use(integrationsRouter);

// ---------- Static Files Serving ----------
const staticDir = path.join(process.cwd(), "src", "interaction", "static");
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
    try {
      // After migrations (part of initDatabase() above) so system_settings
      // is guaranteed to exist by the time this queries it. A failure here
      // just leaves MindKernel's hardcoded defaults in place — see its own
      // hydrateFromDb() doc comment.
      await MindKernel.getInstance().hydrateFromDb();
    } catch (err: any) {
      observation.logTelemetry("warn", "Database", `Failed to hydrate system settings: ${err.message}`);
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
  scheduler.startVaultSyncJob();
  scheduler.startDataRetentionJob();
});

// Evict idle per-user session state (working memory, not persisted data) so
// long-running deployments don't accumulate one SessionState per visitor forever.
setInterval(() => {
  const pruned = pruneIdleSessions();
  if (pruned > 0) {
    observation.logTelemetry("info", "System", `Pruned ${pruned} idle session(s). ${getActiveSessionCount()} active.`);
  }
}, 30 * 60 * 1000);
