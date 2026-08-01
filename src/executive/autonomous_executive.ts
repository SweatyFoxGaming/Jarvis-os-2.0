import { ObservationPlatform } from "../kernel/observation.js";
import * as obsidian from "../capabilities/providers/obsidian.js";
import { GoogleGenAI } from "@google/genai";
import Groq from "groq-sdk";
import { MindKernel } from "../self/kernel.js";
import { SessionState } from "../cognition/session.js";
import * as commandProposalsRepo from "../kernel/state/command-proposals-repo.js";
import * as buildRequestsRepo from "../kernel/state/build-requests-repo.js";
import * as departments from "./departments.js";
import * as scheduler from "../kernel/scheduler.js";
import * as codingAgent from "./coding-agent.js";
import * as builderClient from "../kernel/builder-client.js";
import * as github from "../capabilities/providers/github.js";
import * as objectiveRunsRepo from "../kernel/state/objective-runs-repo.js";
import * as rewardEventsRepo from "../kernel/state/reward-events-repo.js";

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
  public static getInstance(
    observation?: ObservationPlatform,
    ai?: GoogleGenAI | null,
    groq?: Groq | null
  ): AutonomousExecutive {
    if (!this.instance) {
      if (!observation) {
        throw new Error("AutonomousExecutive.getInstance() called before server.ts initialized it");
      }
      this.instance = new AutonomousExecutive(observation, ai ?? null, groq ?? null);
    }
    return this.instance;
  }

  // Real lock, not just bookkeeping — see objective-runs-repo.ts. Two
  // concurrent /api/executive/run calls for the same user used to race on
  // the bare in-memory SessionState singleton below (session.dialogue.clear()
  // and repeated session.updateState() calls with nothing serializing them);
  // now the second call is turned away before touching any of that shared
  // state, structurally (a Postgres unique-violation), not by caller
  // discipline. The actual work happens in executeObjectiveLocked(), a
  // near-verbatim copy of what used to be this method's entire body — kept
  // as a separate method specifically so this wrapper's try/catch can
  // guarantee the lock is always released (finishRun), including on a path
  // that throws, without re-indenting that whole body into a single
  // try block.
  public async executeObjective(objective: string, session: SessionState, username: string): Promise<any> {
    const started = await objectiveRunsRepo.startRun(username, objective);
    if (!started.ok && started.reason === "already_running") {
      return {
        objective,
        status: "already_running",
        message: "I'm already working on something for you, sir — let's let that finish before I start on this one.",
      };
    }
    // "unavailable" (Postgres unreachable) degrades to proceeding without
    // the lock, not blocking the objective — this executive already runs
    // fine with no live Postgres (e.g. the no-AI-client research fallback
    // below has never needed a DB either), and making the whole feature
    // newly depend on Postgres being up just to check a concurrency lock
    // would be a worse regression than the rare-race-condition risk it
    // reverts to. finishRun no-ops on a null runId, so this reads as "no
    // lock held" consistently below.
    const runId = started.ok ? started.runId : null;
    // Mutated by executeObjectiveLocked the moment it creates a build
    // request (STAGE 4a below), so that if something throws afterward
    // (e.g. departments.runResearch), this catch can still close out the
    // objective_runs row with the real build_request_id instead of null —
    // otherwise the audit trail would show a failed run with no link to
    // the build request that actually failed as part of it.
    const runContext: { buildRequestId: number | null } = { buildRequestId: null };

    try {
      return await this.executeObjectiveLocked(objective, session, username, runId, runContext);
    } catch (err: any) {
      await objectiveRunsRepo.finishRun(runId, "failed", runContext.buildRequestId, err.message);
      throw err;
    }
  }

  private async executeObjectiveLocked(
    objective: string,
    session: SessionState,
    username: string,
    runId: number | null,
    runContext: { buildRequestId: number | null }
  ): Promise<any> {
    const kernel = MindKernel.getInstance();
    const workspace = session.workspace;

    this.observation.logTelemetry("info", "Executive", `Coordinator: Initiating Autonomous Objective: "${objective}"`);

    session.dialogue.clear();
    session.dialogue.recordTurn("Objective", `We have received a new high-level objective: "${objective}". Let's decompose and coordinate execution.`);
    session.dialogue.recordTurn("Plan", "We should decompose this into concrete steps, each owned by a real department.");

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
      // confirmDirection() deliberately resolves against "the caller's most
      // recent awaiting_consult row" rather than a model-recalled id — a
      // consult conversation can run long enough for an id to scroll out of
      // context, the same failure mode already found and fixed for
      // record_command_outcome (see
      // docs/superpowers/specs/2026-07-21-agent-departments-design.md's
      // "Decisions" section). That shortcut is only actually safe if there's
      // ever at most one such row per user — otherwise two simultaneous
      // build requests awaiting the same user's direction cross-wire
      // silently. This is the other half of that guarantee: don't let a
      // second one start while one is still open, instead of trying to
      // disambiguate after the fact.
      const existingAwaitingConsult = await buildRequestsRepo.getLatestAwaitingConsult(username);
      if (existingAwaitingConsult) {
        session.updateState({ currentThought: "Idle", executiveStatus: "Idle", activeCapability: null }, this.observation);
        await objectiveRunsRepo.finishRun(runId, "awaiting_consult", existingAwaitingConsult.id);
        return {
          objective,
          status: "awaiting_consult",
          buildRequestId: existingAwaitingConsult.id,
          researchSummary: existingAwaitingConsult.research_summary || "",
          message: `Build request #${existingAwaitingConsult.id} ("${existingAwaitingConsult.objective}") is still awaiting your direction — let's settle that one before I start research on something else.`,
        };
      }

      // The other half of the same at-most-one-open-row guarantee: a build
      // request parked in 'direction_confirmed' by confirmDirection()'s
      // reward gate is *also* a row that confirmDirection() will resolve
      // against on the user's next "confirm direction" — and it takes
      // priority over any awaiting_consult row. Without this check a second
      // objective could sail past the guard above (its own row never being
      // in awaiting_consult status), reach awaiting_consult itself, and then
      // have the user's confirmation silently cross-wired onto the older,
      // abandoned gated request instead.
      const pendingRewardGate = await buildRequestsRepo.getLatestPendingRewardGate(username);
      if (pendingRewardGate) {
        session.updateState({ currentThought: "Idle", executiveStatus: "Idle", activeCapability: null }, this.observation);
        // Reusing the "awaiting_consult" ObjectiveRunStatus rather than widening
        // that closed union for a cosmetically distinct case — semantically this
        // is the same "parked, needs the user's attention" terminal state.
        await objectiveRunsRepo.finishRun(runId, "awaiting_consult", pendingRewardGate.id);
        return {
          objective,
          status: "awaiting_consult",
          buildRequestId: pendingRewardGate.id,
          researchSummary: pendingRewardGate.research_summary || "",
          message: `Build request #${pendingRewardGate.id} ("${pendingRewardGate.objective}") is waiting on your call, sir — my recent track record had been rough there, so I paused before starting. Say "confirm direction" again to have me proceed anyway before I can look at anything new.`,
        };
      }

      const buildRequest = await buildRequestsRepo.createBuildRequest(objective, username);
      runContext.buildRequestId = buildRequest.id;
      const research = await departments.runResearch(objective, this.groq, username);
      const recorded = await buildRequestsRepo.recordResearch(buildRequest.id, research.summary);
      if (recorded) {
        obsidian.writeResearchNote(buildRequest.id, objective, research.summary).catch((err: any) => {
          this.observation.logTelemetry("warn", "Interaction", `Failed to write research vault note: ${err.message}`);
        });
      }

      if (!recorded) {
        await buildRequestsRepo.markResearchError(buildRequest.id, "Failed to persist research findings.");
        session.updateState({ currentThought: "Idle", executiveStatus: "Idle", activeCapability: null }, this.observation);
        workspace.mission.status = "failed";
        await objectiveRunsRepo.finishRun(runId, "failed", buildRequest.id, "Failed to persist research findings.");
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

      await objectiveRunsRepo.finishRun(runId, "awaiting_consult", buildRequest.id);
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

      const research = await departments.runResearch(step, this.groq, username);
      const resultText = `[Research] ${research.summary}`;

      workspace.capabilities.recordResult({ step, outcome: "success", summary: resultText });
      this.observation.logTelemetry("info", "Executive", `[Stage 4] Step ${i + 1} researched for real.`);
      findings.push(resultText);
    }

    // --- STAGE 5: Output Aggregation ---
    session.dialogue.recordTurn("QA", "All steps researched for real.");
    session.dialogue.recordTurn("Decision", `Objective "${objective}" researched.`);

    // calculatedConfidence's outcomeConfidence term is a real rolling
    // success rate over past command outcomes (see commandProposalsRepo).
    // Until now this branch reported status: "success" unconditionally
    // regardless of that number — the score existed only for the decision
    // trace/UI to display, with nothing downstream ever reading it. This is
    // the one real gate it's wired into: if Jarvis's recent real-world
    // command track record has been poor, say so plainly instead of
    // reporting an unqualified success on the strength of research alone.
    const lowConfidence = session.confidenceModel.isLowConfidence(calculatedConfidence);
    const finalReport = {
      objective,
      status: lowConfidence ? "success_low_confidence" : "success",
      confidence: calculatedConfidence,
      totalStepsExecuted: steps.length,
      findings,
      ...(lowConfidence
        ? { note: `Confidence is low (${calculatedConfidence}%) based on recent real-world command outcomes — worth double-checking these findings before acting on them.` }
        : {}),
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

    await objectiveRunsRepo.finishRun(runId, "done", null);
    return finalReport;
  }

  public async confirmDirectionForBuildRequest(
    buildRequestId: number,
    directionNotes: string,
    username: string
  ): Promise<{ ok: boolean; message: string }> {
    // A build request sitting in 'direction_confirmed' means a prior call
    // already paused here for the reward gate below — this call is the
    // user's explicit "go ahead anyway." Reward-gate build requests are
    // resolved by username, not id, since the gate itself doesn't carry a
    // confirm-ticket (it's a re-confirmation of an already-confirmed
    // request, not a fresh awaiting_consult one).
    const pendingRewardGate = await buildRequestsRepo.getLatestPendingRewardGate(username);
    if (pendingRewardGate && pendingRewardGate.id === buildRequestId) {
      return this.startCoding(pendingRewardGate, pendingRewardGate.direction_notes || directionNotes, username);
    }

    const buildRequest = await buildRequestsRepo.getBuildRequest(buildRequestId);
    if (!buildRequest || buildRequest.status !== "awaiting_consult") {
      return { ok: false, message: "That build request isn't currently awaiting direction to confirm." };
    }

    const confirmed = await buildRequestsRepo.recordDirectionConfirmed(buildRequest.id, directionNotes);
    if (!confirmed) {
      return { ok: false, message: "Couldn't confirm direction — that build request may have already moved on." };
    }

    const rewardCheck = await rewardEventsRepo.getOverallScore("terminal_outcome");
    // First-pass threshold, not empirically tuned yet — see the design spec's Open Questions section.
    if (rewardCheck && rewardCheck.count >= 3 && rewardCheck.score < -0.5) {
      return {
        ok: true,
        message:
          `Before I start coding, sir — my recent track record here has been rough (average score ${rewardCheck.score.toFixed(2)} ` +
          `over the last ${rewardCheck.count} attempts). Want me to proceed anyway, or would you like to reconsider the plan first?`,
      };
    }

    return this.startCoding(confirmed, directionNotes, username);
  }

  private async startCoding(confirmed: buildRequestsRepo.BuildRequestRow, directionNotes: string, username: string): Promise<{ ok: boolean; message: string }> {
    const claimed = await buildRequestsRepo.markCoding(confirmed.id);
    if (!claimed) {
      return { ok: false, message: "This build request has already moved past the direction-confirmed stage — nothing more to do here." };
    }

    let baseBranch = "main";
    const owner = process.env.SELF_REPO_OWNER;
    const repoName = process.env.SELF_REPO_NAME;
    if (owner && repoName) {
      try {
        const repoInfo = await github.getRepo(owner, repoName);
        baseBranch = repoInfo.default_branch;
      } catch {
        // Fall back to "main" — matches this codebase's degrade-cleanly convention.
      }
    }

    const draft = await codingAgent.runCodingAgent(
      confirmed.id,
      confirmed.objective,
      confirmed.research_summary || "",
      directionNotes,
      baseBranch,
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

    const recorded = await buildRequestsRepo.recordCodeDraft(confirmed.id, draft.summary, draft.files, draft.modelUsed, draft.category);
    if (!recorded) {
      // runCodingAgent deliberately leaves the sandbox workspace alive on
      // success so the approval checkpoint can re-verify against it — but
      // this path never reaches that checkpoint, and the approve/reject
      // routes that normally own the teardown will never run for this build
      // request. Without this, the container and its on-disk clone leak
      // until the reaper's (now 24h) backstop.
      await builderClient.destroyWorkspace(confirmed.id).catch(() => {});
      await buildRequestsRepo.markCodeDraftError(confirmed.id, "Failed to persist the drafted code.");
      return { ok: false, message: "Direction confirmed and code drafted, but I couldn't save it — please try again." };
    }
    obsidian.writeOrUpdateCodingNote(confirmed.id, confirmed.objective, {
      directionNotes,
      codeSummary: draft.summary,
      files: draft.files.map(f => f.path),
      status: recorded.status,
    }).catch((err: any) => {
      this.observation.logTelemetry("warn", "Interaction", `Failed to write coding vault note: ${err.message}`);
    });

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
