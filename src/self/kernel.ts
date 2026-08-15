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

  // 0-100 dials consumed by identity.ts's buildPersonalityPromptFragment to
  // shape the real system prompt every /api/chat call uses (see
  // migrations/007_personality_settings.ts) — not display-only, so these
  // defaults must match the neutral/understated-humor baseline the
  // hardcoded persona in server.ts already implies today.
  public personalityFormality = 50;
  public personalityHumor = 30;
  public personalityVerbosity = 50;

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
    this.personalityFormality = row.personality_formality;
    this.personalityHumor = row.personality_humor;
    this.personalityVerbosity = row.personality_verbosity;
  }

  // Takes the caller's explicit partial update (only the fields THIS
  // request actually changed) rather than snapshotting every current
  // in-memory field. That distinction matters now that persisting is async:
  // two concurrent /api/settings* requests interleave in-memory (each reads
  // the fields it cares about, mutates them, then awaits its own DB write),
  // and a full-snapshot write can carry a field's value as it stood *before*
  // the other request's write actually reaches Postgres — whichever UPDATE
  // lands second then clobbers the other request's change back to a stale
  // value, even though both requests' in-memory state was already correct.
  // A partial update only ever touches the field(s) this call actually
  // changed; system-settings-repo.ts's COALESCE already preserves everything
  // else regardless of interleaving. Returns whether the write actually
  // succeeded — the in-memory fields above are already mutated by the
  // caller either way (matches this codebase's existing capability-grant
  // pattern: the change is live for this process immediately, durability is
  // separate), but callers need to know if it failed to log an honest audit
  // outcome instead of unconditionally claiming "success".
  public async persistSettings(updatedBy: string, changed: systemSettingsRepo.SystemSettingsUpdate): Promise<boolean> {
    const updated = await systemSettingsRepo.updateSystemSettings(changed, updatedBy);
    return updated !== null;
  }

  public static getInstance(): MindKernel {
    if (!MindKernel.instance) {
      MindKernel.instance = new MindKernel();
    }
    return MindKernel.instance;
  }
}
