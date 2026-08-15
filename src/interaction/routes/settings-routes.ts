import { Router } from 'express';
import { ObservationPlatform } from "../../kernel/observation.js";
import { MindKernel } from "../../self/kernel.js";
import { getActiveSessionCount } from "../../cognition/session.js";
import { validateApiKey } from "../../kernel/auth-middleware.js";
import { requireCapability } from "../../kernel/security.js";
import { assertSafeEgressUrl, normalizeLocalLlmUrl } from "../../kernel/egress.js";
import type { SystemSettingsUpdate } from "../../kernel/state/system-settings-repo.js";

const observation = ObservationPlatform.getInstance();

export const settingsRouter: Router = Router();

// Status & Diagnostics
settingsRouter.get("/api/status", validateApiKey, (req: any, res: any) => {
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

settingsRouter.get("/api/settings/offline", validateApiKey, (req: any, res: any) => {
  const kernel = MindKernel.getInstance();
  res.json({ offline: kernel.offlineMode });
});

settingsRouter.post("/api/settings/offline", validateApiKey, requireCapability("settings.write"), async (req: any, res: any) => {
  const { offline } = req.body;
  const kernel = MindKernel.getInstance();
  kernel.offlineMode = !!offline;
  // Only this one field, not a snapshot of every kernel.* value — see
  // persistSettings' own comment on why a full snapshot can lose a
  // concurrent request's change.
  const persisted = await kernel.persistSettings(req.username, { offlineMode: kernel.offlineMode });
  observation.logTelemetry("info", "System", `Offline Mode changed to: ${kernel.offlineMode}`);
  observation.logAuditEvent(
    req.username,
    "update_settings",
    persisted ? "success" : "failed",
    `offline_mode -> ${kernel.offlineMode}${persisted ? "" : " (in effect for this session — persistence failed, will revert on restart)"}`
  );
  res.json({ status: "success", offline: kernel.offlineMode, persisted });
});

settingsRouter.get("/api/settings", validateApiKey, requireCapability("settings.write"), (req: any, res: any) => {
  const kernel = MindKernel.getInstance();
  res.json({
    offline: kernel.offlineMode,
    localLlmEndpoint: kernel.localLlmEndpoint,
    localModelName: kernel.localModelName,
    // Never echo the raw key back — this used to leak the local LLM's
    // bearer credential to any authenticated user who could read this
    // endpoint. A boolean is all a settings UI actually needs to render
    // "configured" vs "not configured".
    localApiKeySet: !!kernel.localApiKey,
    llmMode: kernel.llmMode,
    personalityFormality: kernel.personalityFormality,
    personalityHumor: kernel.personalityHumor,
    personalityVerbosity: kernel.personalityVerbosity
  });
});

// Each of these directly steers real LLM calls via identity.ts's
// buildPersonalityPromptFragment — an out-of-range value isn't just a
// display glitch, it's a value that function has no defined phrasing band
// for, so it gets checked explicitly here rather than relying on the
// COALESCE-based repo layer (which has no range precedent to follow; the
// existing 5 fields are strings/booleans with nothing to range-check).
function isValidPersonalityDial(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100;
}

settingsRouter.post("/api/settings", validateApiKey, requireCapability("settings.write"), async (req: any, res: any) => {
  const { offline, localLlmEndpoint, localModelName, localApiKey, llmMode, personalityFormality, personalityHumor, personalityVerbosity } = req.body;
  const kernel = MindKernel.getInstance();

  for (const [name, value] of [
    ["personalityFormality", personalityFormality],
    ["personalityHumor", personalityHumor],
    ["personalityVerbosity", personalityVerbosity],
  ] as const) {
    if (value !== undefined && !isValidPersonalityDial(value)) {
      return res.status(400).json({ error: `${name} must be an integer between 0 and 100` });
    }
  }

  // Only the fields THIS request actually sent go into the partial update —
  // see persistSettings' own comment. Building `changed` alongside the
  // kernel.* mutations (not deriving it from kernel's full current state
  // afterward) keeps the two impossible to drift apart.
  const changed: SystemSettingsUpdate = {};
  if (offline !== undefined) { kernel.offlineMode = !!offline; changed.offlineMode = kernel.offlineMode; }
  if (localLlmEndpoint !== undefined) { kernel.localLlmEndpoint = localLlmEndpoint; changed.localLlmEndpoint = localLlmEndpoint; }
  if (localModelName !== undefined) { kernel.localModelName = localModelName; changed.localModelName = localModelName; }
  if (localApiKey !== undefined) { kernel.localApiKey = localApiKey; changed.localApiKey = localApiKey; }
  if (llmMode !== undefined) { kernel.llmMode = llmMode; changed.llmMode = llmMode; }
  if (personalityFormality !== undefined) { kernel.personalityFormality = personalityFormality; changed.personalityFormality = personalityFormality; }
  if (personalityHumor !== undefined) { kernel.personalityHumor = personalityHumor; changed.personalityHumor = personalityHumor; }
  if (personalityVerbosity !== undefined) { kernel.personalityVerbosity = personalityVerbosity; changed.personalityVerbosity = personalityVerbosity; }

  const persisted = await kernel.persistSettings(req.username, changed);

  observation.logTelemetry(
    "info",
    "System",
    `System settings updated: offline=${kernel.offlineMode}, mode=${kernel.llmMode}, localEndpoint=${kernel.localLlmEndpoint}, localModel=${kernel.localModelName}, personality(formality=${kernel.personalityFormality}, humor=${kernel.personalityHumor}, verbosity=${kernel.personalityVerbosity})`
  );
  // Doesn't echo localApiKey's value (see the redaction note on GET above) —
  // "the key changed" is still worth an auditable record, just not what it
  // changed to.
  observation.logAuditEvent(
    req.username,
    "update_settings",
    persisted ? "success" : "failed",
    `offline=${kernel.offlineMode}, mode=${kernel.llmMode}, localEndpoint=${kernel.localLlmEndpoint}, localModel=${kernel.localModelName}, localApiKeyChanged=${localApiKey !== undefined}, personality(formality=${kernel.personalityFormality}, humor=${kernel.personalityHumor}, verbosity=${kernel.personalityVerbosity})` +
      (persisted ? "" : " (in effect for this session — persistence failed, will revert on restart)")
  );

  res.json({
    status: "success",
    persisted,
    offline: kernel.offlineMode,
    localLlmEndpoint: kernel.localLlmEndpoint,
    localModelName: kernel.localModelName,
    localApiKeySet: !!kernel.localApiKey,
    llmMode: kernel.llmMode,
    personalityFormality: kernel.personalityFormality,
    personalityHumor: kernel.personalityHumor,
    personalityVerbosity: kernel.personalityVerbosity
  });
});

settingsRouter.post("/api/settings/test-local-llm", validateApiKey, requireCapability("settings.write"), async (req: any, res: any) => {
  const { endpoint, model, apiKey } = req.body;
  if (!endpoint) {
    return res.status(400).json({ success: false, message: "Missing endpoint URL" });
  }

  observation.logTelemetry("info", "Diagnostics", `Testing local LLM connection: endpoint=${endpoint}, model=${model}`);

  const targetUrl = normalizeLocalLlmUrl(endpoint);

  try {
    assertSafeEgressUrl(targetUrl);
  } catch (err: any) {
    return res.status(400).json({ success: false, message: err.message });
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
