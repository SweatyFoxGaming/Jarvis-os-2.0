import { ObservationPlatform } from "../observation/index.js";
import { GoogleGenAI } from "@google/genai";
import { MindKernel } from "../cognition/kernel/kernel.js";
import { SessionState } from "../cognition/session.js";
import * as commandProposalsRepo from "../data/command-proposals-repo.js";

/**
 * Phase XIII: Executive Coordinator (formerly Autonomous Executive)
 * Acts as an orchestrator/coordinator.
 * Responsibilities:
 * 1. Receive request
 * 2. Ask Mind Kernel for state
 * 3. Determine execution path
 * 4. Delegate
 * 5. Receive result
 * 6. Update Mind Kernel
 * 7. Return response
 *
 * This planner decomposes a free-text objective into steps (via Gemini when
 * available) and narrates them — it does not execute anything itself. Real
 * delegation to a capability (GitHub/email/TTS) requires structured arguments
 * (owner/repo/title, to/subject/body, ...) that a free-text objective doesn't
 * reliably contain; that's handled by real Gemini function-calling in the
 * /api/chat path instead (src/execution/tools.ts), where the model extracts
 * those arguments directly from the conversation. Keeping this planner honest
 * about that boundary (see `simulated`/`buildVerification` below) beats
 * guessing a repo/recipient from keyword matches on a plan string.
 */
export class AutonomousExecutive {
  private static instance: AutonomousExecutive | null = null;
  private observation: ObservationPlatform;
  private ai: GoogleGenAI | null;

  private constructor(observation: ObservationPlatform, ai: GoogleGenAI | null) {
    this.observation = observation;
    this.ai = ai;
  }

  // A singleton (like the other cognition engines) rather than a plain
  // constructor so tools.ts's decompose_plan tool can reach the same
  // instance server.ts already created at startup with the real ai client,
  // instead of needing a circular import back into server.ts.
  public static getInstance(observation?: ObservationPlatform, ai?: GoogleGenAI | null): AutonomousExecutive {
    if (!this.instance) {
      if (!observation) {
        throw new Error("AutonomousExecutive.getInstance() called before server.ts initialized it");
      }
      this.instance = new AutonomousExecutive(observation, ai ?? null);
    }
    return this.instance;
  }

  public async executeObjective(objective: string, session: SessionState): Promise<any> {
    const kernel = MindKernel.getInstance();
    const workspace = session.workspace;

    this.observation.logTelemetry("info", "Executive", `Coordinator: Initiating Autonomous Objective: "${objective}"`);

    session.dialogue.clear();
    session.dialogue.recordTurn("CEO", `We have received a new high-level objective: "${objective}". Let's decompose and coordinate execution.`);
    session.dialogue.recordTurn("Architect", "We should decompose this into 4 clean sequential targets for safety and structure.");
    session.dialogue.recordTurn("Security", "This planner does not execute — structured delegation happens through chat function-calling instead.");

    // --- STAGE 1: Decompose Objective ---
    session.updateState({
      currentMission: objective,
      currentThought: "Understanding Request",
      executiveStatus: "Thinking",
      attentionTarget: session.attentionEngine.determineAttention({ userRequest: objective }),
    }, this.observation);

    workspace.mission.progressPercent = 10;
    workspace.mission.status = "in_progress";
    await this.delay(300);

    // --- STAGE 2: Formulate Goals ---
    session.updateState({
      currentGoal: `Autonomous Fullfillment: ${objective}`,
      currentThought: "Searching Memory",
      executiveStatus: "Planning",
      attentionTarget: session.attentionEngine.determineAttention({ activeGoal: `Autonomous Fullfillment: ${objective}` }),
    }, this.observation);

    workspace.mission.progressPercent = 30;
    workspace.mission.status = "in_progress";
    await this.delay(300);

    // --- STAGE 3: Proactive Task Creation ---
    let tasks = [
      `Deconstruct requirements for ${objective}`,
      `Establish logical interfaces and database contracts`,
      `Implement operational components and state machines`,
      `Run regression suite and verify QA standards`
    ];

    if (this.ai && !kernel.offlineMode) {
      try {
        const response = await this.ai.models.generateContent({
          model: "gemini-3.5-flash",
          contents: `Decompose this software objective into exactly 4 sequential plan step strings: "${objective}". Respond with the plan steps separated by newlines, with no bullet points or extra text.`,
        });
        if (response.text) {
          const lines = response.text.split("\n").map(l => l.replace(/^[-*•\d.\s]+/, "").trim()).filter(Boolean);
          if (lines.length >= 3) {
            tasks = lines.slice(0, 4);
          }
        }
      } catch (err: any) {
        this.observation.logTelemetry("warn", "Executive", `AI Planner decomposition failed: ${err.message}. Reverting to standard heuristics.`);
      }
    }

    session.updateState({
      currentPlan: tasks,
      currentThought: "Planning",
      executiveStatus: "Planning",
      attentionTarget: session.attentionEngine.determineAttention({ hasIncompletePlan: true }),
    }, this.observation);

    workspace.mission.progressPercent = 50;
    workspace.mission.status = "in_progress";
    await this.delay(300);

    // --- STAGE 4: Specialist Assembly (narrated, not executed — see class doc) ---
    session.updateState({
      currentThought: "Executing Research",
      executiveStatus: "Executing",
      activeCapability: "Specialist Swarm Assembler",
    }, this.observation);

    workspace.mission.progressPercent = 75;
    workspace.mission.status = "in_progress";

    const swarmLog: string[] = [];

    for (let i = 0; i < tasks.length; i++) {
      const step = tasks[i];
      workspace.plan.currentStepIndex = i;

      session.updateState({
        attentionTarget: session.attentionEngine.determineAttention({ emergency: null, userRequest: step }),
      }, this.observation);
      workspace.attention.focusOn(step);

      // Narrated planning output only — no code is actually written, compiled,
      // or tested here. See `simulated`/`buildVerification` on the final report.
      let swarmResult = "";
      if (i === 0) {
        swarmResult = `[Research Swarm — planned, not executed] Would verify specifications, host OS environment, and network latency.`;
      } else if (i === 1) {
        swarmResult = `[Coding Swarm — planned, not executed] Would write templates, endpoints, and database connection logic.`;
      } else if (i === 2) {
        swarmResult = `[Coding Swarm — planned, not executed] Would compile the main process loop and wire Express endpoints.`;
      } else {
        swarmResult = `[QA/Verification Swarm — planned, not executed] Would run the test harness.`;
      }

      workspace.capabilities.recordResult({ step, outcome: "success", summary: swarmResult });
      this.observation.logTelemetry("info", "Executive", `[Stage 4: Swarm Dispatch] Step ${i + 1} narrated by specialist swarm.`);
      swarmLog.push(swarmResult);
      await this.delay(200);
    }

    // --- STAGE 5: Output Aggregation & QA ---
    session.dialogue.recordTurn("QA", "All specialist swarms returned narrated (non-executed) plans.");
    session.dialogue.recordTurn("Decision", `Objective "${objective}" successfully planned.`);

    const finalReport = {
      objective,
      status: "success",
      totalStepsExecuted: tasks.length,
      swarmOutcomes: swarmLog,
      // This coordinator decomposes and narrates a plan (optionally via Gemini
      // for the step breakdown) — it does not write files, run a compiler, or
      // execute tests. For real capability execution with structured
      // arguments, use /api/chat, which supports Gemini function-calling
      // against src/execution/tools.ts.
      simulated: true,
      buildVerification: "NOT PERFORMED — no code was written, compiled, or tested."
    };

    const recentOutcomeSuccessRate = await commandProposalsRepo.getRecentOutcomeSuccessRate();
    const calculatedConfidence = session.confidenceModel.calculateOverallConfidence({
      memoryConfidence: 1.0,
      toolConfidence: 1.0,
      validationConfidence: 1.0,
      capabilityConfidence: 1.0,
      environmentConfidence: 1.0,
      ...(recentOutcomeSuccessRate !== null ? { outcomeConfidence: recentOutcomeSuccessRate } : {})
    });

    session.updateState({
      currentThought: "Preparing Response",
      executiveStatus: "Idle",
      activeCapability: null,
      confidence: calculatedConfidence,
      attentionTarget: session.attentionEngine.determineAttention({}),
    }, this.observation);

    workspace.mission.progressPercent = 100;
    workspace.mission.status = "completed";

    workspace.capabilities.recordResult(finalReport);
    workspace.plan.updateStatus("idle");
    workspace.attention.clearFocus();

    this.observation.recordDecisionTrace({
      intent: `Autonomous Execution: "${objective}"`,
      goals: [`Complete: ${objective}`, "Decompose goals autonomously", "Assemble specialist swarms"],
      strategy: "Multi-stage Autonomous executive pattern",
      planner: tasks,
      capabilitySelection: ["Specialist Swarm Assembler", "QA/Verification Swarm"],
      reasoning: `Completed all 5 stages of planning. Swarms narrated their intended steps without executing them. Confidence: ${calculatedConfidence}%.`,
      knowledgeUsed: workspace.userContext.loadedFacts,
      executionResult: `Planned ${objective}. Status: SUCCESS (planning only)`,
      reflection: "Executive coordinator loop ran via SessionState; no capability was actually invoked.",
      confidence: calculatedConfidence / 100
    });

    return finalReport;
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
