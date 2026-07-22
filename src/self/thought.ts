export class ThoughtEngine {
  private currentStage: string = "Idle";
  private stages: string[] = [
    "Understanding Request",
    "Searching Memory",
    "Planning",
    "Executing Research",
    "Validating Result",
    "Preparing Response"
  ];

  public setStage(stage: string): void {
    if (this.stages.includes(stage) || stage === "Idle") {
      this.currentStage = stage;
    } else {
      this.currentStage = stage;
    }
  }

  public getStage(): string {
    return this.currentStage;
  }

  public getStages(): string[] {
    return [...this.stages];
  }
}
