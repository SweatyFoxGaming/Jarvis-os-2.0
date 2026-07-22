export interface DialogueTurn {
  role: "CEO" | "Architect" | "Security" | "Research" | "Operations" | "QA" | "Decision";
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
