// src/adaptation/daily-adaptation.ts
//
// A human-checkpointed daily engine: it reads goals, analyzes real system
// signals, and writes a report proposing capability gaps and a candidate
// next objective — it never writes code and never registers a new MCP
// tool itself. If it identifies a candidate objective, the most it does
// is call the SAME entry point a live user's own objectives already go
// through (AutonomousExecutive.executeObjective), which halts at
// awaiting_consult for any objective classified with a coding step —
// the existing human-confirmation gate is never bypassed.
import { Type } from "@google/genai";
import { toGroqSchema } from "../runtime/groq-client.js";
import type { CognitionRouter } from "../runtime/cognition-router.js";
import { ObservationPlatform } from "../kernel/observation.js";
import * as objectivesRepo from "../kernel/state/objectives-repo.js";
import * as buildRequestsRepo from "../kernel/state/build-requests-repo.js";
import * as analyzer from "./analyzer.js";
import * as obsidian from "../capabilities/providers/obsidian.js";
import { SessionState } from "../cognition/session.js";
import { pushNotification } from "../kernel/scheduler.js";
import { AutonomousExecutive } from "../executive/autonomous_executive.js";

const observation = ObservationPlatform.getInstance();

let configuredRouter: CognitionRouter | null = null;
export function configureGroq(router: CognitionRouter | null): void {
  configuredRouter = router;
}

const ADAPTATION_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    reflectionText: { type: Type.STRING, description: "A short, honest written reflection on the current state of the project given the objectives and analysis signals below — 2-4 sentences." },
    capabilityGaps: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Concrete, specific capability or tooling gaps this analysis suggests — empty array if none stand out." },
    candidateObjective: { type: Type.STRING, description: "One concrete, actionable next objective phrased as an imperative starting with 'Implement:' or 'Build:' (so it's classified as coding work and requires human direction confirmation before any code is touched), or \"\" if nothing concrete stands out today." },
  },
  required: ["reflectionText", "capabilityGaps", "candidateObjective"],
};

export async function runDailyAdaptation(username = "admin"): Promise<{ ok: boolean; reportPath: string; candidateObjectiveStarted: boolean }> {
  const dateStr = new Date().toISOString().slice(0, 10);
  const reportPath = `Adaptation/${dateStr}`;
  try {
    const objectives = await objectivesRepo.listActiveObjectives(username);
    const analysis = {
      architecture: analyzer.analyzeArchitecture(),
      quality: analyzer.analyzeQuality(),
      performance: analyzer.analyzePerformance(),
      security: analyzer.analyzeSecurity(),
    };

    const issuesSummary = Object.entries(analysis)
      .map(([name, result]) => `${name}: score ${result.score}, ${result.issues.length} issue(s)${result.issues.length ? ` (${result.issues.slice(0, 3).map(i => i.message).join("; ")})` : ""}`)
      .join("\n");

    let reflectionText = "No cognition router configured — unable to generate a written reflection today.";
    let capabilityGaps: string[] = [];
    let candidateObjective = "";

    if (configuredRouter) {
      const objectivesSummary = objectives.length > 0
        ? objectives.map(o => `- ${o.description}`).join("\n")
        : "(no active objectives)";

      // Guarded independently of the outer try/catch: a cognition-router
      // outage here must degrade to the same placeholder text used when no
      // router is configured at all, not skip the report/notification
      // entirely — the whole point of graceful degradation is that an LLM
      // failure on any given day still leaves a report with real analyzer
      // signals.
      try {
        const response = await configuredRouter.generateWithFallback(
          username,
          {
            messages: [{
              role: "user",
              content:
                "You are Jarvis's own daily self-adaptation reflection. Given the current active objectives and real, computed system-analysis signals below, " +
                "write a short honest reflection, list any concrete capability gaps you notice, and propose exactly one candidate next objective if something " +
                "concrete stands out — leave it empty if nothing does. Do not invent problems that aren't supported by the signals.\n\n" +
                `Active objectives:\n${objectivesSummary}\n\nAnalysis signals:\n${issuesSummary}`,
            }],
            response_format: {
              type: "json_schema",
              json_schema: { name: "daily_adaptation", schema: toGroqSchema(ADAPTATION_SCHEMA), strict: true },
            },
          },
          ["groq:openai/gpt-oss-20b"]
        );
        const parsed = JSON.parse(response.choices[0]?.message?.content || "{}");
        reflectionText = typeof parsed.reflectionText === "string" ? parsed.reflectionText : reflectionText;
        capabilityGaps = Array.isArray(parsed.capabilityGaps) ? parsed.capabilityGaps : [];
        candidateObjective = typeof parsed.candidateObjective === "string" ? parsed.candidateObjective : "";
      } catch (err: any) {
        observation.logTelemetry("warn", "Adaptation", `Cognition router reflection call failed: ${err.message} — falling back to a signals-only report.`);
        reflectionText = `Cognition router reflection call failed today (${err.message}) — this report reflects only the computed analyzer signals below.`;
      }
    }

    await obsidian.writeAdaptationReport(dateStr, reflectionText, capabilityGaps, candidateObjective, issuesSummary);

    let candidateObjectiveStarted = false;
    if (candidateObjective) {
      // Same double-check executeObjectiveLocked itself does before opening
      // a new build request — don't even attempt a call that would just
      // return early, and don't disturb a build the user is already mid-way
      // through confirming/gating.
      const [alreadyAwaiting, alreadyGated] = await Promise.all([
        buildRequestsRepo.getLatestAwaitingConsult(username),
        buildRequestsRepo.getLatestPendingRewardGate(username),
      ]);
      if (!alreadyAwaiting && !alreadyGated) {
        // A fresh, throwaway SessionState — deliberately NOT the shared,
        // cached session getSession(username) would return. That instance
        // is the user's live conversational state (executeObjectiveLocked
        // clears its dialogue and overwrites its currentMission/
        // executiveStatus); an unattended 3am run must not clobber a real
        // chat the user might be mid-way through.
        const session = new SessionState();
        await AutonomousExecutive.getInstance().executeObjective(candidateObjective, session, username);
        candidateObjectiveStarted = true;
      }
    }

    pushNotification(
      username,
      `Daily adaptation ran, sir — wrote today's report to the vault${candidateObjectiveStarted ? ", and started researching a candidate next objective (I'll consult you before any code changes)." : "."}`,
      "info"
    );

    return { ok: true, reportPath, candidateObjectiveStarted };
  } catch (err: any) {
    observation.logTelemetry("warn", "Adaptation", `runDailyAdaptation failed: ${err.message}`);
    return { ok: false, reportPath, candidateObjectiveStarted: false };
  }
}
