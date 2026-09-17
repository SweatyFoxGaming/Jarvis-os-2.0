import fs from "fs";
import path from "path";
import type { Migration } from "./runner.js";

// Replaces src/self/settings-store.ts's local-JSON-file persistence for
// MindKernel's settings (offline mode, which LLM backend to use). That file
// lives outside Postgres entirely — not covered by scripts/backup-postgres.sh,
// no audit trail of who changed it or when, inconsistent with every other
// piece of durable state in this codebase. This is deliberately still a
// SINGLETON row (`id boolean primary key default true, check (id)` is the
// standard Postgres idiom for "exactly one row, structurally enforced") —
// src/self/kernel.ts's own docblock documents this as an intentional
// deployment-wide choice (which LLM backend a household's one Jarvis
// instance uses), not a per-user preference; moving it to Postgres doesn't
// change that, it just gives it the same durability/audit story as
// everything else.
const migration: Migration = {
  id: "003_system_settings",
  description:
    "Create system_settings (a singleton row) and seed it from the legacy data/settings.json file if one exists, replacing file-based persistence.",
  up: async (client) => {
    await client.query(`
      CREATE TABLE system_settings (
        id BOOLEAN PRIMARY KEY DEFAULT true,
        CHECK (id),
        offline_mode BOOLEAN NOT NULL DEFAULT false,
        local_llm_endpoint TEXT NOT NULL DEFAULT 'http://llama-cpp:8080',
        local_model_name TEXT NOT NULL DEFAULT 'local-gguf',
        local_api_key TEXT NOT NULL DEFAULT '',
        llm_mode TEXT NOT NULL DEFAULT 'local-first',
        updated_by TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    // One-time carry-over from the old file-based store so a deployment
    // that already configured a custom local LLM endpoint doesn't silently
    // lose it the moment this migration runs. Best-effort and non-fatal —
    // a missing or corrupt file just means the table keeps its defaults,
    // the same outcome MindKernel's old loadPersistedSettings() would have
    // produced anyway.
    const legacyPath = path.resolve(process.cwd(), "data", "settings.json");
    let legacy: Partial<{
      offlineMode: boolean;
      localLlmEndpoint: string;
      localModelName: string;
      localApiKey: string;
      llmMode: string;
    }> = {};
    try {
      if (fs.existsSync(legacyPath)) {
        legacy = JSON.parse(fs.readFileSync(legacyPath, "utf-8"));
      }
    } catch {
      // Corrupt or unreadable — proceed with defaults.
    }

    await client.query(
      `INSERT INTO system_settings (id, offline_mode, local_llm_endpoint, local_model_name, local_api_key, llm_mode, updated_by)
       VALUES (true, $1, $2, $3, $4, $5, 'migration-003')
       ON CONFLICT (id) DO NOTHING`,
      [
        legacy.offlineMode ?? false,
        legacy.localLlmEndpoint ?? "http://llama-cpp:8080",
        legacy.localModelName ?? "local-gguf",
        legacy.localApiKey ?? "",
        legacy.llmMode ?? "local-first",
      ]
    );
  },
};

export default migration;
