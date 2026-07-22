import { CognitiveWorkspace } from "../cognition/workspace.js";
import { ObservationPlatform } from "../kernel/observation.js";
import { MindState } from "./state.js";

export class SynchronizationEngine {
  public synchronize(
    state: MindState,
    workspace: CognitiveWorkspace,
    observation: ObservationPlatform
  ): void {
    // Synchronize to the CognitiveWorkspace Compartments
    if (state.currentMission) {
      workspace.mission.setMission(
        state.currentMission,
        workspace.mission.status,
        workspace.mission.progressPercent
      );
    }
    if (state.currentGoal) {
      workspace.goal.setGoal(
        state.currentGoal,
        workspace.goal.priority,
        workspace.goal.budgetCredits
      );
    }
    if (state.currentPlan && state.currentPlan.length > 0) {
      workspace.plan.steps = [...state.currentPlan];
    }
    if (state.currentThought) {
      workspace.thought.setThought(state.currentThought, workspace.thought.intensity);
    }
    if (state.executiveStatus) {
      const mappedStatus = this.mapStatus(state.executiveStatus);
      workspace.plan.updateStatus(mappedStatus);
    }
    if (state.activeCapability) {
      workspace.capabilities.setCapability(state.activeCapability);
    }
    if (state.attentionTarget) {
      workspace.attention.focusOn(state.attentionTarget);
    }

    // Sync environment snap if exists
    if (state.environmentSnapshot) {
      workspace.environment.updateMetrics(
        state.environmentSnapshot.osType || "linux",
        state.environmentSnapshot.networkConnected ?? true,
        state.environmentSnapshot.activeSessionsCount ?? 1
      );
    }

    // Emit event and record telemetry
    observation.logTelemetry(
      "info",
      "Kernel",
      `Mind Kernel synchronized successfully. Attention target set to "${state.attentionTarget}".`
    );
  }

  private mapStatus(status: string): "idle" | "planning" | "executing" | "learning" | "sleeping" | "error" {
    const s = status.toLowerCase();
    if (s === "idle") return "idle";
    if (s === "planning") return "planning";
    if (s === "executing" || s === "thinking" || s === "delegating") return "executing";
    if (s === "learning" || s === "reflecting") return "learning";
    if (s === "sleeping" || s === "recovering") return "sleeping";
    return "error";
  }
}
