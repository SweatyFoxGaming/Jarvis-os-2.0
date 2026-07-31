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
import Groq from "groq-sdk";
import { Type } from "@google/genai";
import { toGroqSchema } from "../runtime/groq-client.js";
import { ObservationPlatform } from "../kernel/observation.js";
import * as objectivesRepo from "../kernel/state/objectives-repo.js";
import * as buildRequestsRepo from "../kernel/state/build-requests-repo.js";
import * as analyzer from "./analyzer.js";
import * as obsidian from "../capabilities/providers/obsidian.js";
import { getSession } from "../cognition/session.js";
import { pushNotification } from "../kernel/scheduler.js";
import { AutonomousExecutive } from "../executive/autonomous_executive.js";

const observation = ObservationPlatform.getInstance();

let configuredGroq: Groq | null = null;
export function configureGroq(client: Groq | null): void {
  configuredGroq = client;
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
  // Without a configured Groq client there's nothing meaningful this run can
  // produce (no reflection, no capability gaps, no candidate objective) — so
  // this returns before touching objectives/analyzer/executive code at all,
  // rather than writing a degraded placeholder report and reporting ok: true
  // for a run that didn't actually do anything.
  if (!configuredGroq) {
    observation.logTelemetry("info", "Adaptation", "runDailyAdaptation skipped — no Groq client configured.");
    return { ok: false, reportPath, candidateObjectiveStarted: false };
  }
  try {
    const objectives = await objectivesRepo.listActiveObjectives(username);
    const analysis = {
      architecture: analyzer.analyzeArchitecture(),
      quality: analyzer.analyzeQuality(),
      performance: analyzer.analyzePerformance(),
      security: analyzer.analyzeSecurity(),
    };

    let reflectionText = "No Groq client configured — unable to generate a written reflection today.";
    let capabilityGaps: string[] = [];
    let candidateObjective = "";

    if (configuredGroq) {
      const issuesSummary = Object.entries(analysis)
        .map(([name, result]) => `${name}: score ${result.score}, ${result.issues.length} issue(s)${result.issues.length ? ` (${result.issues.slice(0, 3).map(i => i.message).join("; ")})` : ""}`)
        .join("\n");
      const objectivesSummary = objectives.length > 0
        ? objectives.map(o => `- ${o.description}`).join("\n")
        : "(no active objectives)";

      const response = await configuredGroq.chat.completions.create({
        model: "openai/gpt-oss-20b",
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
      });
      const parsed = JSON.parse(response.choices[0]?.message?.content || "{}");
      reflectionText = typeof parsed.reflectionText === "string" ? parsed.reflectionText : reflectionText;
      capabilityGaps = Array.isArray(parsed.capabilityGaps) ? parsed.capabilityGaps : [];
      candidateObjective = typeof parsed.candidateObjective === "string" ? parsed.candidateObjective : "";
    }

    await obsidian.writeAdaptationReport(dateStr, reflectionText, capabilityGaps, candidateObjective);

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
        const session = await getSession(username);
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
