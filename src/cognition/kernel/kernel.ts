import { MindState, MindStateTracker } from "./state.js";
import { AttentionEngine } from "./attention.js";
import { ThoughtEngine } from "./thought.js";
import { ConfidenceModel } from "./confidence.js";
import { ExecutiveStateTracker, ExecutiveStatus } from "./executive_state.js";
import { InternalDialogue } from "./dialogue.js";
import { SynchronizationEngine } from "./synchronization.js";
import { CognitiveWorkspace } from "../workspace.js";
import { ObservationPlatform } from "../../observation/index.js";

export class MindKernel {
  private static instance: MindKernel | null = null;

  public stateTracker = new MindStateTracker();
  public attentionEngine = new AttentionEngine();
  public thoughtEngine = new ThoughtEngine();
  public confidenceModel = new ConfidenceModel();
  public executiveTracker = new ExecutiveStateTracker();
  public dialogue = new InternalDialogue();
  public synchronizer = new SynchronizationEngine();
  public offlineMode = false;

  private constructor() {}

  public static getInstance(): MindKernel {
    if (!MindKernel.instance) {
      MindKernel.instance = new MindKernel();
    }
    return MindKernel.instance;
  }

  public getState(): MindState {
    return this.stateTracker.getState();
  }

  public updateState(
    changes: Partial<MindState>,
    workspace: CognitiveWorkspace,
    observation: ObservationPlatform
  ): MindState {
    const prevState = this.stateTracker.getState();
    const newState = this.stateTracker.update(changes);

    // Track reasoning state and attention if they changed
    if (changes.currentThought) {
      this.thoughtEngine.setStage(changes.currentThought);
    }

    if (changes.executiveStatus) {
      this.executiveTracker.setStatus(changes.executiveStatus as ExecutiveStatus);
    }

    // Publish state changes and emit MindStateUpdated audit/telemetry
    observation.logAuditEvent(
      "MindKernel",
      "MindStateUpdated",
      "success",
      `Cognitive State transitioned from "${prevState.executiveStatus}" to "${newState.executiveStatus}"`
    );

    // Sync all platforms through synchronization engine
    this.synchronizer.synchronize(newState, workspace, observation);

    return newState;
  }
}
export { ExecutiveStatus };
