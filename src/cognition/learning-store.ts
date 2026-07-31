import fs from "fs";
import path from "path";

const LEARNING_PATH = path.resolve(process.cwd(), "data", "learning.json");

export interface PersistedLearningState {
  styleCache: any;
  workflows: any[];
  mistakes: any[];
}

export function loadLearningState(): PersistedLearningState | null {
  try {
    if (!fs.existsSync(LEARNING_PATH)) return null;
    return JSON.parse(fs.readFileSync(LEARNING_PATH, "utf-8"));
  } catch (err) {
    console.error("[learning-store] Failed to load persisted learning state:", err);
    return null;
  }
}

export function saveLearningState(state: PersistedLearningState): void {
  try {
    fs.mkdirSync(path.dirname(LEARNING_PATH), { recursive: true });
    // Write to a temp file then rename over the target — a crash/OOM/kill
    // mid-write (this rewrites the whole file on every logMistake/
    // updateStylePreference/optimizeWorkflow call, i.e. potentially every
    // chat turn) would otherwise leave truncated/corrupt JSON, which
    // loadLearningState() would then silently treat as absent and reset to
    // seeded demo data. rename() is atomic on the same filesystem, which
    // this always is since both paths share LEARNING_PATH's directory.
    const tmpPath = `${LEARNING_PATH}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), "utf-8");
    fs.renameSync(tmpPath, LEARNING_PATH);
  } catch (err) {
    console.error("[learning-store] Failed to persist learning state:", err);
  }
}
