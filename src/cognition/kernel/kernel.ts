import { loadSettings, saveSettings } from "./settings-store.js";

/**
 * System-wide settings only — which LLM backend to use, offline mode. This is
 * a deployment-wide choice, so it stays a singleton. Per-conversation working
 * state (current thought, attention, dialogue) lives in SessionState
 * (../session.js) instead, scoped per authenticated user.
 */
export class MindKernel {
  private static instance: MindKernel | null = null;

  public offlineMode = false;
  // Defaults to the "llama-cpp" service in docker-compose.yml — a GGUF model
  // from HOST_MODEL_DIR served entirely inside the Docker network, no host
  // bind-address dependency the way a host-run Ollama has (host.docker.internal
  // only helps if Ollama itself listens on more than 127.0.0.1 — see README).
  // Point this at your own Ollama/LM Studio/etc. endpoint in Settings if you
  // prefer that instead.
  public localLlmEndpoint = "http://llama-cpp:8080";
  public localModelName = "local-gguf";
  public localApiKey = "";
  public llmMode = "local-first";

  private constructor() {
    this.loadPersistedSettings();
  }

  private loadPersistedSettings(): void {
    const persisted = loadSettings();
    if (!persisted) return;
    if (persisted.offlineMode !== undefined) this.offlineMode = persisted.offlineMode;
    if (persisted.localLlmEndpoint !== undefined) this.localLlmEndpoint = persisted.localLlmEndpoint;
    if (persisted.localModelName !== undefined) this.localModelName = persisted.localModelName;
    if (persisted.localApiKey !== undefined) this.localApiKey = persisted.localApiKey;
    if (persisted.llmMode !== undefined) this.llmMode = persisted.llmMode;
  }

  public persistSettings(): void {
    saveSettings({
      offlineMode: this.offlineMode,
      localLlmEndpoint: this.localLlmEndpoint,
      localModelName: this.localModelName,
      localApiKey: this.localApiKey,
      llmMode: this.llmMode,
    });
  }

  public static getInstance(): MindKernel {
    if (!MindKernel.instance) {
      MindKernel.instance = new MindKernel();
    }
    return MindKernel.instance;
  }
}
