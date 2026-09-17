import { DaemonClient } from "./daemonClient";
import { GeminiClient } from "./geminiClient";
import { MemoryStore } from "./memoryStore";

interface AgentStepResult {
  thought: string;
  action?: { name: string; payload: Record<string, any> };
  isFinished: boolean;
  finalAnswer?: string;
}

export class AutonomousAgent {
  private daemon: DaemonClient;
  private llm: GeminiClient;
  private memory: MemoryStore;

  constructor() {
    this.daemon = new DaemonClient("ws://localhost:8765");
    this.llm = new GeminiClient();
    this.memory = new MemoryStore();
  }

  async runGoal(goal: string, maxSteps = 15): Promise<string> {
    console.log(`[Jarvis OS] Goal Initialized: "${goal}"`);
    let stepCount = 0;
    let history: Array<{ step: number; thought: string; action: any; observation: any }> = [];

    while (stepCount < maxSteps) {
      stepCount++;
      console.log(`\n--- Step ${stepCount}/${maxSteps} ---`);

      // 1. SENSE: Capture environment state
      const screen = await this.daemon.send("PERCEPTION_SCREEN", { monitor: 1 });
      const window = await this.daemon.send("PERCEPTION_WINDOW", {});
      
      // 2. REASON: LLM decides next thought and action based on goal + visual state
      const stepDecision: AgentStepResult = await this.llm.decideNextStep({
        goal,
        activeWindow: window.result,
        screenImageBase64: screen.result.image_b64,
        executionHistory: history,
      });

      console.log(`Thought: ${stepDecision.thought}`);

      if (stepDecision.isFinished) {
        console.log(`[Jarvis OS] Goal Completed!`);
        return stepDecision.finalAnswer || "Goal completed successfully.";
      }

      if (!stepDecision.action) {
        throw new Error("Agent failed to provide an action or mark goal as finished.");
      }

      // 3. ACT: Dispatch action to Python IPC daemon
      console.log(`Action: ${stepDecision.action.name}`, stepDecision.action.payload);
      const actionResult = await this.daemon.send(
        stepDecision.action.name,
        stepDecision.action.payload
      );

      // 4. REFLECT: Store observation
      history.push({
        step: stepCount,
        thought: stepDecision.thought,
        action: stepDecision.action,
        observation: actionResult.result || actionResult.error,
      });

      // Brief delay to let GUI state settle before next perception cycle
      await new Promise((resolve) => setTimeout(resolve, 800));
    }

    return "Goal aborted: Reached maximum step limit.";
  }
}