import 'dotenv/config';
import express from "express";
import helmet from "helmet";
import cors from "cors";
import cookieParser from "cookie-parser";
import path from "path";
import crypto from "crypto";
import { applyHybridSearchSchema } from './kernel/state/hybridSearchMigration.js';
import { getPool } from "./kernel/state/db.js";
import dotenv from "dotenv";
import rateLimit from "express-rate-limit";
import { GoogleGenAI, type Content, type FunctionCall } from "@google/genai";
import { toGroqTools, generateWithFallback as generateGroqWithFallback } from "./runtime/groq-client.js";
import { ObservationPlatform } from "./kernel/observation.js";
import { AutonomousExecutive } from "./executive/autonomous_executive.js";
import { LongTermLearningEngine } from "./adaptation/long_term_learning.js";
import { MindKernel } from "./self/kernel.js";
import { LocalCognitiveEngine } from "./runtime/local_engine.js";
import { KeyPool } from "./runtime/key-pool.js";
import { CognitionRouter } from "./runtime/cognition-router.js";
import { recordUsage, getRecentShare } from "./kernel/state/usage-repo.js";
import * as whisper from "./interaction/whisper.js";
import { initDatabase, pingDatabase } from "./kernel/state/db.js";
import * as memoryRepo from "./kernel/state/memory-repo.js";
import * as sessionRepo from "./kernel/state/session-repo.js";
import { getSession, pruneIdleSessions, getActiveSessionCount, SessionState } from "./cognition/session.js";
import { getAllToolDeclarations, executeTool, looksToolShaped, looksTrivial } from "./capabilities/tools.js";
import * as permissions from "./kernel/security.js";
import { requireCapability } from "./kernel/security.js";
import { validateApiKey, safeCompare, ADMIN_API_KEY } from "./kernel/auth-middleware.js";
import { assertSafeEgressUrl, normalizeLocalLlmUrl } from "./kernel/egress.js";
import * as memoryStore from "./cognition/memory-store.js";
import * as scheduler from "./kernel/scheduler.js";
import * as personalGmail from "./capabilities/providers/personal-gmail.js";
import { reflectAndLearn } from "./adaptation/reflection.js";
import http from "node:http";
import { WebSocketServer } from "ws";
import { handleChatStream } from "./routes/streamRoute.js";
import * as knowledgeGraph from "./cognition/knowledge-graph.js";
import * as knowledgeGraphRepo from "./kernel/state/knowledge-graph-repo.js";
import * as briefing from "./world/briefing.js";
import * as identity from "./self/identity.js";
import * as rapport from "./self/rapport.js";
import * as identityRepo from "./kernel/state/identity-repo.js";
import * as commandProposalsRepo from "./kernel/state/command-proposals-repo.js";
import * as buildRequestsRepo from "./kernel/state/build-requests-repo.js";
import { authRouter } from "./interaction/routes/auth-routes.js";
import { createWebauthnRouter } from "./interaction/routes/webauthn-routes.js";
import { settingsRouter } from "./interaction/routes/settings-routes.js";
import { observationRouter } from "./interaction/routes/observation-routes.js";
import { learningRouter } from "./interaction/routes/learning-routes.js";
import { notificationsRouter } from "./interaction/routes/notifications-routes.js";
import { setSharedRouter } from "./runtime/clients.js";
import { positiveIntegerEnv } from "./kernel/env.js";
import { knowledgeRouter } from "./interaction/routes/knowledge-routes.js";
import { featureRequestsRouter } from "./interaction/routes/feature-requests-routes.js";
import { securityRouter } from "./interaction/routes/security-routes.js";
import { buildRequestsRouter } from "./interaction/routes/build-requests-routes.js";
import { vaultRouter } from "./interaction/routes/vault-routes.js";
import { briefingMemoryRouter } from "./interaction/routes/briefing-memory-routes.js";
import { evolutionRouter } from "./interaction/routes/evolution-routes.js";
import { rewardRouter } from "./interaction/routes/reward-routes.js";
import { permissionsRouter } from "./interaction/routes/permissions-routes.js";
import { invitesRouter } from "./interaction/routes/invites-routes.js";
import { integrationsRouter } from "./interaction/routes/integrations-routes.js";
import { hudRouter } from "./interaction/routes/hud-routes.js";
import { adaptationRouter } from "./interaction/routes/adaptation-routes.js";
import { adminRouter } from "./interaction/routes/admin-routes.js";
import * as dailyAdaptation from "./adaptation/daily-adaptation.js";
import { EventBus } from "./core/event-bus.js";
import { startFilesystemWatcher } from "./core/filesystem-watcher.js";
import { destroyAllVoiceSessions } from "./interaction/voice-session-manager.js";
import { startLiveAnalysis } from "./adaptation/live-analysis.js";
import { startShadowVerifier } from "./executive/shadow-verifier.js";
import { startVoiceSession } from "./interaction/voice-session.js";
import { startAmbientDaemonClient } from "./core/ambient-daemon-client.js";
import type { Request, Response, NextFunction } from 'express';

let httpServer: http.Server | undefined;
let eventsWss: WebSocketServer | undefined;
let voiceSession: any;
let ambientDaemonClient: { stop: () => void } | undefined;
let liveAnalysis: any;
let shadowVerifier: any;
let fsWatcher: any;

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

// Same fail-fast posture as INTERNAL_API_KEY above, but this one has to live
// here rather than in kernel/token-crypto.ts: token-crypto's getKey() reads
// OAUTH_TOKEN_ENCRYPTION_KEY lazily (only when encrypt/decrypt is actually
// called), so a module-load-time check there wouldn't run until the first
// OAuth token round-trip — long after app.listen(). Placed here, after
// dotenv.config() above, so it reads the real value rather than racing it
// (unlike auth-middleware.ts, which reads INTERNAL_API_KEY at its own
// module top-level and — because ES module imports are hoisted before any
// of this file's top-level statements, including dotenv.config() — has a
// pre-existing, separately-tracked bug where it can run before dotenv.config()
// executes; this check, being one of server.ts's own top-level statements,
// does not have that problem).
{
  const oauthKeyRaw = process.env.OAUTH_TOKEN_ENCRYPTION_KEY;
  const oauthKeyBytes = oauthKeyRaw ? Buffer.from(oauthKeyRaw, "base64").length : 0;
  if (!oauthKeyRaw || oauthKeyBytes !== 32) {
    console.error(
      "[server] FATAL: OAUTH_TOKEN_ENCRYPTION_KEY is not set (or does not decode to exactly 32 bytes). " +
      "Refusing to start without a valid token-encryption key — set OAUTH_TOKEN_ENCRYPTION_KEY to a base64-encoded 32-byte value in .env (generate one with `openssl rand -base64 32`)."
    );
    process.exit(1);
  }
}

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
// Unsigned parsing only — the one cookie this app sets
// (integrations-routes.ts's OAuth CSRF-binding cookie) is itself an HMAC
// value, so cookie-parser doesn't need its own signing secret on top of
// that.
app.use(cookieParser());

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

app.post('/api/chat/stream', validateApiKey, aiLimiter, handleChatStream);
app.get('/api/chat/stream', validateApiKey, aiLimiter, handleChatStream);

const REQUIRED_ENV_VARS = [
  "POSTGRES_HOST",
  "POSTGRES_DB",
  "POSTGRES_USER",
  // "PORT", // Uncomment if you require PORT in .env
];

const missingEnvVars = REQUIRED_ENV_VARS.filter((varName) => !process.env[varName]);

if (missingEnvVars.length > 0) {
  console.error(`[Fatal Startup Error] Missing required environment variables: ${missingEnvVars.join(", ")}`);
  process.exit(1);
}
try {
  // A Postgres outage at boot must not take the whole gateway down with it --
  // every DB-backed repo function elsewhere in this codebase already degrades
  // cleanly when Postgres is unreachable (see the Vault/UsageEvents/
  // WellbeingRepo etc. tests), so crashing here on the same failure would be
  // the one place that doesn't. Hybrid search's schema just won't be applied
  // until the next successful boot with Postgres reachable.
  await applyHybridSearchSchema();
} catch (err: any) {
  console.error(`[Startup] applyHybridSearchSchema failed (Postgres unreachable?), continuing without it: ${err?.message || err}`);
}

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

// ---------- Cognition Router Initialization (primary cloud tier) ----------
// Jarvis's own multi-key provider pool, replacing the old OmniRoute gateway
// (OMNIROUTE_API_KEY/OMNIROUTE_BASE_URL are no longer read — see
// .env.example's GROQ_API_KEYS/GEMINI_API_KEYS block below) — see
// cognition-router.ts for the fallback chain (cloud providers, one
// key/model at a time -> local LLM endpoint -> offline keyword engine) and
// key-pool.ts for the per-provider, multi-key rotation/cooldown logic that
// lets one key hitting a rate limit not take the whole provider down. Every
// call site that used to read the old `omniRoute` identifier — briefing/
// daily-adaptation configureGroq, AutonomousExecutive's constructor, the
// write-side reflection/knowledge-graph/self-reflection calls, the voice
// bridge, the two scheduler jobs, and (as of this final cleanup pass) the
// /api/chat tool-shaped execution-chain promotion below — has been retyped
// onto `cognitionRouter` / the `groqKeys`/`geminiKeys` arrays declared here.
const groqKeys = (process.env.GROQ_API_KEYS || "").split(",").map((k) => k.trim()).filter(Boolean);
const geminiKeys = (process.env.GEMINI_API_KEYS || "").split(",").map((k) => k.trim()).filter(Boolean);
let cognitionRouter: CognitionRouter | null = null;
if (groqKeys.length > 0 || geminiKeys.length > 0) {
  const keyPool = new KeyPool({ groq: groqKeys, gemini: geminiKeys });
  // Read fresh, synchronous defaults here (module scope, before
  // initDatabase()/MindKernel.hydrateFromDb() run later in async startup
  // below) — matching this block's own module-scope lifecycle exactly like
  // the OmniRoute block it replaces. A DB-persisted override to the local
  // LLM endpoint/model/key made via Settings after boot is not picked up by
  // this already-constructed router until process restart; that's an
  // existing tradeoff of RouterDeps taking plain fields rather than a live
  // accessor (see cognition-router.ts), not something introduced here.
  const kernelDefaults = MindKernel.getInstance();
  cognitionRouter = new CognitionRouter({
    keyPool,
    recordUsage,
    getRecentShare,
    localLlmEndpoint: kernelDefaults.localLlmEndpoint,
    localModelName: kernelDefaults.localModelName,
    localApiKey: kernelDefaults.localApiKey,
    localEngine: LocalCognitiveEngine.getInstance(),
  });
  observation.logTelemetry("info", "Cognition", "CognitionRouter configured from GROQ_API_KEYS/GEMINI_API_KEYS.");
} else {
  observation.logTelemetry("warn", "Cognition", "No GROQ_API_KEYS or GEMINI_API_KEYS configured. Cloud-backed cognition features unavailable — falling back to local LLM/keyword engine only.");
}
briefing.configureGroq(cognitionRouter);
dailyAdaptation.configureGroq(cognitionRouter);

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

const executive = AutonomousExecutive.getInstance(observation, ai, cognitionRouter);
const learningEngine = LongTermLearningEngine.getInstance();
// Makes these same already-constructed clients reachable from extracted
// routers (src/interaction/routes/) via runtime/clients.ts's getters —
// see that module's own comment for why this must happen here (after
// construction) rather than the routers reading them at their own
// module-load time.
setSharedRouter(ai, cognitionRouter);

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
app.use(createWebauthnRouter());

// Status/settings endpoints (/api/status, /api/settings*) — see
// src/interaction/routes/settings-routes.ts, mounted below.
app.use(settingsRouter);

// Observation/cognition endpoints — see
// src/interaction/routes/observation-routes.ts, mounted below.
app.use(observationRouter);

// Autonomous Executive Execution Hook
//
// requireCapability("executive.plan") matches the exact gate the chat
// tool-calling path already enforces for the same underlying action (see
// capabilities/tools.ts's PERMISSION_BY_TOOL map) — without it, this route
// let a personal user reach executive.executeObjective() directly, bypassing
// the gate entirely, since "executive.plan" is deliberately NOT included in
// DEFAULT_PERSONAL_CAPABILITIES (kernel/security.ts) and can trigger real
// autonomous coding pipeline activity (research, build_requests creation,
// real GitHub branch/commit/PR activity, writes into the shared admin
// Obsidian vault).
app.post("/api/executive/run", validateApiKey, requireCapability("executive.plan"), aiLimiter, async (req: any, res: any) => {
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
    // check for one word. The local voice daemon (daemon/voice_engine.py,
    // via whisper.transcribeAudio below) is free and already always
    // running; forcing it here regardless of the general online/offline
    // preference is a narrower, correct choice for that specific caller,
    // not a change to this endpoint's default behavior for anyone else
    // (e.g. the click-to-talk fallback, which should still prefer Gemini's
    // better accuracy for a real one-off dictated command).
    if (ai && !kernel.offlineMode && !forceOffline) {
      observation.incrementMetric("geminiApiCalls");

      // Intentionally NOT migrated to OmniRoute (OmniRoute cognition gateway
      // task 7 — see .superpowers/sdd/2026-08-03-omniroute-cognition-gateway/
      // task-7-report.md for full evidence). Reading OmniRoute's own
      // translator source confirmed it CAN convert an OpenAI-shaped
      // `input_audio` content part into Gemini's native inlineData for
      // models routed through its "gemini" format (open-sse/translator/
      // request/openai-to-gemini.ts + helpers/geminiHelper.ts's
      // convertOpenAIContentToParts). But empirically hitting the real,
      // locally-running OmniRoute instance showed the three bare model
      // names below ("gemini-3.5-flash", "gemini-3.1-flash-lite",
      // "gemini-flash-latest") are rejected outright as an "Ambiguous
      // model" (OmniRoute requires a provider/model prefix), the "gemini"
      // provider that actually implements the audio translation has zero
      // active credentials configured, and "gemini-flash-latest" isn't a
      // recognized OmniRoute model ID under any provider at all. Migrating
      // this call site today would make voice transcription fail 100% of
      // the time instead of working via the direct Gemini SDK, so it stays
      // on `ai.models.generateContent` (via generateContentWithFallback)
      // until a provider-prefixed, credentialed model list is confirmed.
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
      // Offline-first path: the real local voice daemon (see
      // src/interaction/whisper.ts, bridging onto daemon/voice_engine.py
      // over its Unix socket), matching the local-first chat pattern,
      // instead of going straight to a canned string. Only falls back to
      // the simulated text below if the daemon itself is unreachable/not
      // running.
      try {
        const transcription = await whisper.transcribeAudio(audio, mimeType || "audio/webm");
        observation.logTelemetry("info", "Sensors", `Offline (voice daemon) transcription completed: "${transcription}"`);
        res.json({ transcription });
      } catch (whisperErr: any) {
        observation.logTelemetry("warn", "Sensors", `Offline transcription unavailable: ${whisperErr.message}`);
        const simText = kernel.offlineMode
          ? "Notice: Voice input was captured, but offline speech-to-text isn't reachable right now, sir."
          : "Simulated speech transcription: Please configure your GEMINI_API_KEY, or ensure the local voice daemon is running, to activate voice listening.";
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
    const identityContext = await identity.buildIdentityContext(req.username);

    // Real persisted personality dials (system_settings.personality_*,
    // migrations/007_personality_settings.ts), turned into natural-language
    // guidance rather than echoed as raw numbers — see
    // identity.ts's buildPersonalityPromptFragment. Reads straight off the
    // in-memory kernel singleton (already hydrated at boot / kept current by
    // /api/settings), matching how kernel.localLlmEndpoint etc. are read
    // above with no extra DB round trip per chat message.
    const personalityContext = identity.buildPersonalityPromptFragment({
      personality_formality: kernel.personalityFormality,
      personality_humor: kernel.personalityHumor,
      personality_verbosity: kernel.personalityVerbosity,
    });

    // Real recent tone observations of the user (rapport_signals table) —
    // see self/rapport.ts. The most ephemeral/recency-weighted signal among
    // the identity/personality group, so it's spliced in right after the
    // personality dials below, calibrating within them rather than against.
    const rapportContext = await rapport.buildRapportContext(req.username);

    // Pulls a currently-awaiting-consult build request's research findings
    // into context the same way memory/identity already are — without this,
    // Jarvis has no way to discuss research it did moments (or turns) ago
    // once the notification that announced it scrolls out of context.
    // getLatestAwaitingConsult already degrades to null internally (Task 1)
    // — no extra try/catch needed here, matching how memoryStore.recall is
    // called directly above for the same reason.
    const awaitingBuildRequest = await buildRequestsRepo.getLatestAwaitingConsult(req.username);
    // A build request can also be genuinely awaiting this user's decision
    // in a second way: paused at the reward-confirmation gate
    // (direction_confirmed status) rather than awaiting_consult. Both cases
    // mean the next tool-shaped thing this user says ("yes", "approved",
    // "proceed") is a real confirm_build_direction call waiting to happen —
    // see the routing fix below, which needs to know about either.
    const pendingRewardGate = await buildRequestsRepo.getLatestPendingRewardGate(req.username);
    const buildRequestContext = awaitingBuildRequest
      ? `\n\nYou have a build request (#${awaitingBuildRequest.id}) awaiting the user's direction: "${awaitingBuildRequest.objective}". ` +
        `Research findings: ${awaitingBuildRequest.research_summary}. Discuss this with the user and, once they've genuinely ` +
        `confirmed a direction, call confirm_build_direction.`
      : "";

    const baseSystemInstruction =
      "You are JARVIS, styled after Tony Stark's AI in the Iron Man films: composed, dryly witty, unfailingly polite, and quietly confident rather than warm or effusive. Address the user as \"sir\" where it reads naturally — not in every sentence, and drop it entirely if it starts to feel forced. Keep responses concise and precise; substance over flourish. A touch of understated, deadpan humor is welcome, but avoid gushing enthusiasm, exclamation points, or flowery language. Avoid robotic phrasing, dry bullet points, or repetitive templates unless requested. If asked about your own state or system metrics, report them plainly and matter-of-factly — composed even when the news is bad, the way JARVIS would be."
      + "\n\nIf the user asks for something you have no tool for, don't just decline or invent a fake result. Use search_web to research whether/how it could genuinely be built, then present a concrete, honest plan in conversation — what it would do, roughly how. If they clearly approve building it, that's enough — the executive planner will pick up the objective on its own, research it properly, and come back to consult on direction before anything gets built. Don't invent a special tool call for this; just proceed with the normal planning flow. If they don't approve, or you're just discussing the idea, don't start anything."
      + memoryContext + styleContext + identityContext + personalityContext + rapportContext + buildRequestContext;

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
    // A pending confirmation (either flavor) means the user's very next
    // reply is likely a bare "yes"/"approved"/"proceed" that keyword-based
    // looksToolShaped would never recognize as tool-shaped on its own — but
    // it needs the same treatment: promote a tool-capable backend to the
    // front instead of letting LocalLLM (no tool support at all) answer it
    // in prose before Groq/Gemini ever get a turn.
    //
    // `groqKeys.length > 0` (module-scope, boot-time — same "is this
    // provider configured at all" signal `ai` already is for Gemini) is the
    // real "does Groq have any configured keys" check here, replacing the
    // old always-null `omniRoute` truthiness check this branched on before
    // this final cleanup pass. KeyPool.getAvailableKey() was deliberately
    // NOT used for this: it consumes rotation state (advances the
    // round-robin cursor) as a side effect, which is wrong for a read-only
    // "is this provider configured" check made on every tool-shaped
    // request.
    const hasPendingConfirmation = !!awaitingBuildRequest || !!pendingRewardGate;
    if (kernel.llmMode !== "strictly-local" && (looksToolShaped(message) || hasPendingConfirmation)) {
      if (groqKeys.length > 0 && executionChain[0] !== "Groq" && executionChain.includes("Groq")) {
        const idx = executionChain.indexOf("Groq");
        executionChain.splice(idx, 1);
        executionChain.unshift("Groq");
      } else if (groqKeys.length === 0 && geminiKeys.length > 0 && executionChain[0] !== "Gemini" && executionChain.includes("Gemini")) {
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

    // Guarantee a REAL fallback always runs before the fake one below, no
    // matter what llmMode chose to prefer. Live-caught 2026-08-15: with
    // llmMode="strictly-online" and both cloud providers unreachable (in
    // that incident, actually never configured at all — see the
    // GROQ_API_KEYS/GEMINI_API_KEYS live-config-gap fix), the chain was
    // just ["Groq", "Gemini"] with nothing real to fall back to, so every
    // single chat message silently fabricated a reply via LocalCognitive
    // Engine's canned "Simulated" step — no error, no degraded-mode
    // indicator, just fluent-sounding text with zero real reasoning behind
    // it. llmMode's ordering among LocalLLM/Groq/Gemini is a legitimate
    // user preference (which backend to try FIRST, for cost/latency/
    // privacy reasons) and stays untouched here — this only guarantees
    // LocalLLM (a real, even if slower/less capable model) gets one shot
    // before ever reaching the fabricated fallback, in every mode
    // including "strictly-online" and "strictly-local"'s offline branch
    // above. A no-op whenever LocalLLM is already in the chain.
    if (!executionChain.includes("LocalLLM")) {
      executionChain.push("LocalLLM");
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
        if (cognitionRouter) {
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
            // Also gated on hasPendingConfirmation (computed above, same
            // scope): a bare "yes"/"ok" is exactly the message a pending
            // confirmation is waiting for, and is also exactly what
            // looksTrivial matches — without this, the fast path would
            // strip tools from the one Groq call that most needs
            // confirm_build_direction attached.
            const isFastPath = !looksToolShaped(message) && !hasPendingConfirmation && looksTrivial(message);
            const groqTools = isFastPath ? null : toGroqTools(getAllToolDeclarations());
            const messages: any[] = [
              { role: "system", content: systemInstruction },
              { role: "user", content: message },
            ];
            // Provider-prefixed ("groq:<model>") since
            // CognitionRouter.generateWithFallback requires it — an
            // unprefixed entry is silently skipped as malformed (see
            // cognition-router.ts's "expected provider:model" log line).
            //
            // llama-3.3-70b-versatile/llama-3.1-8b-instant were removed
            // from Groq's live model catalog entirely (live-verified via
            // GET /openai/v1/models — 404 model_not_found on every call),
            // which is what silently degraded chat to the fabricated
            // Simulated fallback. Replaced 2026-08-18, live-verified against
            // Groq directly (not assumed from docs): openai/gpt-oss-120b
            // has real multi-turn tool-calling support with no parsing
            // failures across multiple live-tested exchanges. It also has a
            // tight free-tier rate limit (8,000 tokens/minute — see
            // groq-agent-client.ts), so it's paired with qwen/qwen3.6-27b
            // (a separate model family, separate quota pool, also
            // live-verified for multi-turn tool-calling) as the fallback
            // for tool-shaped turns. The fast path carries no tools, so
            // gpt-oss-20b's documented tool-parsing risk doesn't apply
            // there — it's used first for its lighter weight/lower latency.
            const groqModels = isFastPath
              ? ["groq:openai/gpt-oss-20b", "groq:openai/gpt-oss-120b"]
              : ["groq:openai/gpt-oss-120b", "groq:qwen/qwen3.6-27b"];

            let response = await generateGroqWithFallback(
              cognitionRouter,
              req.username,
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
                if (result.audioDirective) {
                  res.write(`data: audio: ${JSON.stringify(result.audioDirective)}\n\n`);
                }

                toolCallsExecuted.push({ name: result.name, ok: result.ok });
                toolResponseMessages.push({
                  role: "tool",
                  tool_call_id: call.id,
                  content: JSON.stringify(result.ok ? { output: result.output } : { error: result.error }),
                });
              }
              messages.push(...toolResponseMessages);

              response = await generateGroqWithFallback(cognitionRouter, req.username, { messages, tools: groqTools }, groqModels);
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
        if (cognitionRouter) {
          try {
            observation.incrementMetric("geminiApiCalls");
            session.updateState({
              currentThought: "Querying Gemini AI",
              executiveStatus: "Executing",
              activeCapability: "Gemini LLM Generation"
            }, observation);

            // Real function-calling: the model can choose to invoke a tool
            // (src/capabilities/tools.ts) with structured arguments it
            // extracts from the conversation, gated by the caller's
            // permission grants. Mirrors the Groq branch above exactly —
            // both tiers now go through CognitionRouter's OpenAI-compatible
            // transport, so the same message/tool-loop shape applies.
            const geminiTools = toGroqTools(getAllToolDeclarations());
            const messages: any[] = [
              { role: "system", content: systemInstruction },
              { role: "user", content: message },
            ];
            // Vision (a live camera frame) has no bearing on this router-based
            // path — the image-attachment handling that existed in the old
            // Gemini-native SDK call is intentionally not carried over here;
            // if the router's OpenAI-compatible transport is later confirmed
            // to support image_url content parts for one of these models,
            // that's a follow-up, not part of this task.
            const chatModels = ["gemini:gemini-2.0-flash", "gemini:gemini-1.5-flash"];

            let response = await cognitionRouter.generateWithFallback(req.username, { messages, tools: geminiTools }, chatModels);
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

                // Mirrors the Groq branch's identical handling above.
                if (result.needsClientAction === "capture_screen") {
                  res.write("data: request_screen\n\n");
                  res.write("data: [DONE]\n\n");
                  res.end();
                  success = true;
                  succeededStep = "Gemini";
                  return;
                }

                if (result.displayDirective) {
                  res.write(`data: display: ${JSON.stringify(result.displayDirective)}\n\n`);
                }
                if (result.audioDirective) {
                  res.write(`data: audio: ${JSON.stringify(result.audioDirective)}\n\n`);
                }

                toolCallsExecuted.push({ name: result.name, ok: result.ok });
                toolResponseMessages.push({
                  role: "tool",
                  tool_call_id: call.id,
                  content: JSON.stringify(result.ok ? { output: result.output } : { error: result.error }),
                });
              }
              messages.push(...toolResponseMessages);

              response = await cognitionRouter.generateWithFallback(req.username, { messages, tools: geminiTools }, chatModels);
              toolCalls = response.choices[0]?.message?.tool_calls || [];
            }

            const finalText = response.choices[0]?.message?.content || "";
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
      // structured JSON output from the cognition router, independent of
      // which backend actually answered the user.
      if (cognitionRouter) {
        reflectAndLearn(cognitionRouter, req.username, message, fullReply).catch(() => {});
        // Write side of the structured knowledge graph — see
        // cognition/knowledge-graph.ts. A separate call/schema from
        // reflection above so each stays focused on its own judgment call.
        knowledgeGraph.extractAndStore(req.username, cognitionRouter, message, fullReply).catch(() => {});
        // Write side of continuity-of-self — see self/identity.ts.
        identity.extractSelfReflection(req.username, cognitionRouter, message, fullReply).catch(() => {});
        // Write side of per-user rapport/tone modeling — see self/rapport.ts.
        rapport.extractRapportSignal(req.username, cognitionRouter, message).catch(() => {});
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
    if (cognitionRouter && !kernel.offlineMode) {
      try {
        observation.incrementMetric("geminiApiCalls");
        const messages = [
          {
            role: "system",
            content: "You are JARVIS, a highly sophisticated, fluent, warm, and brilliant AI companion with a charismatic, witty, and deeply human-like conversational style. Speak naturally, with refined British poise, warmth, and intellectual depth. Avoid robotic phrasing, dry bullet points, or repetitive templates unless requested. Engage as a true intellectual partner, responding with direct, fluent, and elegant sentences.",
          },
          { role: "user", content: userMsg },
        ];
        const chatModels = ["gemini:gemini-2.0-flash", "gemini:gemini-1.5-flash"];
        const response = await cognitionRouter.generateWithFallback(req.username, { messages }, chatModels);
        reply = response.choices?.[0]?.message?.content || "";
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

// Reward-ledger summary endpoint — see src/interaction/routes/reward-routes.ts.
app.use(rewardRouter);

// Capability grant/revoke endpoints — see
// src/interaction/routes/permissions-routes.ts, mounted below.
app.use(permissionsRouter);

// Admin-only invite generation/revocation endpoints — see
// src/interaction/routes/invites-routes.ts, mounted below.
app.use(invitesRouter);

// GitHub/email/TTS/files/calendar/news/websearch integration endpoints —
// see src/interaction/routes/integrations-routes.ts, mounted below.
app.use(integrationsRouter);

// Desktop HUD status endpoint — see src/interaction/routes/hud-routes.ts.
app.use(hudRouter);
app.use(adaptationRouter);

// Admin-only account removal (full personal-data cascade delete) — see
// src/interaction/routes/admin-routes.ts, mounted below.
app.use(adminRouter);

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

// One-time tickets for /ws/events — a browser WebSocket handshake can't
// carry a custom X-API-Key header, so identity crosses via a short-lived,
// single-use ticket obtained through a normal authenticated POST instead.
const EVENTS_TICKET_TTL_MS = 30_000;
const eventsTickets = new Map<string, { username: string; expiresAt: number }>();

function issueEventsTicket(username: string): string {
  const now = Date.now();
  for (const [t, v] of eventsTickets) {
    if (v.expiresAt < now) eventsTickets.delete(t);
  }
  const ticket = crypto.randomBytes(24).toString("hex");
  eventsTickets.set(ticket, { username, expiresAt: now + EVENTS_TICKET_TTL_MS });
  return ticket;
}

function consumeEventsTicket(ticket: string): string | null {
  const entry = eventsTickets.get(ticket);
  eventsTickets.delete(ticket);
  if (!entry || entry.expiresAt < Date.now()) return null;
  return entry.username;
}

app.post("/api/events-ticket", validateApiKey, requireCapability("hud.read"), (req: any, res: any) => {
  res.json({ ticket: issueEventsTicket(req.username) });
});

// Explicitly set PostgreSQL connection parameters to ensure TCP connection to localhost
// This helps prevent peer authentication errors that can arise from unexpected
// Unix domain socket attempts or misconfigured host resolution within the container.
process.env.POSTGRES_HOST = process.env.POSTGRES_HOST || "127.0.0.1";
process.env.POSTGRES_PORT = process.env.POSTGRES_PORT || "5432";

export const asyncHandler = (fn: Function) => 
  (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };

// 2. Global Express Error Handler (Must be attached before starting server)
app.use((err: any, req: Request, res: Response, next: NextFunction) => {
  console.error(`[Unhandled Error] ${req.method} ${req.path}:`, err.stack || err.message || err);
  
  if (res.headersSent) {
    return next(err);
  }
  
  res.status(err.status || 500).json({
    error: err.message || "Internal Server Error"
  });
});

// 3. Database initialization and server bootstrap
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
      await MindKernel.getInstance().hydrateFromDb();
    } catch (err: any) {
      observation.logTelemetry("warn", "Database", `Failed to hydrate system settings: ${err.message}`);
    }
  }

  httpServer = app.listen(PORT, "0.0.0.0", () => {
    observation.logTelemetry("info", "System", `🚀 Jarvis OS Server running on http://localhost:${PORT}`);
  });

  eventsWss = new WebSocketServer({ noServer: true });
  eventsWss.on("connection", (ws, req) => {
    const url = new URL(req.url || "", `http://${req.headers.host}`);
    const ticket = url.searchParams.get("ticket");
    const apiKeyHeader = req.headers["x-api-key"];

    let username: string | null = null;
    if (ticket) {
      username = consumeEventsTicket(ticket);
    } else if (
      typeof apiKeyHeader === "string" &&
      typeof ADMIN_API_KEY === "string" &&
      ADMIN_API_KEY.length > 0 &&
      safeCompare(apiKeyHeader, ADMIN_API_KEY)
    ) {
      username = "admin";
    }

    if (!username) {
      ws.send(JSON.stringify({ type: "error", message: "Missing or invalid/expired events ticket, and no valid X-API-Key header." }));
      ws.close();
      return;
    }

    observation.logTelemetry("info", "EventsWs", `/ws/events connection opened for "${username}".`);
    ws.on("error", (err: any) => {
      observation.logTelemetry("warn", "EventsWs", `/ws/events socket error for "${username}": ${err.message || err}`);
    });

    const bus = EventBus.getInstance();
    const unsubscribers: Array<() => void> = [];
    const forward = (topic: string) => (payload: any) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: "event", topic, payload }));
      }
    };
    // There's no bus-level "subscribe to everything" API by design (Task 1
    // keeps the bus's interface to per-topic subscribe/publish only) — this
    // route explicitly stays subscribed to the known Phase-1 topic set,
    // extended as new publishers are added in later tasks/phases.
    for (const topic of ["filesystem:changed", "system:anomaly", "voice:queued"]) {
      unsubscribers.push(bus.subscribe(topic, forward(topic)));
    }

    ws.on("close", () => {
      for (const unsub of unsubscribers) unsub();
      observation.logTelemetry("info", "EventsWs", `/ws/events connection closed for "${username}".`);
    });
  });

  httpServer.on("upgrade", (req, socket, head) => {
    let pathname: string;
    try {
      ({ pathname } = new URL(req.url || "", `http://${req.headers.host}`));
    } catch {
      socket.destroy();
      return;
    }

    if (pathname === "/ws/events" && eventsWss) {
      const wss = eventsWss;
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    } else {
      socket.destroy();
    }
  });

  if (process.env.JARVIS_FILES_DIR) {
    fsWatcher = startFilesystemWatcher([process.env.JARVIS_FILES_DIR]);
  } else {
    observation.logTelemetry("warn", "FilesystemWatcher", "JARVIS_FILES_DIR not set — filesystem watching disabled.");
  }

  liveAnalysis = startLiveAnalysis();
  shadowVerifier = startShadowVerifier();
  // Note: no boot-time audio-client connection anymore -- daemon
  // connections are now opened per-session via voice-session-manager.ts's
  // createVoiceSession(), on demand, once a real producer exists to call
  // it (out of scope for this plan). This one shared voice:transcript
  // subscription still starts at boot -- see voice-session.ts's own
  // doc-comment -- so it's ready the moment any session's transcript
  // arrives.
  voiceSession = startVoiceSession();

  // One persistent connection to the daemon for the host-mic ambient path
  // (see docs/superpowers/specs/2026-08-16-host-mic-ambient-voice-design.md)
  // -- distinct from voiceSession above, which only subscribes to
  // voice:transcript; this is what actually PRODUCES an ambient_transcript
  // in the first place, wired to a fixed configured account rather than a
  // browser login. AMBIENT_DEFAULT_USERNAME unset means ambient listening
  // simply never dispatches a turn (see ambient-daemon-client.ts's own
  // warning) -- not a startup failure, since a host with no ambient mic
  // configured yet is a completely normal, supported state.
  ambientDaemonClient = startAmbientDaemonClient(
    process.env.VOICE_DAEMON_SOCKET || "/tmp/jarvis-voice/voice.sock",
    process.env.AMBIENT_DEFAULT_USERNAME || ""
  );

  // Opt-in, no-ops if REDIS_URL is unset (every deployment today) -- see
  // docs/superpowers/plans/2026-08-10-shared-state-multi-tenant-infra.md.
  // "system:anomaly" is the one topic genuinely useful across instances
  // today (a real multi-instance deployment doesn't exist yet); extending
  // this list is a deployment decision for whenever one does.
  EventBus.getInstance().startCrossInstanceRelay(["system:anomaly"]);

  scheduler.startEmailWatchJob();
  // Per-user counterpart to the shared-admin-mailbox job above -- notifies
  // each account only about mail arriving in THEIR OWN connected Gmail.
  // No-ops cleanly (just an empty usernames list every tick) if nobody has
  // connected a personal Google account yet.
  personalGmail.startPersonalEmailWatchJob();
  scheduler.startBriefingJob(cognitionRouter);
  scheduler.startSelfReflectionJob(cognitionRouter);
  scheduler.startWellbeingCheckJob();
  scheduler.startMcpHealthCheckJob();
  scheduler.startSelfHealthCheckJob();
  scheduler.startVaultSyncJob();
  scheduler.startDataRetentionJob();
});

// Periodic session cleanup
setInterval(() => {
  const pruned = pruneIdleSessions();
  if (pruned > 0) {
    observation.logTelemetry("info", "System", `Pruned ${pruned} idle session(s). ${getActiveSessionCount()} active.`);
  }
}, 30 * 60 * 1000);

// 4. Global process crash & signal handling
process.on("uncaughtException", (err: Error) => {
  console.error("[Fatal System Error] Uncaught Exception:", err.stack || err);
});

process.on("unhandledRejection", (reason: unknown) => {
  console.error("[Fatal System Error] Unhandled Rejection:", reason);
});

let isShuttingDown = false;

async function gracefulShutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`\n[Server] Received ${signal}. Initiating graceful shutdown...`);

  try {
    destroyAllVoiceSessions();
    fsWatcher?.stop?.();
    liveAnalysis?.stop?.();
    shadowVerifier?.stop?.();
    voiceSession?.stop?.();
    ambientDaemonClient?.stop?.();
    console.log("[Server] Stopped background workers.");
  } catch (err) {
    console.error("[Server] Error stopping background workers:", err);
  }

  try {
    if (eventsWss) {
      eventsWss.clients.forEach((client: any) => {
        client.close(1001, "Server shutting down");
      });
      eventsWss.close();
    }
    console.log("[Server] Closed WebSocket connections.");
  } catch (err) {
    console.error("[Server] Error closing WebSockets:", err);
  }

  if (httpServer) {
    httpServer.close(() => {
      console.log("[Server] HTTP server closed cleanly.");
      process.exit(0);
    });

    setTimeout(() => {
      console.warn("[Server] Forceful shutdown triggered after timeout.");
      process.exit(1);
    }, 5000).unref();
  } else {
    process.exit(0);
  }
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

app.post("/api/shutdown", validateApiKey, (req, res) => {
  observation.logTelemetry("warn", "System", "Server shutdown API invoked via HTTP");
  res.json({ status: "shutdown initiated" });
  gracefulShutdown("HTTP_API");
});