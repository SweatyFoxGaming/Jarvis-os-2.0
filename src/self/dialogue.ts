// A linear execution-stage log for one autonomous-objective run, not a
// multi-agent deliberation — every recordTurn() call site is a single
// function (src/executive/autonomous_executive.ts) narrating its own
// progress with a hardcoded string, not distinct reasoning agents. "CEO"/
// "Architect"/"Security"/"Operations" previously suggested otherwise (the
// same class of misleading framing already found and fixed once for the
// "Executive Board," a different module removed for the same reason).
// Stage names describe what's actually happening: the objective arrived,
// it got planned, real department research ran, a QA pass reviewed the
// output, and a decision/result was recorded.
export interface DialogueTurn {
  role: "Objective" | "Plan" | "Research" | "QA" | "Decision";
  message: string;
}

export class InternalDialogue {
  private history: DialogueTurn[] = [];

  public clear(): void {
    this.history = [];
  }

  public recordTurn(role: DialogueTurn["role"], message: string): void {
    this.history.push({ role, message });
  }

  public getHistory(): DialogueTurn[] {
    return [...this.history];
  }

  public getSummarizedDecision(): string {
    const decisionTurn = this.history.find(t => t.role === "Decision");
    return decisionTurn ? decisionTurn.message : "No consensus or decision reached yet.";
  }
}
