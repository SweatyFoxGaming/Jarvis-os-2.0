import { ObservationPlatform } from "../kernel/observation.js";
import { loadLearningState, saveLearningState } from "./learning-store.js";

/**
 * Phase XV: Long-Term Learning
 * Enables persistent local adaptation without model fine-tuning or weight retraining.
 */

export interface ICodingStylePreference {
  namingConvention: "camelCase" | "snake_case" | "PascalCase" | "kebab-case";
  tabSize: number;
  frameworkPreference: string;
  architecturePattern: "MVC" | "Hexagonal" | "Microservices" | "Decoupled-Contexts";
}

export interface ICachedWorkflow {
  objective: string;
  optimizedSteps: string[];
  executionCount: number;
  successRate: number;
  averageLatencyMs: number;
}

export interface IMistakeEntry {
  errorSignature: string;
  affectedFile: string;
  rootCause: string;
  successfulFix: string;
  timestamp: Date;
}

export class LongTermLearningEngine {
  private static instance: LongTermLearningEngine | null = null;
  private observation: ObservationPlatform;

  // Incremental local Adaptation Repositories
  private styleCache: ICodingStylePreference = {
    namingConvention: "camelCase",
    tabSize: 2,
    frameworkPreference: "TypeScript",
    architecturePattern: "Decoupled-Contexts"
  };

  private workflowOptimizer: Map<string, ICachedWorkflow> = new Map();
  private mistakeLog: IMistakeEntry[] = [];

  private constructor() {
    this.observation = ObservationPlatform.getInstance();
    // Persisted state (data/learning.json) survives restarts; only seed the
    // canned demo entries on a genuinely fresh install with nothing saved yet
    // — otherwise "long-term" learning was reset to the same seed every time
    // the container restarted, which defeats the point.
    if (!this.loadPersistedState()) {
      this.seedInitialKnowledge();
    }
  }

  public static getInstance(): LongTermLearningEngine {
    if (!this.instance) {
      this.instance = new LongTermLearningEngine();
    }
    return this.instance;
  }

  private loadPersistedState(): boolean {
    const persisted = loadLearningState();
    if (!persisted) return false;
    if (persisted.styleCache) this.styleCache = persisted.styleCache;
    if (Array.isArray(persisted.workflows)) {
      for (const wf of persisted.workflows) {
        this.workflowOptimizer.set(wf.objective.toLowerCase().trim(), wf);
      }
    }
    if (Array.isArray(persisted.mistakes)) {
      this.mistakeLog = persisted.mistakes;
    }
    return true;
  }

  private persist(): void {
    saveLearningState({
      styleCache: this.styleCache,
      workflows: Array.from(this.workflowOptimizer.values()),
      mistakes: this.mistakeLog,
    });
  }

  private seedInitialKnowledge() {
    // Demo/example entries shown on a fresh install — not claims about what
    // this deployment has actually learned yet.
    this.optimizeWorkflow("Deploy microservices orchestrator", [
      "Deconstruct requirements for Deploy microservices orchestrator",
      "Establish logical interfaces and database contracts",
      "Implement operational components and state machines",
      "Run regression suite and verify QA standards"
    ], 1200);

    this.styleCache = {
      namingConvention: "camelCase",
      tabSize: 2,
      frameworkPreference: "TypeScript Express / Cytoscape Graphing",
      architecturePattern: "Decoupled-Contexts"
    };

    this.logMistake(
      "Cannot find module '../src/cognition/workspace.js' or its corresponding type declarations.",
      "tests/index.test.ts",
      "Relative path resolution mismatch due to tsconfig paths mapping in NodeNext ESM mode.",
      "Always append standard .js extension to relative TS imports in ESM context."
    );
  }

  // ---------- 1. Style Caching APIs ----------
  
  public getStylePreferences(): ICodingStylePreference {
    return this.styleCache;
  }

  public updateStylePreference(updates: Partial<ICodingStylePreference>): void {
    this.styleCache = { ...this.styleCache, ...updates };
    this.persist();
    this.observation.logTelemetry("info", "Learning", `Dynamic Style Cache updated: Naming: ${this.styleCache.namingConvention}, Pattern: ${this.styleCache.architecturePattern}`);
  }

  // ---------- 2. Workflow Optimization APIs ----------

  public optimizeWorkflow(objective: string, steps: string[], latencyMs: number): void {
    const key = objective.toLowerCase().trim();
    const existing = this.workflowOptimizer.get(key);

    if (existing) {
      existing.executionCount++;
      existing.averageLatencyMs = (existing.averageLatencyMs * (existing.executionCount - 1) + latencyMs) / existing.executionCount;
      existing.successRate = (existing.successRate * (existing.executionCount - 1) + 1.0) / existing.executionCount;
      this.workflowOptimizer.set(key, existing);
    } else {
      this.workflowOptimizer.set(key, {
        objective,
        optimizedSteps: steps,
        executionCount: 1,
        successRate: 1.0,
        averageLatencyMs: latencyMs
      });
    }
    this.persist();
    this.observation.logTelemetry("info", "Learning", `Workflow optimized for mission: "${objective}". Steps cached to local Knowledge Graph.`);
  }

  public getOptimizedWorkflow(objective: string): ICachedWorkflow | null {
    const key = objective.toLowerCase().trim();
    return this.workflowOptimizer.get(key) || null;
  }

  public listOptimizedWorkflows(): ICachedWorkflow[] {
    return Array.from(this.workflowOptimizer.values());
  }

  // ---------- 3. Mistake Log APIs ----------

  public logMistake(errorSignature: string, file: string, rootCause: string, fix: string): void {
    const entry: IMistakeEntry = {
      errorSignature,
      affectedFile: file,
      rootCause,
      successfulFix: fix,
      timestamp: new Date()
    };
    this.mistakeLog.push(entry);
    this.persist();
    this.observation.logTelemetry("warn", "Learning", `New mistake registered in local Knowledge Graph for "${file}": ${errorSignature}`);
    this.observation.logAuditEvent("System", "mistake_logged", "success", `Mistake in ${file}: ${errorSignature}`);
  }

  public getMistakesForFile(file: string): IMistakeEntry[] {
    return this.mistakeLog.filter(m => m.affectedFile === file);
  }

  public searchFixForError(errorSnippet: string): IMistakeEntry | null {
    const snippet = errorSnippet.toLowerCase();
    return this.mistakeLog.find(m => m.errorSignature.toLowerCase().includes(snippet) || m.rootCause.toLowerCase().includes(snippet)) || null;
  }

  public getMistakeLog(): IMistakeEntry[] {
    return this.mistakeLog;
  }
}
