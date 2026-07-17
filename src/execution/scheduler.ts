import { ObservationPlatform } from "../observation/index.js";
import * as emailIntegration from "../integrations/email.js";

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
