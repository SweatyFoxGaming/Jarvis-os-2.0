export interface MindState {
  currentUser: string;
  currentGoal: string | null;
  currentMission: string;
  currentThought: string | null;
  attentionTarget: string | null;
  currentPlan: string[];
  confidence: number; // 0 to 100
  workingMemory: Record<string, any>;
  reasoningContext: string | null;
  environmentSnapshot: Record<string, any>;
  executiveStatus: string;
  activeCapability: string | null;
  currentPlugin: string | null;
  learningFocus: string | null;
  observationSnapshot: Record<string, any>;
}

export class MindStateTracker {
  private state: MindState;

  constructor(initialState?: Partial<MindState>) {
    this.state = {
      currentUser: "admin",
      currentGoal: "Align system with human preferences",
      currentMission: "Establish Cognitive Workspace 2.0 Working Memory Structure",
      currentThought: "Transitioning Jarvis OS mental contexts into multi-compartment working memory pipelines.",
      attentionTarget: "Idle Reflection",
      currentPlan: ["Define interface schema", "Implement working memory cells", "Verify backward compatibility"],
      confidence: 100,
      workingMemory: {},
      reasoningContext: "Awaiting prompt interpretation",
      environmentSnapshot: { osType: "linux", networkConnected: true, activeSessionsCount: 1 },
      executiveStatus: "idle",
      activeCapability: null,
      currentPlugin: null,
      learningFocus: "snake_case style convention",
      observationSnapshot: {},
      ...initialState,
    };
  }

  public getState(): MindState {
    // Return a shallow/deep cloned frozen object for immutability
    return Object.freeze({ ...this.state });
  }

  public update(changes: Partial<MindState>): MindState {
    this.state = {
      ...this.state,
      ...changes,
    };
    return this.getState();
  }
}
