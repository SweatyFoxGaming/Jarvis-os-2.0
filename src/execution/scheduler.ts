import type { GoogleGenAI } from "@google/genai";
import { ObservationPlatform } from "../observation/index.js";
import * as emailIntegration from "../integrations/email.js";
import * as briefing from "./briefing.js";
import * as briefingRepo from "../data/briefing-repo.js";
import * as identity from "../cognition/identity.js";
import * as identityRepo from "../data/identity-repo.js";
import * as push from "../integrations/push.js";

const observation = ObservationPlatform.getInstance();

export interface Notification {
  id: string;
  message: string;
  type: "info" | "success" | "warning";
  createdAt: number;
  read: boolean;
}

const MAX_NOTIFICATIONS_PER_USER = 100;
const notifications = new Map<string, Notification[]>();

export function pushNotification(username: string, message: string, type: Notification["type"] = "info"): void {
  const list = notifications.get(username) ?? [];
  list.push({ id: `notif_${Date.now()}_${Math.round(Math.random() * 1e6)}`, message, type, createdAt: Date.now(), read: false });
  while (list.length > MAX_NOTIFICATIONS_PER_USER) list.shift();
  notifications.set(username, list);
  observation.logTelemetry("info", "Scheduler", `Notification for "${username}": ${message}`);
  // Fire-and-forget: reaches subscribed devices (phone, desktop browser)
  // even when nobody has the dashboard open to poll for it — the whole
  // point of this being a push rather than the existing in-app toast.
  push.sendPushToUser(username, "Jarvis OS", message).catch(() => {});
}

export function getNotifications(username: string): Notification[] {
  return notifications.get(username) ?? [];
}

export function markAllRead(username: string): void {
  for (const n of notifications.get(username) ?? []) n.read = true;
}

/**
 * A named recurring job. Runs on a timer, independent of any HTTP request —
 * this is what makes Jarvis proactive instead of purely reactive to chat.
 * Errors are caught and logged per-run so one bad job (or one bad tick of a
 * job) never takes down the scheduler or other jobs.
 */
export function registerJob(name: string, intervalMs: number, fn: () => Promise<void> | void): NodeJS.Timeout {
  observation.logTelemetry("info", "Scheduler", `Registered job "${name}" every ${Math.round(intervalMs / 1000)}s.`);
  const run = async () => {
    try {
      await fn();
    } catch (err: any) {
      observation.logTelemetry("warn", "Scheduler", `Job "${name}" failed: ${err.message || err}`);
    }
  };
  return setInterval(run, intervalMs);
}

// ---------- Built-in jobs ----------

/**
 * Real, not simulated: polls the configured mailbox via IMAP (the same
 * integration src/integrations/email.ts already exercises) and notifies the
 * admin user when new mail has arrived since the last check. Email
 * credentials are a single shared deployment-level config (EMAIL_ and IMAP_
 * vars in .env), not per-registered-user, so this checks on behalf of "admin" only —
 * consistent with how the rest of the email integration already works.
 */
let lastSeenEmailUid: number | null = null;

export function startEmailWatchJob(intervalMs = 5 * 60 * 1000): NodeJS.Timeout | null {
  if (!process.env.IMAP_HOST || !process.env.EMAIL_USER) {
    observation.logTelemetry("info", "Scheduler", "Email watch job not started — IMAP not configured.");
    return null;
  }
  return registerJob("email-watch", intervalMs, async () => {
    const messages = await emailIntegration.fetchRecentMessages(5);
    if (messages.length === 0) return;
    const newest = messages[messages.length - 1];
    if (lastSeenEmailUid === null) {
      // First run: establish the baseline without notifying about pre-existing mail.
      lastSeenEmailUid = newest.uid;
      return;
    }
    const unseen = messages.filter((m: any) => m.uid > (lastSeenEmailUid as number));
    if (unseen.length > 0) {
      pushNotification(
        "admin",
        unseen.length === 1
          ? `New email: "${unseen[0].subject}" from ${unseen[0].from?.[0] || "unknown"}`
          : `${unseen.length} new emails, most recent: "${newest.subject}"`,
        "info"
      );
      lastSeenEmailUid = newest.uid;
    }
  });
}

/**
 * The proactive briefing job — collects real signals (email, GitHub
 * notifications), prioritizes them, synthesizes a readable summary, persists
 * it, and pushes it as a notification. This is what makes something happen
 * without a user sending a chat message first; every other capability in
 * this codebase only runs in response to a request.
 */
export function startBriefingJob(ai: GoogleGenAI | null, intervalMs = 60 * 60 * 1000): NodeJS.Timeout {
  return registerJob("proactive-briefing", intervalMs, async () => {
    const result = await briefing.generateBriefing(ai);
    try {
      await briefingRepo.saveBriefing(result.text, result.itemCount, result.items);
    } catch (err: any) {
      observation.logTelemetry("warn", "Briefing", `Failed to persist briefing: ${err.message}`);
    }
    if (result.itemCount > 0) {
      pushNotification("admin", result.text, result.items.some(i => i.urgency === "high") ? "warning" : "info");
    }
  });
}

/**
 * The autonomous-initiative half of continuity-of-self — periodically
 * synthesizes one genuine reflective thought from real recorded
 * self-reflections (see cognition/identity.ts) and pushes it as a
 * notification, so something resembling an ongoing internal life happens
 * between conversations instead of only ever reacting to one. Honestly
 * no-ops (no notification, nothing persisted) when there isn't enough real
 * self-reflection history yet rather than fabricating a thought from
 * nothing.
 */
export function startSelfReflectionJob(ai: GoogleGenAI | null, intervalMs = 6 * 60 * 60 * 1000): NodeJS.Timeout {
  return registerJob("proactive-self-reflection", intervalMs, async () => {
    if (!ai) return;
    const result = await identity.generateProactiveThought(ai);
    if (!result) return;
    try {
      await identityRepo.saveProactiveThought(result.content, result.basedOnCount);
    } catch (err: any) {
      observation.logTelemetry("warn", "Identity", `Failed to persist proactive thought: ${err.message}`);
    }
    pushNotification("admin", result.content, "info");
  });
}
