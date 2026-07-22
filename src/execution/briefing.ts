import { ObservationPlatform } from "../observation/index.js";
import * as emailIntegration from "../integrations/email.js";
import * as github from "../integrations/github.js";
import * as objectivesRepo from "../data/objectives-repo.js";
import Groq from "groq-sdk";

const observation = ObservationPlatform.getInstance();

// Set once from server.ts at startup so the get_briefing chat tool
// (tools.ts) can generate a real briefing without server.ts needing to
// export its module-scoped `groq` variable directly.
let configuredGroq: Groq | null = null;
export function configureGroq(client: Groq | null): void {
  configuredGroq = client;
}
export function getConfiguredGroq(): Groq | null {
  return configuredGroq;
}

/**
 * The "proactive" half of the vision — everything else in this codebase
 * only acts when a chat message arrives. This runs on a schedule
 * (src/execution/scheduler.ts's briefing job) and synthesizes real signals
 * from every connected source into one readable summary, instead of Jarvis
 * only ever noticing something when asked.
 */

export interface PrioritizedItem {
  id: string; // stable across runs (email UID / GitHub notification id / objective id) — lets a caller dedup against what it already notified about
  source: "email" | "github" | "objective";
  urgency: "high" | "medium" | "low";
  summary: string;
  ageHours?: number;
}

// ---------- Signal collection (best-effort, one source failing never blocks another) ----------

export interface RawSignals {
  emails: any[];
  githubNotifications: any[];
  objectives: import("../data/objectives-repo.js").ObjectiveRow[];
  emailError?: string;
  githubError?: string;
  objectivesError?: string;
}

export async function collectSignals(username: string): Promise<RawSignals> {
  const signals: RawSignals = { emails: [], githubNotifications: [], objectives: [] };

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

  try {
    signals.objectives = await objectivesRepo.collectDueObjectives(username);
  } catch (err: any) {
    signals.objectivesError = err.message || String(err);
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
      id: `email:${email.uid}`,
      source: "email",
      urgency: stale ? "high" : "medium",
      summary: `"${email.subject || "(no subject)"}" from ${email.from?.[0] || "unknown"}${stale ? ` — unread ${Math.round(ageHours)}h` : ""}`,
      ageHours,
    });
  }

  for (const n of signals.githubNotifications) {
    const urgency = GITHUB_REASON_URGENCY[n.reason] || "low";
    items.push({
      id: `github:${n.id}`,
      source: "github",
      urgency,
      summary: `[${n.reason}] ${n.repository?.full_name || "unknown repo"}: "${n.subject?.title || "untitled"}"`,
    });
  }

  const now = Date.now();
  for (const obj of signals.objectives) {
    const daysUntilDue = obj.target_date
      ? (new Date(obj.target_date).getTime() - now) / 86_400_000
      : undefined;
    const urgent = daysUntilDue !== undefined && daysUntilDue <= 3; // includes overdue (negative values)
    items.push({
      id: `objective:${obj.id}`,
      source: "objective",
      urgency: urgent ? "high" : "medium",
      summary: obj.target_date
        ? `Standing goal: "${obj.description}" (target: ${obj.target_date})`
        : `Standing goal: "${obj.description}"`,
    });
  }

  const rank = { high: 3, medium: 2, low: 1 };
  return items.sort((a, b) => rank[b.urgency] - rank[a.urgency]);
}

// ---------- Synthesis: real Gemini call when available, honest plain list otherwise ----------

export async function synthesizeBriefing(groq: Groq | null, items: PrioritizedItem[], errors: string[]): Promise<string> {
  if (items.length === 0) {
    return errors.length > 0
      ? `Nothing new to report, though some sources couldn't be checked: ${errors.join("; ")}.`
      : "Nothing new since the last check — inbox and GitHub notifications are both clear.";
  }

  if (!groq) {
    const lines = items.map(i => `- [${i.urgency}] ${i.summary}`);
    return `Briefing (${items.length} item(s)):\n${lines.join("\n")}${errors.length ? `\n\nCouldn't check: ${errors.join("; ")}` : ""}`;
  }

  try {
    const response = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{
        role: "user",
        content:
          "You are JARVIS, styled after Tony Stark's AI in the Iron Man films: composed, dryly witty, " +
          "addressing the user as \"sir\" where it reads naturally. Write a short briefing paragraph " +
          "(3-5 sentences) summarizing these prioritized items, in that voice — concise and matter-of-fact, " +
          "not gushing. Lead with the highest-urgency items. Do not invent details not present below. " +
          "If nothing is urgent, say so plainly rather than manufacturing urgency.\n\n" +
          items.map(i => `[${i.urgency}] (${i.source}) ${i.summary}`).join("\n"),
      }],
    });
    return response.choices[0]?.message?.content || `Briefing (${items.length} item(s)) — synthesis returned empty, raw items: ${items.map(i => i.summary).join("; ")}`;
  } catch (err: any) {
    observation.logTelemetry("warn", "Briefing", `Groq synthesis failed, falling back to plain list: ${err.message}`);
    const lines = items.map(i => `- [${i.urgency}] ${i.summary}`);
    return `Briefing (${items.length} item(s)):\n${lines.join("\n")}`;
  }
}

export async function generateBriefing(groq: Groq | null, username: string): Promise<{ text: string; itemCount: number; items: PrioritizedItem[] }> {
  const signals = await collectSignals(username);
  const items = prioritizeSignals(signals);
  const errors = [signals.emailError, signals.githubError, signals.objectivesError].filter(Boolean) as string[];
  const text = await synthesizeBriefing(groq, items, errors);
  return { text, itemCount: items.length, items };
}
