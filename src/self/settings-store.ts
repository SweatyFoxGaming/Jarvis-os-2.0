import fs from "fs";
import path from "path";

const SETTINGS_PATH = path.resolve(process.cwd(), "data", "settings.json");

export interface PersistedSettings {
  offlineMode: boolean;
  localLlmEndpoint: string;
  localModelName: string;
  localApiKey: string;
  llmMode: string;
}

export function loadSettings(): Partial<PersistedSettings> | null {
  try {
    if (!fs.existsSync(SETTINGS_PATH)) return null;
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf-8"));
  } catch (err) {
    console.error("[settings-store] Failed to load persisted settings:", err);
    return null;
  }
}

export function saveSettings(settings: PersistedSettings): void {
  try {
    fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), "utf-8");
  } catch (err) {
    console.error("[settings-store] Failed to persist settings:", err);
  }
}
