export class AttentionEngine {
  private currentAttention: string = "Idle Reflection";

  public determineAttention(inputs: {
    emergency?: string | null;
    userRequest?: string | null;
    activeGoal?: string | null;
    hasIncompletePlan?: boolean;
    learningOpportunity?: string | null;
  }): string {
    if (inputs.emergency) {
      this.currentAttention = `Emergency: ${inputs.emergency}`;
    } else if (inputs.userRequest) {
      this.currentAttention = `User Request: ${inputs.userRequest}`;
    } else if (inputs.activeGoal) {
      this.currentAttention = `Active Goal: ${inputs.activeGoal}`;
    } else if (inputs.hasIncompletePlan) {
      this.currentAttention = "Incomplete Plan";
    } else if (inputs.learningOpportunity) {
      this.currentAttention = `Learning Opportunity: ${inputs.learningOpportunity}`;
    } else {
      this.currentAttention = "Idle Reflection";
    }
    return this.currentAttention;
  }

  public getCurrentAttention(): string {
    return this.currentAttention;
  }
}
