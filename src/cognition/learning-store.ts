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
    fs.writeFileSync(LEARNING_PATH, JSON.stringify(state, null, 2), "utf-8");
  } catch (err) {
    console.error("[learning-store] Failed to persist learning state:", err);
  }
}
