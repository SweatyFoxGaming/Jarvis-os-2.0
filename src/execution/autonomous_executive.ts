import { ObservationPlatform } from "../kernel/observation.js";
import { GoogleGenAI } from "@google/genai";
import Groq from "groq-sdk";
import { MindKernel } from "../cognition/kernel/kernel.js";
import { SessionState } from "../cognition/session.js";
import * as commandProposalsRepo from "../kernel/state/command-proposals-repo.js";
import * as buildRequestsRepo from "../kernel/state/build-requests-repo.js";
import * as departments from "./departments.js";
import * as scheduler from "../kernel/scheduler.js";

/**
 * Phase XIII: Executive Coordinator (formerly Autonomous Executive)
 * Acts as an orchestrator/coordinator.
 *
 * Decomposes a free-text objective into department-tagged steps (real
 * dispatch via src/execution/departments.ts when Gemini is available).
 * An objective with a 'coding' step branches into the build_requests
 * lifecycle (real research -> human consult -> confirmed direction -> real
 * drafted code -> human approval -> real GitHub PR -> real QA review) —
 * see docs/superpowers/specs/2026-07-21-agent-departments-design.md. An
 * objective with no coding step gets real research for each step, same
 * lighter-weight shape this planner always had, just no longer narrated.
 */
export class AutonomousExecutive {
  private static instance: AutonomousExecutive | null = null;
  private observation: ObservationPlatform;
  // Kept for future needs (per the Groq-migration design) even though no current internal call reads it — every departments.* call below uses this.groq.
  private ai: GoogleGenAI | null;
  private groq: Groq | null;

  private constructor(observation: ObservationPlatform, ai: GoogleGenAI | null, groq: Groq | null) {
    this.observation = observation;
    this.ai = ai;
    this.groq = groq;
  }

  // A singleton (like the other cognition engines) rather than a plain
  // constructor so tools.ts's decompose_plan/confirm_build_direction tools
  // can reach the same instance server.ts already created at startup with
  // the real ai/groq clients, instead of needing a circular import back
  // into server.ts.
  public static getInstance(observation?: ObservationPlatform, ai?: GoogleGenAI | null, groq?: Groq | null): AutonomousExecutive {
    if (!this.instance) {
      if (!observation) {
        throw new Error("AutonomousExecutive.getInstance() called before server.ts initialized it");
      }
      this.instance = new AutonomousExecutive(observation, ai ?? null, groq ?? null);
    }
    return this.instance;
  }

  public async executeObjective(objective: string, session: SessionState, username: string): Promise<any> {
    const kernel = MindKernel.getInstance();
    const workspace = session.workspace;

    this.observation.logTelemetry("info", "Executive", `Coordinator: Initiating Autonomous Objective: "${objective}"`);

    session.dialogue.clear();
    session.dialogue.recordTurn("CEO", `We have received a new high-level objective: "${objective}". Let's decompose and coordinate execution.`);
    session.dialogue.recordTurn("Architect", "We should decompose this into concrete steps, each owned by a real department.");

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
      currentGoal: `Autonomous Fulfillment: ${objective}`,
      currentThought: "Planning Departments",
      executiveStatus: "Planning",
      attentionTarget: session.attentionEngine.determineAttention({ activeGoal: `Autonomous Fulfillment: ${objective}` }),
    }, this.observation);

    workspace.mission.progressPercent = 30;
    await this.delay(300);

    // --- STAGE 3: Department-Tagged Decomposition ---
    const steps = await departments.decomposeObjective(objective, this.groq, kernel.offlineMode);
    const hasCodingStep = steps.some(s => s.department === "coding");

    session.updateState({
      currentPlan: steps.map(s => `[${s.department}] ${s.step}`),
      currentThought: hasCodingStep ? "Starting Research For Build Request" : "Researching",
      executiveStatus: "Executing",
      activeCapability: hasCodingStep ? "Build Request Pipeline" : "Research Department",
      attentionTarget: session.attentionEngine.determineAttention({ hasIncompletePlan: true }),
    }, this.observation);

    workspace.mission.progressPercent = 50;
    await this.delay(200);

    // Computed once, shared by both branches below, instead of a bare magic
    // number in the build-request branch's decision trace — same real
    // command-outcome-driven signal every other confidence score in this
    // codebase uses.
    const recentOutcomeSuccessRate = await commandProposalsRepo.getRecentOutcomeSuccessRate();
    const calculatedConfidence = session.confidenceModel.calculateOverallConfidence({
      memoryConfidence: 1.0,
      toolConfidence: 1.0,
      validationConfidence: 1.0,
      capabilityConfidence: 1.0,
      environmentConfidence: 1.0,
      ...(recentOutcomeSuccessRate !== null ? { outcomeConfidence: recentOutcomeSuccessRate } : {})
    });

    // --- STAGE 4a: Build Request Branch (real research -> stop for consult) ---
    if (hasCodingStep) {
      const buildRequest = await buildRequestsRepo.createBuildRequest(objective, username);
      const research = await departments.runResearch(objective, this.groq);
      const recorded = await buildRequestsRepo.recordResearch(buildRequest.id, research.summary);

      if (!recorded) {
        await buildRequestsRepo.markResearchError(buildRequest.id, "Failed to persist research findings.");
        session.updateState({ currentThought: "Idle", executiveStatus: "Idle", activeCapability: null }, this.observation);
        workspace.mission.status = "failed";
        return {
          objective,
          status: "error",
          buildRequestId: buildRequest.id,
          message: "Research completed but couldn't be saved — please try again.",
        };
      }

      scheduler.pushNotification(
        username,
        `I've done some research on "${objective}", sir. ${research.summary.slice(0, 300)}${research.summary.length > 300 ? "..." : ""} ` +
          `Let's talk through direction before I draft anything — build request #${buildRequest.id}.`,
        "info"
      );

      session.dialogue.recordTurn("Research", "Real research complete — findings stored, awaiting your input on direction.");
      session.dialogue.recordTurn("Decision", `Build request #${buildRequest.id} is awaiting your consultation.`);

      session.updateState({
        currentThought: "Awaiting Consultation",
        executiveStatus: "Idle",
        activeCapability: null,
        attentionTarget: session.attentionEngine.determineAttention({}),
      }, this.observation);
      workspace.mission.progressPercent = 60;
      workspace.mission.status = "in_progress";

      this.observation.recordDecisionTrace({
        intent: `Autonomous Execution: "${objective}"`,
        goals: [`Complete: ${objective}`, "Research before building", "Confirm direction before coding"],
        strategy: "Real department dispatch — build request lifecycle",
        planner: steps.map(s => s.step),
        capabilitySelection: ["Research Department"],
        reasoning: `Objective required real code, so a build request (#${buildRequest.id}) was created. Real research ran and is stored; coding is deferred until the user confirms direction.`,
        knowledgeUsed: workspace.userContext.loadedFacts,
        executionResult: `Build request #${buildRequest.id} created, research stored, awaiting consult.`,
        reflection: "This objective needs a human conversation before any code gets written — that boundary is by design, not a limitation.",
        confidence: calculatedConfidence / 100
      });

      return {
        objective,
        status: "awaiting_consult",
        buildRequestId: buildRequest.id,
        researchSummary: research.summary,
        message: "Research is done and stored. I'll discuss it with you before drafting any code — nothing gets built until you confirm direction.",
      };
    }

    // --- STAGE 4b: No coding step — real research for every step, same
    // lighter-weight shape this planner always had, just no longer narrated. ---
    const findings: string[] = [];

    for (let i = 0; i < steps.length; i++) {
      const { step } = steps[i];
      workspace.plan.currentStepIndex = i;

      session.updateState({
        attentionTarget: session.attentionEngine.determineAttention({ emergency: null, userRequest: step }),
      }, this.observation);
      workspace.attention.focusOn(step);

      const research = await departments.runResearch(step, this.groq);
      const resultText = `[Research] ${research.summary}`;

      workspace.capabilities.recordResult({ step, outcome: "success", summary: resultText });
      this.observation.logTelemetry("info", "Executive", `[Stage 4] Step ${i + 1} researched for real.`);
      findings.push(resultText);
    }

    // --- STAGE 5: Output Aggregation ---
    session.dialogue.recordTurn("QA", "All steps researched for real.");
    session.dialogue.recordTurn("Decision", `Objective "${objective}" researched.`);

    const finalReport = {
      objective,
      status: "success",
      totalStepsExecuted: steps.length,
      findings,
    };

    // calculatedConfidence was already computed once, right after Stage 3,
    // shared with the build-request branch above — not recomputed here.
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
      goals: [`Complete: ${objective}`, "Decompose goals autonomously", "Research for real"],
      strategy: "Multi-stage Autonomous executive pattern",
      planner: steps.map(s => s.step),
      capabilitySelection: ["Research Department"],
      reasoning: `Completed research for all ${steps.length} step(s). Confidence: ${calculatedConfidence}%.`,
      knowledgeUsed: workspace.userContext.loadedFacts,
      executionResult: `Researched ${objective}. Status: SUCCESS`,
      reflection: "Executive coordinator loop ran via SessionState; real research was performed for every step.",
      confidence: calculatedConfidence / 100
    });

    return finalReport;
  }

  // Drives the second stage of the build_requests lifecycle: called once
  // the user has actually confirmed a direction in conversation (never
  // speculatively — see confirm_build_direction's tool description in
  // tools.ts). Resolves against the caller's own most recent
  // 'awaiting_consult' row rather than a model-recalled id — see this
  // plan's Global Constraints for why.
  public async confirmDirection(username: string, directionNotes: string): Promise<{ ok: boolean; message: string }> {
    const buildRequest = await buildRequestsRepo.getLatestAwaitingConsult(username);
    if (!buildRequest) {
      return { ok: false, message: "There's no build request of mine currently awaiting your direction to confirm." };
    }

    const confirmed = await buildRequestsRepo.recordDirectionConfirmed(buildRequest.id, directionNotes);
    if (!confirmed) {
      return { ok: false, message: "Couldn't confirm direction — that build request may have already moved on." };
    }

    await buildRequestsRepo.markCoding(confirmed.id);

    const draft = await departments.draftCodeChanges(
      confirmed.objective,
      confirmed.research_summary || "",
      directionNotes,
      this.groq
    );

    if (!draft.ok) {
      await buildRequestsRepo.markCodeDraftError(confirmed.id, draft.error);
      scheduler.pushNotification(
        username,
        `I wasn't able to draft code for build request #${confirmed.id}, sir: ${draft.error}`,
        "warning"
      );
      return { ok: false, message: `Direction confirmed, but drafting the code failed: ${draft.error}` };
    }

    const recorded = await buildRequestsRepo.recordCodeDraft(confirmed.id, draft.summary, draft.files);
    if (!recorded) {
      await buildRequestsRepo.markCodeDraftError(confirmed.id, "Failed to persist the drafted code.");
      return { ok: false, message: "Direction confirmed and code drafted, but I couldn't save it — please try again." };
    }

    scheduler.pushNotification(
      username,
      `I've drafted the code for build request #${confirmed.id}, sir: ${draft.summary}. It's waiting for your approval in the dashboard before I open a pull request.`,
      "info"
    );

    return {
      ok: true,
      message: `Direction confirmed. I've drafted ${draft.files.length} file(s) — build request #${confirmed.id} is now waiting for your approval before I open a pull request.`,
    };
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
