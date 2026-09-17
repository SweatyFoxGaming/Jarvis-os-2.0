/**
 * Phase XIII: Cognitive Workspace 2.0
 * Upgrading static context state into a human-like multi-compartment "Working Memory".
 * 
 * Working Memory Compartments:
 * 1. Current Mission (The overarching reason the system is awake)
 * 2. Current Thought (The immediate intellectual processing token)
 * 3. Current Goal (The immediate milestone being resolved)
 * 4. Current Plan (Step-by-step operational tasks and queues)
 * 5. Current Environment (Live host system hardware and security constraints)
 * 6. Current User Context (Dialogue history, traits, preferences, and facts)
 * 7. Active Capabilities (Real-time hot-swappable tool state and executions)
 * 8. Attention (Active files, variables, or items of interest)
 * 9. Reasoning State (Confidence scores, debate parameters, and logical steps)
 */

// ---------- Interfaces for the 9 working memory compartments ----------

export interface IWorkspaceMission {
  currentMission: string;
  status: "idle" | "in_progress" | "completed" | "failed";
  progressPercent: number;
  setMission(mission: string, status?: "idle" | "in_progress" | "completed" | "failed", progressPercent?: number): void;
}

export interface IWorkspaceThought {
  activeThought: string;
  intensity: number; // 0.0 to 1.0
  setThought(thought: string, intensity?: number): void;
}

export interface IWorkspaceGoal {
  activeGoal: string | null;
  priority: number;
  budgetCredits: number;
  setGoal(goal: string, priority: number, budget: number): void;
  clearGoal(): void;
}

export interface IWorkspacePlan {
  steps: string[];
  currentStepIndex: number;
  status: "idle" | "planning" | "executing" | "learning" | "sleeping" | "error";
  retryCount: number;
  setPlan(steps: string[]): void;
  advanceStep(): void;
  updateStatus(status: "idle" | "planning" | "executing" | "learning" | "sleeping" | "error"): void;
}

export interface IWorkspaceEnvironment {
  osType: string;
  networkConnected: boolean;
  activeSessionsCount: number;
  updateMetrics(osType: string, network: boolean, sessions: number): void;
}

export interface IWorkspaceUserContext {
  history: Array<{ role: "user" | "assistant" | "system"; content: string; timestamp: Date }>;
  loadedFacts: string[];
  userPreferences: Record<string, any>;
  addMessage(role: "user" | "assistant" | "system", content: string): void;
  clearHistory(): void;
  addFact(fact: string): void;
  setPreference(key: string, value: any): void;
}

export interface IWorkspaceCapabilities {
  selectedCapability: string | null;
  lastExecutionResult: any;
  setCapability(name: string): void;
  recordResult(result: any): void;
}

export interface IWorkspaceAttention {
  focusedFiles: string[];
  focusedVariables: string[];
  focusOn(file: string): void;
  focusVariable(name: string): void;
  clearFocus(): void;
}

export interface IWorkspaceReasoningState {
  currentThought: string | null;
  confidenceScore: number;
  setThought(thought: string, confidence: number): void;
}

// ---------- Implementation of Workspace 2.0 Compartments ----------

export class WorkspaceMission implements IWorkspaceMission {
  currentMission: string = "Establish Cognitive Workspace 2.0 Working Memory Structure";
  status: "idle" | "in_progress" | "completed" | "failed" = "in_progress";
  progressPercent: number = 75;

  setMission(mission: string, status?: "idle" | "in_progress" | "completed" | "failed", progressPercent?: number): void {
    this.currentMission = mission;
    if (status) this.status = status;
    if (progressPercent !== undefined) this.progressPercent = progressPercent;
  }
}

export class WorkspaceThought implements IWorkspaceThought {
  activeThought: string = "Transitioning Jarvis OS mental contexts into multi-compartment working memory pipelines.";
  intensity: number = 0.95;

  setThought(thought: string, intensity: number = 0.9): void {
    this.activeThought = thought;
    this.intensity = intensity;
  }
}

export class WorkspaceGoal implements IWorkspaceGoal {
  activeGoal: string | null = "Align system with human preferences";
  priority: number = 8;
  budgetCredits: number = 100;

  setGoal(goal: string, priority: number, budget: number): void {
    this.activeGoal = goal;
    this.priority = priority;
    this.budgetCredits = budget;
  }

  clearGoal(): void {
    this.activeGoal = null;
    this.priority = 0;
    this.budgetCredits = 0;
  }
}

export class WorkspacePlan implements IWorkspacePlan {
  steps: string[] = ["Define interface schema", "Implement working memory cells", "Verify backward compatibility"];
  currentStepIndex: number = 1;
  status: "idle" | "planning" | "executing" | "learning" | "sleeping" | "error" = "idle";
  retryCount: number = 0;

  setPlan(steps: string[]): void {
    this.steps = steps;
    this.currentStepIndex = 0;
    this.retryCount = 0;
  }

  advanceStep(): void {
    if (this.currentStepIndex < this.steps.length) {
      this.currentStepIndex++;
    }
  }

  updateStatus(status: "idle" | "planning" | "executing" | "learning" | "sleeping" | "error"): void {
    this.status = status;
  }
}

export class WorkspaceEnvironment implements IWorkspaceEnvironment {
  osType: string = "linux";
  networkConnected: boolean = true;
  activeSessionsCount: number = 1;

  updateMetrics(osType: string, network: boolean, sessions: number): void {
    this.osType = osType;
    this.networkConnected = network;
    this.activeSessionsCount = sessions;
  }
}

export class WorkspaceUserContext implements IWorkspaceUserContext {
  history: Array<{ role: "user" | "assistant" | "system"; content: string; timestamp: Date }> = [];
  loadedFacts: string[] = [
    "Jarvis OS v3.0 core rules are loaded",
    "PostgreSQL migration pathway configured",
    "Tailwind slate theme declared as standard visual aesthetic"
  ];
  userPreferences: Record<string, any> = {
    theme: "slate-dark",
    animations: true,
    speechEnabled: false
  };

  addMessage(role: "user" | "assistant" | "system", content: string): void {
    this.history.push({ role, content, timestamp: new Date() });
    if (this.history.length > 50) {
      this.history.shift(); // Keep buffer bounded
    }
  }

  clearHistory(): void {
    this.history = [];
  }

  addFact(fact: string): void {
    if (!this.loadedFacts.includes(fact)) {
      this.loadedFacts.push(fact);
    }
  }

  setPreference(key: string, value: any): void {
    this.userPreferences[key] = value;
  }
}

export class WorkspaceCapabilities implements IWorkspaceCapabilities {
  selectedCapability: string | null = null;
  lastExecutionResult: any = null;

  setCapability(name: string): void {
    this.selectedCapability = name;
  }

  recordResult(result: any): void {
    this.lastExecutionResult = result;
  }
}

export class WorkspaceAttention implements IWorkspaceAttention {
  focusedFiles: string[] = ["src/cognition/workspace.ts"];
  focusedVariables: string[] = ["CognitiveWorkspace"];

  focusOn(file: string): void {
    if (!this.focusedFiles.includes(file)) {
      this.focusedFiles.push(file);
    }
  }

  focusVariable(name: string): void {
    if (!this.focusedVariables.includes(name)) {
      this.focusedVariables.push(name);
    }
  }

  clearFocus(): void {
    this.focusedFiles = [];
    this.focusedVariables = [];
  }
}

export class WorkspaceReasoningState implements IWorkspaceReasoningState {
  currentThought: string | null = "Awaiting prompt interpretation";
  confidenceScore: number = 1.0;

  setThought(thought: string, confidence: number): void {
    this.currentThought = thought;
    this.confidenceScore = confidence;
  }
}

// ---------- Unified Cognitive Workspace 2.0 Interface ----------

export interface ICognitiveWorkspace {
  // Compartments
  mission: IWorkspaceMission;
  thought: IWorkspaceThought;
  goal: IWorkspaceGoal;
  plan: IWorkspacePlan;
  environment: IWorkspaceEnvironment;
  userContext: IWorkspaceUserContext;
  capabilities: IWorkspaceCapabilities;
  attention: IWorkspaceAttention;
  reasoningState: IWorkspaceReasoningState;

  // Backwards Compatibility interfaces for Phase XI
  goalContext: IWorkspaceGoal;
  conversationContext: IWorkspaceUserContext;
  executionContext: IWorkspacePlan;
  knowledgeContext: IWorkspaceUserContext;
  capabilityContext: IWorkspaceCapabilities;
  environmentContext: IWorkspaceEnvironment;
  reasoningContext: IWorkspaceReasoningState;

  toSnapshot(): Record<string, any>;
}

export class CognitiveWorkspace implements ICognitiveWorkspace {
  // Nine human-like working memory compartments
  public mission = new WorkspaceMission();
  public thought = new WorkspaceThought();
  public goal = new WorkspaceGoal();
  public plan = new WorkspacePlan();
  public environment = new WorkspaceEnvironment();
  public userContext = new WorkspaceUserContext();
  public capabilities = new WorkspaceCapabilities();
  public attention = new WorkspaceAttention();
  public reasoningState = new WorkspaceReasoningState();

  // Backwards compatibility mappings for older test references
  public get goalContext() { return this.goal; }
  public get conversationContext() { return this.userContext; }
  public get executionContext() { return this.plan; }
  public get knowledgeContext() { return this.userContext; }
  public get capabilityContext() { return this.capabilities; }
  public get environmentContext() { return this.environment; }
  public get reasoningContext() { return this.reasoningState; }

  // Exposing direct backward compatibility getters
  public get conversation() { return this.userContext; }
  public get execution() { return this.plan; }
  public get knowledge() { return this.userContext; }
  public get capability() { return this.capabilities; }
  public get reasoning() { return this.reasoningState; }

  toSnapshot(): Record<string, any> {
    return {
      mission: {
        currentMission: this.mission.currentMission,
        status: this.mission.status,
        progressPercent: this.mission.progressPercent,
      },
      thought: {
        activeThought: this.thought.activeThought,
        intensity: this.thought.intensity,
      },
      goal: {
        activeGoal: this.goal.activeGoal,
        priority: this.goal.priority,
        budgetCredits: this.goal.budgetCredits,
      },
      plan: {
        steps: this.plan.steps,
        currentStepIndex: this.plan.currentStepIndex,
        status: this.plan.status,
        retryCount: this.plan.retryCount,
      },
      environment: {
        osType: this.environment.osType,
        networkConnected: this.environment.networkConnected,
        activeSessionsCount: this.environment.activeSessionsCount,
      },
      userContext: {
        factsCount: this.userContext.loadedFacts.length,
        userPreferences: this.userContext.userPreferences,
        historyLength: this.userContext.history.length,
      },
      capabilities: {
        selectedCapability: this.capabilities.selectedCapability,
      },
      attention: {
        focusedFiles: this.attention.focusedFiles,
        focusedVariables: this.attention.focusedVariables,
      },
      reasoningState: {
        currentThought: this.reasoningState.currentThought,
        confidenceScore: this.reasoningState.confidenceScore,
      },
      // Keep backwards compatibility keys in snapshots for standard UI elements
      execution: {
        activeTask: this.plan.steps[this.plan.currentStepIndex] || "None",
        status: this.plan.status,
        retryCount: this.plan.retryCount,
      },
      knowledge: {
        factsCount: this.userContext.loadedFacts.length,
        userPreferences: this.userContext.userPreferences,
      },
      capability: {
        selectedCapability: this.capabilities.selectedCapability,
      },
      reasoning: {
        currentThought: this.reasoningState.currentThought,
        confidenceScore: this.reasoningState.confidenceScore,
      }
    };
  }
}
