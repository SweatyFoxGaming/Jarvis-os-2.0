import { GoogleGenAI } from "@google/genai";
import { ObservationPlatform } from "../observation/index.js";
import * as emailIntegration from "../integrations/email.js";
import * as github from "../integrations/github.js";

const observation = ObservationPlatform.getInstance();

// Set once from server.ts at startup so the get_briefing chat tool
// (tools.ts) can generate a real briefing without server.ts needing to
// export its module-scoped `ai` variable directly.
let configuredAi: GoogleGenAI | null = null;
export function configureAi(client: GoogleGenAI | null): void {
  configuredAi = client;
}
export function getConfiguredAi(): GoogleGenAI | null {
  return configuredAi;
}

/**
 * The "proactive" half of the vision — everything else in this codebase
 * only acts when a chat message arrives. This runs on a schedule
 * (src/execution/scheduler.ts's briefing job) and synthesizes real signals
 * from every connected source into one readable summary, instead of Jarvis
 * only ever noticing something when asked.
 */

export interface PrioritizedItem {
  source: "email" | "github";
  urgency: "high" | "medium" | "low";
  summary: string;
  ageHours?: number;
}

// ---------- Signal collection (best-effort, one source failing never blocks another) ----------

export interface RawSignals {
  emails: any[];
  githubNotifications: any[];
  emailError?: string;
  githubError?: string;
}

export async function collectSignals(): Promise<RawSignals> {
  const signals: RawSignals = { emails: [], githubNotifications: [] };

  try {
    signals.emails = await emailIntegration.fetchRecentMessages(10);
  } catch (err: any) {
    signals.emailError = err.message || String(err);
  }

  try {
    signals.githubNotifications = await github.getNotifications();
  } catch (err: any) {
    signals.githubError = err.message || String(err);
  }

  return signals;
}

// ---------- Prioritization: real urgency scoring, not decorative ----------

const GITHUB_REASON_URGENCY: Record<string, "high" | "medium" | "low"> = {
  review_requested: "high",
  mention: "high",
  assign: "medium",
  author: "medium",
  comment: "low",
  subscribed: "low",
};

export function prioritizeSignals(signals: RawSignals): PrioritizedItem[] {
  const items: PrioritizedItem[] = [];

  for (const email of signals.emails) {
    const ageHours = email.date ? (Date.now() - new Date(email.date).getTime()) / 3.6e6 : undefined;
    const stale = ageHours !== undefined && ageHours > 24;
    items.push({
      source: "email",
      urgency: stale ? "high" : "medium",
      summary: `"${email.subject || "(no subject)"}" from ${email.from?.[0] || "unknown"}${stale ? ` — unread ${Math.round(ageHours)}h` : ""}`,
      ageHours,
    });
  }

  for (const n of signals.githubNotifications) {
    const urgency = GITHUB_REASON_URGENCY[n.reason] || "low";
    items.push({
      source: "github",
      urgency,
      summary: `[${n.reason}] ${n.repository?.full_name || "unknown repo"}: "${n.subject?.title || "untitled"}"`,
    });
  }

  const rank = { high: 3, medium: 2, low: 1 };
  return items.sort((a, b) => rank[b.urgency] - rank[a.urgency]);
}

// ---------- Synthesis: real Gemini call when available, honest plain list otherwise ----------

export async function synthesizeBriefing(ai: GoogleGenAI | null, items: PrioritizedItem[], errors: string[]): Promise<string> {
  if (items.length === 0) {
    return errors.length > 0
      ? `Nothing new to report, though some sources couldn't be checked: ${errors.join("; ")}.`
      : "Nothing new since the last check — inbox and GitHub notifications are both clear.";
  }

  if (!ai) {
    const lines = items.map(i => `- [${i.urgency}] ${i.summary}`);
    return `Briefing (${items.length} item(s)):\n${lines.join("\n")}${errors.length ? `\n\nCouldn't check: ${errors.join("; ")}` : ""}`;
  }

  try {
    const response = await ai.models.generateContent({
      model: "gemini-3.1-flash-lite",
      contents: [{
        role: "user",
        parts: [{
          text:
            "You are JARVIS, styled after Tony Stark's AI in the Iron Man films: composed, dryly witty, " +
            "addressing the user as \"sir\" where it reads naturally. Write a short briefing paragraph " +
            "(3-5 sentences) summarizing these prioritized items, in that voice — concise and matter-of-fact, " +
            "not gushing. Lead with the highest-urgency items. Do not invent details not present below. " +
            "If nothing is urgent, say so plainly rather than manufacturing urgency.\n\n" +
            items.map(i => `[${i.urgency}] (${i.source}) ${i.summary}`).join("\n"),
        }],
      }],
    });
    return response.text || `Briefing (${items.length} item(s)) — synthesis returned empty, raw items: ${items.map(i => i.summary).join("; ")}`;
  } catch (err: any) {
    observation.logTelemetry("warn", "Briefing", `Gemini synthesis failed, falling back to plain list: ${err.message}`);
    const lines = items.map(i => `- [${i.urgency}] ${i.summary}`);
    return `Briefing (${items.length} item(s)):\n${lines.join("\n")}`;
  }
}

export async function generateBriefing(ai: GoogleGenAI | null): Promise<{ text: string; itemCount: number; items: PrioritizedItem[] }> {
  const signals = await collectSignals();
  const items = prioritizeSignals(signals);
  const errors = [signals.emailError, signals.githubError].filter(Boolean) as string[];
  const text = await synthesizeBriefing(ai, items, errors);
  return { text, itemCount: items.length, items };
}
