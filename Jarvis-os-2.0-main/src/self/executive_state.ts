export enum ExecutiveStatus {
  Idle = "Idle",
  Listening = "Listening",
  Thinking = "Thinking",
  Planning = "Planning",
  Delegating = "Delegating",
  Executing = "Executing",
  Learning = "Learning",
  Observing = "Observing",
  Reflecting = "Reflecting",
  Recovering = "Recovering",
}

export class ExecutiveStateTracker {
  private status: ExecutiveStatus = ExecutiveStatus.Idle;

  public setStatus(status: ExecutiveStatus): void {
    this.status = status;
  }

  public getStatus(): ExecutiveStatus {
    return this.status;
  }
}
