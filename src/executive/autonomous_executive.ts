import { ObservationPlatform } from "../kernel/observation.js";
import * as obsidian from "../capabilities/providers/obsidian.js";
import { GoogleGenAI } from "@google/genai";
import type { CognitionRouter } from "../runtime/cognition-router.js";
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
import { assertConstraint } from "../self/constraints.js";
import { WebSearchService } from '../services/websearch.js';

// Top-Level Tool Definitions
export const webSearchTool = {
  name: 'web_search',
  description: 'Search the web locally using SearXNG metasearch.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query string.' },
      limit: { type: 'number', description: 'Maximum results to return (default: 5).' }
    },
    required: ['query']
  }
};

export const browserActionTool = {
  name: 'browser_action',
  description: 'Navigate to a page via Playwright to extract content or capture screenshots.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Target URL to visit.' },
      action: { type: 'string', enum: ['scrape', 'screenshot'], description: 'Action to perform on target page.' }
    },
    required: ['url']
  }
};

export interface ResearchIterationResult {
  findings: string[];
  sources: string[];
  knowledge_gaps: string[];
  confidence_score: number; // Scale from 0.0 to 1.0
  next_queries: string[];   // Specific search queries if gaps exist
}

/**
 * Phase XIII: Executive Coordinator (formerly Autonomous Executive)
 * Orchestrates autonomous task execution, research loops, and department dispatches.
 */
export class AutonomousExecutive {
  private static instance: AutonomousExecutive | null = null;
  private observation: ObservationPlatform;
  private ai: GoogleGenAI | null;
  private router: CognitionRouter | null;
  private webSearchService: WebSearchService;

  private constructor(observation: ObservationPlatform, ai: GoogleGenAI | null, router: CognitionRouter | null) {
    this.observation = observation;
    this.ai = ai;
    this.router = router;
    this.webSearchService = new WebSearchService();
  }

  public static getInstance(
    observation?: ObservationPlatform,
    ai?: GoogleGenAI | null,
    router?: CognitionRouter | null
  ): AutonomousExecutive {
    if (!this.instance) {
      if (!observation) {
        throw new Error("AutonomousExecutive.getInstance() called before server.ts initialized it");
      }
      this.instance = new AutonomousExecutive(observation, ai ?? null, router ?? null);
    }
    return this.instance;
  }

  /**
   * Tool execution dispatcher for local web search and browser actions.
   */
  public async executeToolCall(toolName: string, args: Record<string, any>): Promise<any> {
    switch (toolName) {
      case 'web_search':
        return await this.webSearchService.webSearch(args.query, args.limit);

      case 'browser_action':
        return await this.webSearchService.browserAction(args.url, args.action);

      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }
  }

  /**
   * Fans out a single gap/objective into multiple targeted search angles.
   */
  private async generateFanoutQueries(gapOrObjective: string): Promise<string[]> {
    const defaultAngles = [
      `${gapOrObjective} official documentation`,
      `${gapOrObjective} issue workaround architecture`,
      `${gapOrObjective} implementation example`
    ];

    if (!this.router && !this.ai) {
      return defaultAngles;
    }

    const fanoutPrompt = `
Decompose the following research topic into exactly 3 distinct, high-precision search queries aimed at different angles (e.g. official docs, technical troubleshooting, real-world examples):
Topic: "${gapOrObjective}"

Respond strictly with a valid JSON array of strings, e.g.:
["query angle 1", "query angle 2", "query angle 3"]
`;

    try {
      let rawResponse = '';
      if (this.ai) {
        const res = await this.ai.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: fanoutPrompt
        });
        rawResponse = res.text || '';
      } else if (this.router) {
        const res = await (this.router as any).complete({ prompt: fanoutPrompt, temperature: 0.3 });
        rawResponse = typeof res === 'string' ? res : res?.text || '';
      }

      const parsed = JSON.parse(rawResponse.trim());
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.slice(0, 3);
      }
    } catch {
      // Fall back to default angles on parsing error
    }

    return defaultAngles;
  }

  /**
   * Autonomous research loop with parallel multi-angle query fanout.
   */
  public async runResearchPipeline(initialQuery: string, maxIterations = 3): Promise<ResearchIterationResult> {
    let currentIteration = 0;
    let accumulatedFindings: string[] = [];
    let sources: string[] = [];
    let currentGaps: string[] = [];

    const systemPrompt = `
You are a precision research agent. Analyze retrieved context and respond STRICTLY in JSON format:
{
  "findings": ["point 1", "point 2"],
  "sources": ["url1", "url2"],
  "knowledge_gaps": ["missing detail 1"],
  "confidence_score": 0.85,
  "next_queries": ["query for missing detail 1"]
}
`;

    while (currentIteration < maxIterations) {
      currentIteration++;

      // 1. Generate fanout queries for targeted retrieval
      const searchTarget = currentIteration === 1 ? initialQuery : currentGaps.join(' ');
      const fanoutQueries = await this.generateFanoutQueries(searchTarget);

      // 2. Execute fanout searches in parallel
      const searchPromises = fanoutQueries.map(q =>
        this.executeToolCall('web_search', { query: q, limit: 2 }).catch(() => [])
      );
      const searchResultsArray = await Promise.all(searchPromises);

      // Flatten and deduplicate results by URL
      const aggregatedResults = searchResultsArray.flat();
      const uniqueUrls = new Set<string>();
      const topUrls: string[] = [];

      for (const res of aggregatedResults) {
        if (res?.url && !uniqueUrls.has(res.url)) {
          uniqueUrls.add(res.url);
          topUrls.push(res.url);
        }
      }

      // 3. Scrape top unique pages in parallel (capped at top 3)
      const scrapePromises = topUrls.slice(0, 3).map(url =>
        this.executeToolCall('browser_action', { url, action: 'scrape' }).catch(() => null)
      );
      const scrapedPages = await Promise.all(scrapePromises);

      topUrls.slice(0, 3).forEach(url => {
        if (!sources.includes(url)) sources.push(url);
      });

      // Pass scraped content along with accumulated findings into synthesis
      const pageContents = scrapedPages.map(p => p?.content).filter(Boolean);
      const synthesisInput = [...accumulatedFindings, ...pageContents];

      const synthesis: ResearchIterationResult = await this.invokeModelWithSchema(
        systemPrompt,
        synthesisInput,
        sources.length
      );

      accumulatedFindings.push(...synthesis.findings);
      currentGaps = synthesis.knowledge_gaps;

      if (synthesis.confidence_score >= 0.80 || currentGaps.length === 0) {
        return {
          findings: Array.from(new Set(accumulatedFindings)),
          sources,
          knowledge_gaps: currentGaps,
          confidence_score: synthesis.confidence_score,
          next_queries: []
        };
      }
    }

    return {
      findings: Array.from(new Set(accumulatedFindings)),
      sources,
      knowledge_gaps: currentGaps,
      confidence_score: 0.70,
      next_queries: []
    };
  }

  /**
   * Calculates a normalized confidence score based on model assessment, source count, and remaining gaps.
   */
  private calculateAdaptiveConfidence(
    rawModelScore: number,
    sourceCount: number,
    gapsCount: number
  ): number {
    let score = rawModelScore ?? 0.5;

    // Bonus for multi-source cross-verification
    if (sourceCount >= 3) score += 0.10;
    else if (sourceCount === 0) score -= 0.25;

    // Penalty for unhandled knowledge gaps
    if (gapsCount > 0) {
      score -= gapsCount * 0.10;
    } else {
      score += 0.05;
    }

    // Clamp between 0.0 and 1.0
    return Math.min(Math.max(parseFloat(score.toFixed(2)), 0.0), 1.0);
  }

  private async invokeModelWithSchema(
    systemPrompt: string,
    context: any,
    sourceCount = 0
  ): Promise<ResearchIterationResult> {
    const promptText = `${systemPrompt}\nContext:\n${JSON.stringify(context)}`;
    let responseText = '';

    if (this.ai) {
      try {
        const response = await this.ai.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: promptText,
        });
        responseText = response.text || '';
      } catch {
        responseText = '';
      }
    } else if (this.router) {
      try {
        const response = await (this.router as any).complete({
          prompt: promptText,
          temperature: 0.2,
        });
        responseText = typeof response === 'string' ? response : (response?.text || '');
      } catch {
        responseText = '';
      }
    }

    if (!responseText) {
      return {
        findings: Array.isArray(context) ? context : [JSON.stringify(context)],
        sources: [],
        knowledge_gaps: ['No response returned from model'],
        confidence_score: this.calculateAdaptiveConfidence(0.3, sourceCount, 1),
        next_queries: []
      };
    }
    if (!this.router) {
  return {
    findings: ["No AI client available to conduct research."],
    knowledge_gaps: [],
    sources: [],
    confidence_score: 0,
    next_queries: [],
  };
}  

    let parsed: Partial<ResearchIterationResult> = {};

    try {
      const cleaned = responseText.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
      parsed = JSON.parse(cleaned);
    } catch {
      parsed = {
        findings: [responseText],
        knowledge_gaps: ['Failed to parse structured model response'],
        confidence_score: 0.4
      };
    }

    const findings = Array.isArray(parsed.findings) ? parsed.findings : [];
    const gaps = Array.isArray(parsed.knowledge_gaps) ? parsed.knowledge_gaps : [];
    const rawScore = typeof parsed.confidence_score === 'number' ? parsed.confidence_score : 0.5;

    const adaptiveScore = this.calculateAdaptiveConfidence(rawScore, sourceCount, gaps.length);

    return {
      findings,
      sources: Array.isArray(parsed.sources) ? parsed.sources : [],
      knowledge_gaps: gaps,
      confidence_score: adaptiveScore,
      next_queries: Array.isArray(parsed.next_queries) ? parsed.next_queries : []
    };
  }

  public async executeObjective(objective: string, session: SessionState, username: string): Promise<any> {
    const started = await objectiveRunsRepo.startRun(username, objective);
    if (!started.ok && started.reason === "already_running") {
      return {
        objective,
        status: "already_running",
        message: "I'm already working on something for you, sir — let's let that finish before I start on this one.",
      };
    }

    const runId = started.ok ? started.runId : null;
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

    session.updateState({
      currentMission: objective,
      currentThought: "Understanding Request",
      executiveStatus: "Thinking",
      attentionTarget: session.attentionEngine.determineAttention({ userRequest: objective }),
    }, this.observation);

    workspace.mission.progressPercent = 10;
    workspace.mission.status = "in_progress";
    await this.delay(300);

    session.updateState({
      currentGoal: `Autonomous Fulfillment: ${objective}`,
      currentThought: "Planning Departments",
      executiveStatus: "Planning",
      attentionTarget: session.attentionEngine.determineAttention({ activeGoal: `Autonomous Fulfillment: ${objective}` }),
    }, this.observation);

    workspace.mission.progressPercent = 30;
    await this.delay(300);

    const steps = await departments.decomposeObjective(objective, this.router, kernel.offlineMode, username);
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

    const recentOutcomeSuccessRate = await commandProposalsRepo.getRecentOutcomeSuccessRate();
    const calculatedConfidence = session.confidenceModel.calculateOverallConfidence({
      memoryConfidence: 1.0,
      toolConfidence: 1.0,
      validationConfidence: 1.0,
      capabilityConfidence: 1.0,
      environmentConfidence: 1.0,
      ...(recentOutcomeSuccessRate !== null ? { outcomeConfidence: recentOutcomeSuccessRate } : {})
    });

    if (hasCodingStep) {
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

      const pendingRewardGate = await buildRequestsRepo.getLatestPendingRewardGate(username);
      if (pendingRewardGate) {
        session.updateState({ currentThought: "Idle", executiveStatus: "Idle", activeCapability: null }, this.observation);
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
      const research = await departments.runResearch(objective, this.router, username);
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
      assertConstraint(
        "human-approval-before-code-apply",
        true,
        `Objective "${objective}" requires code changes; stopped at awaiting_consult, no code drafted yet (build request #${buildRequest.id}).`
      );
      return {
        objective,
        status: "awaiting_consult",
        buildRequestId: buildRequest.id,
        researchSummary: research.summary,
        message: "Research is done and stored. I'll discuss it with you before drafting any code — nothing gets built until you confirm direction.",
      };
    }

    const findings: string[] = [];

    for (let i = 0; i < steps.length; i++) {
      const { step } = steps[i];
      workspace.plan.currentStepIndex = i;

      session.updateState({
        attentionTarget: session.attentionEngine.determineAttention({ emergency: null, userRequest: step }),
      }, this.observation);
      workspace.attention.focusOn(step);

      const research = await departments.runResearch(step, this.router, username);
      const resultText = `[Research] ${research.summary}`;

      workspace.capabilities.recordResult({ step, outcome: "success", summary: resultText });
      this.observation.logTelemetry("info", "Executive", `[Stage 4] Step ${i + 1} researched for real.`);
      findings.push(resultText);
    }

    session.dialogue.recordTurn("QA", "All steps researched for real.");
    session.dialogue.recordTurn("Decision", `Objective "${objective}" researched.`);

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

  public async confirmDirection(username: string, directionNotes: string): Promise<{ ok: boolean; message: string }> {
    const pendingRewardGate = await buildRequestsRepo.getLatestPendingRewardGate(username);
    if (pendingRewardGate) {
      return this.startCoding(pendingRewardGate, pendingRewardGate.direction_notes || directionNotes, username);
    }

    const buildRequest = await buildRequestsRepo.getLatestAwaitingConsult(username);
    if (!buildRequest) {
      return { ok: false, message: "There's no build request of mine currently awaiting your direction to confirm." };
    }

    const confirmed = await buildRequestsRepo.recordDirectionConfirmed(buildRequest.id, directionNotes);
    if (!confirmed) {
      return { ok: false, message: "Couldn't confirm direction — that build request may have already moved on." };
    }

    const rewardCheck = await rewardEventsRepo.getOverallScore("terminal_outcome");
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
        // Fall back to "main"
      }
    }

    const draft = await codingAgent.runCodingAgent(
      confirmed.id,
      confirmed.objective,
      confirmed.research_summary || "",
      directionNotes,
      baseBranch,
      username
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