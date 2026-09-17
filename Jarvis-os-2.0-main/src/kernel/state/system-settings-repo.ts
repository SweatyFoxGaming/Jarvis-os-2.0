import { getPool } from "./db.js";
import { ObservationPlatform } from "../observation.js";

const observation = ObservationPlatform.getInstance();

export interface SystemSettingsRow {
  offline_mode: boolean;
  local_llm_endpoint: string;
  local_model_name: string;
  local_api_key: string;
  llm_mode: string;
  // 0-100 dials (migrations/007_personality_settings.ts) that steer the
  // real system prompt's register — see identity.ts's
  // buildPersonalityPromptFragment, the actual consumer of these values.
  personality_formality: number;
  personality_humor: number;
  personality_verbosity: number;
  updated_by: string | null;
  updated_at: Date;
}

// The one row (migrations/003_system_settings.ts's boolean-PK singleton
// idiom) MindKernel hydrates itself from once at boot. Returns null on any
// failure (unreachable Postgres, migration not yet applied) — MindKernel
// keeps its hardcoded defaults in that case, the same degrade this
// singleton's old file-based store already had.
export async function getSystemSettings(): Promise<SystemSettingsRow | null> {
  try {
    const db = getPool();
    const { rows } = await db.query(`SELECT * FROM system_settings WHERE id = true`);
    return rows[0] || null;
  } catch (err: any) {
    observation.logTelemetry("warn", "SystemSettings", `getSystemSettings() failed: ${err.message}`);
    return null;
  }
}

export interface SystemSettingsUpdate {
  offlineMode?: boolean;
  localLlmEndpoint?: string;
  localModelName?: string;
  localApiKey?: string;
  llmMode?: string;
  personalityFormality?: number;
  personalityHumor?: number;
  personalityVerbosity?: number;
}

// Partial update — an omitted (undefined) field keeps its current value via
// COALESCE; an explicitly empty string (e.g. clearing localApiKey) is a
// real value, not treated as "omitted" (`?? null` only substitutes on
// null/undefined, never on ""). updatedBy is who made this change — always
// recorded, giving this a real audit trail the old JSON file never had.
export async function updateSystemSettings(update: SystemSettingsUpdate, updatedBy: string): Promise<SystemSettingsRow | null> {
  try {
    const db = getPool();
    const { rows } = await db.query(
      `UPDATE system_settings SET
         offline_mode = COALESCE($1, offline_mode),
         local_llm_endpoint = COALESCE($2, local_llm_endpoint),
         local_model_name = COALESCE($3, local_model_name),
         local_api_key = COALESCE($4, local_api_key),
         llm_mode = COALESCE($5, llm_mode),
         personality_formality = COALESCE($6, personality_formality),
         personality_humor = COALESCE($7, personality_humor),
         personality_verbosity = COALESCE($8, personality_verbosity),
         updated_by = $9,
         updated_at = now()
       WHERE id = true
       RETURNING *`,
      [
        update.offlineMode ?? null,
        update.localLlmEndpoint ?? null,
        update.localModelName ?? null,
        update.localApiKey ?? null,
        update.llmMode ?? null,
        update.personalityFormality ?? null,
        update.personalityHumor ?? null,
        update.personalityVerbosity ?? null,
        updatedBy,
      ]
    );
    return rows[0] || null;
  } catch (err: any) {
    observation.logTelemetry("warn", "SystemSettings", `updateSystemSettings() failed: ${err.message}`);
    return null;
  }
}
