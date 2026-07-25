import * as systemSettingsRepo from "../kernel/state/system-settings-repo.js";

/**
 * System-wide settings only — which LLM backend to use, offline mode. This is
 * a deployment-wide choice, so it stays a singleton. Per-conversation working
 * state (current thought, attention, dialogue) lives in SessionState
 * (../session.js) instead, scoped per authenticated user.
 *
 * Persisted in Postgres (system_settings — a singleton row, see
 * migrations/003_system_settings.ts), not a local JSON file as before: that
 * file lived outside the Postgres backup/restore story and had no record of
 * who changed a setting or when. Every field below stays a plain, fully
 * synchronous in-memory property — /api/chat reads these on every single
 * message, so this cannot become a per-request DB round trip. hydrateFromDb()
 * populates them once at boot (after migrations have run); persistSettings()
 * writes changes back out. Neither is in the constructor: a DB query can't be
 * synchronous, and getInstance() is called synchronously all over this
 * codebase.
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

  private constructor() {}

  // Called once at server startup, after initDatabase() (and therefore its
  // migrations) have completed — see server.ts. A failed/unreachable read
  // (Postgres down, or this migration hasn't run yet on an old checkout)
  // just leaves the hardcoded defaults above in place, the same degrade the
  // old file-based store already had for a missing/unreadable file.
  public async hydrateFromDb(): Promise<void> {
    const row = await systemSettingsRepo.getSystemSettings();
    if (!row) return;
    this.offlineMode = row.offline_mode;
    this.localLlmEndpoint = row.local_llm_endpoint;
    this.localModelName = row.local_model_name;
    this.localApiKey = row.local_api_key;
    this.llmMode = row.llm_mode;
  }

  // updatedBy is who made this change (an admin/settings.write-granted
  // username) — always recorded, giving this a real audit trail the old
  // JSON file never had.
  public async persistSettings(updatedBy: string): Promise<void> {
    await systemSettingsRepo.updateSystemSettings(
      {
        offlineMode: this.offlineMode,
        localLlmEndpoint: this.localLlmEndpoint,
        localModelName: this.localModelName,
        localApiKey: this.localApiKey,
        llmMode: this.llmMode,
      },
      updatedBy
    );
  }

  public static getInstance(): MindKernel {
    if (!MindKernel.instance) {
      MindKernel.instance = new MindKernel();
    }
    return MindKernel.instance;
  }
}
