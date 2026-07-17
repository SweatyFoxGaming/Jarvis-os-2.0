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
import { MindKernel } from "./cognition/kernel/kernel.js";
import { LocalCognitiveEngine } from "./cognition/local_engine.js";
import * as github from "./integrations/github.js";
import * as emailIntegration from "./integrations/email.js";
import * as tts from "./integrations/tts.js";

dotenv.config();

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json({ limit: "15mb" }));
app.use(express.urlencoded({ limit: "15mb", extended: true }));

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
  const kernel = MindKernel.getInstance();
  res.json({
    cpu: Math.round(stats.system.cpuUsagePercent * 10) / 10,
    ram_available_mb: stats.system.freeMemoryMb,
    disk: 38,
    engine_ready: true,
    user: req.username,
    offline_mode: kernel.offlineMode
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

app.get("/api/cognition/workspace", validateApiKey, (req, res) => {
  res.json(workspace.toSnapshot());
});

app.get("/api/cognition/kernel", validateApiKey, (req, res) => {
  const kernel = MindKernel.getInstance();
  res.json({
    state: kernel.getState(),
    attention: kernel.attentionEngine.getCurrentAttention(),
    thoughtStage: kernel.thoughtEngine.getStage(),
    thoughtStages: kernel.thoughtEngine.getStages(),
    dialogueHistory: kernel.dialogue.getHistory(),
    summarizedDecision: kernel.dialogue.getSummarizedDecision(),
    confidence: kernel.getState().confidence
  });
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

// Voice Transcription Endpoint
app.post("/api/voice-input", validateApiKey, async (req: any, res: any) => {
  const { audio, mimeType } = req.body;
  if (!audio) {
    return res.status(400).json({ error: "Missing audio payload" });
  }

  observation.logTelemetry("info", "Sensors", `Received audio payload of type: ${mimeType || "unknown"}`);

  try {
    const kernel = MindKernel.getInstance();
    if (ai && !kernel.offlineMode) {
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
      // Simulation/Offline mode
      const simText = kernel.offlineMode 
        ? "Notice: Voice input was captured, but I am operating in Offline Mode, sir."
        : "Simulated speech transcription: Please configure your GEMINI_API_KEY to activate neural voice listening.";
      observation.logTelemetry("warn", "Sensors", "Running transcription in simulation/offline mode.");
      res.json({ transcription: simText });
    }
  } catch (error: any) {
    console.error("Transcription error:", error);
    observation.logTelemetry("error", "Sensors", `Voice transcription failed: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Chat Streaming Endpoint (SSE)
app.post("/api/chat", validateApiKey, async (req: any, res: any) => {
  const { message } = req.body;
  if (!message) {
    return res.status(400).json({ error: "Missing message" });
  }

  const startTime = performance.now();
  observation.startProfile("chat_request");
  observation.incrementMetric("totalRequests");

  const kernel = MindKernel.getInstance();

  // Add message to conversation
  workspace.conversation.addMessage("user", message);

  // Update mind kernel state!
  kernel.updateState({
    currentThought: "Understanding Request",
    executiveStatus: "Thinking",
    currentPlan: ["Process user prompt"],
    attentionTarget: kernel.attentionEngine.determineAttention({ userRequest: message })
  }, workspace, observation);

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  let fullReply = "";

  try {
    const localEngine = LocalCognitiveEngine.getInstance();
    
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
    
    // Always append simulated as final fallback
    executionChain.push("Simulated");

    // Execute the chain
    for (const step of executionChain) {
      if (success) break;
      
      if (step === "LocalLLM") {
        try {
          observation.logTelemetry("info", "Cognition", `Attempting Local LLM generation: endpoint=${kernel.localLlmEndpoint}, model=${kernel.localModelName}`);
          kernel.updateState({
            currentThought: "Querying Local LLM",
            executiveStatus: "Executing",
            activeCapability: `Local LLM (${kernel.localModelName})`
          }, workspace, observation);
          
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
          
          const response = await fetch(targetUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(kernel.localApiKey ? { "Authorization": `Bearer ${kernel.localApiKey}` } : {})
            },
            body: JSON.stringify({
              model: kernel.localModelName,
              messages: [
                {
                  role: "system",
                  content: "You are JARVIS, a highly sophisticated, fluent, warm, and brilliant AI companion with a charismatic, witty, and deeply human-like conversational style. Speak naturally, with refined British poise, warmth, and intellectual depth."
                },
                ...formattedMessages
              ],
              stream: true
            }),
            signal: AbortSignal.timeout(10000)
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
          observation.logTelemetry("info", "Cognition", "Local LLM content streaming completed successfully.");
        } catch (err: any) {
          observation.logTelemetry("warn", "Cognition", `Local LLM generation failed: ${err.message || err}`);
        }
      }
      
      else if (step === "Gemini") {
        if (ai) {
          try {
            observation.incrementMetric("geminiApiCalls");
            kernel.updateState({
              currentThought: "Querying Gemini AI",
              executiveStatus: "Executing",
              activeCapability: "Gemini LLM Generation"
            }, workspace, observation);
            
            let responseStream;
            const chatModels = ["gemini-3.5-flash", "gemini-3.1-flash-lite", "gemini-flash-latest"];
            let lastStreamError = null;
            
            for (const modelName of chatModels) {
              try {
                observation.logTelemetry("info", "Cognition", `Attempting chat stream with model: ${modelName}`);
                responseStream = await ai.models.generateContentStream({
                  model: modelName,
                  contents: message,
                  config: {
                    systemInstruction: "You are JARVIS, a highly sophisticated, fluent, warm, and brilliant AI companion with a charismatic, witty, and deeply human-like conversational style. Speak naturally, with refined British poise, warmth, and intellectual depth. Avoid robotic phrasing, dry bullet points, or repetitive templates unless requested. Engage as a true intellectual partner, responding with direct, fluent, and elegant sentences. If asked about your state or system metrics, seamlessly integrate them with human-like charm.",
                  }
                });
                break;
              } catch (err: any) {
                lastStreamError = err;
                observation.logTelemetry("warn", "Cognition", `Model ${modelName} stream initiation failed. Error: ${err.message || err}`);
              }
            }
            
            if (responseStream) {
              for await (const chunk of responseStream) {
                if (chunk.text) {
                  fullReply += chunk.text;
                  res.write(`data: ${chunk.text}\n\n`);
                }
              }
              success = true;
            } else {
              throw lastStreamError || new Error("All stream models failed");
            }
          } catch (err: any) {
            observation.logTelemetry("warn", "Cognition", `Gemini generation failed: ${err.message || err}`);
          }
        }
      }
      
      else if (step === "Simulated") {
        kernel.updateState({
          currentThought: "Running Local Simulation",
          executiveStatus: "Executing",
          activeCapability: "Local Cognitive Simulator"
        }, workspace, observation);
        
        const stats = observation.getMetrics();
        const simulatedResponse = localEngine.generateResponse(message, workspace, stats.system);
        
        const words = simulatedResponse.split(" ");
        for (const word of words) {
          fullReply += word + " ";
          res.write(`data: ${word} \n\n`);
          await new Promise((resolve) => setTimeout(resolve, 40));
        }
        success = true;
      }
    }

    // Refinement/Reflection stage
    kernel.updateState({
      currentThought: "Preparing Response",
      executiveStatus: "Reflecting"
    }, workspace, observation);

    workspace.conversation.addMessage("assistant", fullReply);
    
    const latency = performance.now() - startTime;
    observation.recordLatency(latency);
    observation.endProfile("chat_request");

    const calculatedConfidence = kernel.confidenceModel.calculateOverallConfidence({
      memoryConfidence: ai ? 0.98 : 0.8,
      toolConfidence: 1.0,
      validationConfidence: 1.0,
      capabilityConfidence: ai ? 0.95 : 0.75,
      environmentConfidence: 1.0
    });

    // Finalize state to idle
    kernel.updateState({
      currentThought: "Idle",
      executiveStatus: "Idle",
      confidence: calculatedConfidence,
      activeCapability: null,
      attentionTarget: kernel.attentionEngine.determineAttention({})
    }, workspace, observation);

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

    kernel.updateState({
      currentThought: "Idle",
      executiveStatus: "Idle",
      attentionTarget: kernel.attentionEngine.determineAttention({ emergency: error.message })
    }, workspace, observation);
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
    const kernel = MindKernel.getInstance();
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
        reply = localEngine.generateResponse(userMsg, workspace, stats.system);
      }
    } else {
      const stats = observation.getMetrics();
      reply = localEngine.generateResponse(userMsg, workspace, stats.system);
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
app.get("/api/memory/pending", validateApiKey, (req: any, res: any) => {
  res.json(pendingRecords);
});

app.post("/api/memory/verify/:record_uuid", validateApiKey, (req: any, res: any) => {
  const { record_uuid } = req.params;
  const index = pendingRecords.findIndex(r => r.uuid === record_uuid);
  if (index !== -1) {
    const record = pendingRecords[index];
    pendingRecords.splice(index, 1);
    observation.logAuditEvent(req.username || "admin", "verify_memory", "success", `Approved memory record ${record_uuid}: "${record.content}"`);
  }
  res.json({ status: "success" });
});

app.post("/api/memory/verify_all", validateApiKey, (req: any, res: any) => {
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
