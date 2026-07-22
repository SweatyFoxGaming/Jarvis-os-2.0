import type Groq from "groq-sdk";
import { ObservationPlatform } from "./observation.js";
import * as emailIntegration from "../integrations/email.js";
import * as briefing from "../execution/briefing.js";
import * as briefingRepo from "./state/briefing-repo.js";
import * as identity from "../self/identity.js";
import * as identityRepo from "./state/identity-repo.js";
import * as objectivesRepo from "./state/objectives-repo.js";
import * as push from "../integrations/push.js";
import * as mcpServersRepo from "./state/mcp-servers-repo.js";
import * as mcpRegistry from "../execution/mcp-registry.js";

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
 *
 * Only the *notification* is gated on novelty — the persisted briefing
 * record always reflects the full current state. Without this, the same
 * still-unread email or still-open GitHub notification got renotified every
 * single run (previously hourly) forever, since collectSignals() has no
 * concept of "already reported" — that's a genuinely different concern from
 * generateBriefing()'s job of answering "what's the current state" correctly
 * for an on-demand /get_briefing chat request, which must keep seeing it.
 */
let seenBriefingItemIds = new Set<string>();

export function startBriefingJob(groq: Groq | null, intervalMs = 60 * 60 * 1000): NodeJS.Timeout {
  return registerJob("proactive-briefing", intervalMs, async () => {
    const result = await briefing.generateBriefing(groq, "admin");
    try {
      await briefingRepo.saveBriefing(result.text, result.itemCount, result.items);
    } catch (err: any) {
      observation.logTelemetry("warn", "Briefing", `Failed to persist briefing: ${err.message}`);
    }

    const freshItems = result.items.filter(i => !seenBriefingItemIds.has(i.id));
    // Replace (not just add to) the seen set with exactly this run's open
    // item ids — self-prunes ids for anything no longer open (read,
    // archived, marked done) instead of growing unbounded forever.
    seenBriefingItemIds = new Set(result.items.map(i => i.id));

    if (freshItems.length > 0) {
      const freshText = await briefing.synthesizeBriefing(groq, freshItems, []);
      pushNotification("admin", freshText, freshItems.some(i => i.urgency === "high") ? "warning" : "info");
    }

    // Stamp last_checked_at for every objective this run actually surfaced
    // (whether or not it was "fresh" by the in-memory tracker above — an
    // objective only appears here at all because objectives-repo.ts's own
    // collectDueObjectives() already decided it was due, so every
    // appearance here is a real check-in worth recording).
    const objectiveIds = result.items
      .filter(i => i.source === "objective")
      .map(i => Number(i.id.split(":")[1]));
    await objectivesRepo.markCheckedIn(objectiveIds);
  });
}

/**
 * The autonomous-initiative half of continuity-of-self — periodically
 * synthesizes one genuine reflective thought from real recorded
 * self-reflections (see self/identity.ts) and pushes it as a
 * notification, so something resembling an ongoing internal life happens
 * between conversations instead of only ever reacting to one. Honestly
 * no-ops (no notification, nothing persisted) when there isn't enough real
 * self-reflection history yet rather than fabricating a thought from
 * nothing.
 */
export function startSelfReflectionJob(groq: Groq | null, intervalMs = 6 * 60 * 60 * 1000): NodeJS.Timeout {
  return registerJob("proactive-self-reflection", intervalMs, async () => {
    if (!groq) return;
    const result = await identity.generateProactiveThought(groq);
    if (!result) return;
    try {
      await identityRepo.saveProactiveThought(result.content, result.basedOnCount);
    } catch (err: any) {
      observation.logTelemetry("warn", "Identity", `Failed to persist proactive thought: ${err.message}`);
    }
    pushNotification("admin", result.content, "info");
  });
}

// Tracks consecutive reconnect failures per server, in-memory only — reset
// on a successful reconnect or a restart. This is deliberately ephemeral
// (unlike command_proposals/objectives' Postgres-backed durability): a
// restart re-attempting from a clean slate for "how many times has this
// server failed in a row" is the correct behavior here, not a bug — a
// server that was flapping before a restart gets a fresh chance, exactly
// like `seenBriefingItemIds`'s existing ephemeral novelty tracking.
const consecutiveFailures = new Map<number, number>();
const MCP_HEALTH_CHECK_FAILURE_THRESHOLD = 3;

export function startMcpHealthCheckJob(intervalMs = 30 * 60 * 1000): NodeJS.Timeout {
  return registerJob("mcp-health-check", intervalMs, async () => {
    const servers = await mcpServersRepo.listMcpServers("approved");
    for (const server of servers) {
      const reconnected = await mcpRegistry.refreshServerConnection(server.id);
      if (reconnected) {
        consecutiveFailures.delete(server.id);
        continue;
      }
      const failures = (consecutiveFailures.get(server.id) ?? 0) + 1;
      consecutiveFailures.set(server.id, failures);
      if (failures >= MCP_HEALTH_CHECK_FAILURE_THRESHOLD) {
        await mcpServersRepo.setMcpServerStatus(server.id, "error");
        observation.logTelemetry("warn", "McpHealthCheck", `Server "${server.name}" (#${server.id}) failed to reconnect ${failures} times in a row — marked 'error'.`);
        consecutiveFailures.delete(server.id);
      }
    }
  });
}
