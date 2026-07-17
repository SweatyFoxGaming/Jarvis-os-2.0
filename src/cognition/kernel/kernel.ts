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
  // "localhost" would resolve to the container itself, not the Docker host —
  // host.docker.internal (mapped via extra_hosts in docker-compose.yml) reaches
  // a local LLM (e.g. Ollama) running on the host machine.
  public localLlmEndpoint = "http://host.docker.internal:11434";
  public localModelName = "llama3";
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
