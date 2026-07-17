import { ObservationPlatform } from "../observation/index.js";

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
    this.seedInitialKnowledge();
  }

  public static getInstance(): LongTermLearningEngine {
    if (!this.instance) {
      this.instance = new LongTermLearningEngine();
    }
    return this.instance;
  }

  private seedInitialKnowledge() {
    // Seed standard optimization templates
    this.optimizeWorkflow("Deploy microservices orchestrator", [
      "Deconstruct requirements for Deploy microservices orchestrator",
      "Establish logical interfaces and database contracts",
      "Implement operational components and state machines",
      "Run regression suite and verify QA standards"
    ], 1200);

    // Seed style preference defaults
    this.styleCache = {
      namingConvention: "camelCase",
      tabSize: 2,
      frameworkPreference: "TypeScript Express / Cytoscape Graphing",
      architecturePattern: "Decoupled-Contexts"
    };

    // Seed mistake logs to avoid common compiler pitfalls
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
