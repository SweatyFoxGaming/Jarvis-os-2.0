import type { CognitionRouter } from "../runtime/cognition-router.js";
import { ObservationPlatform } from "./observation.js";
import * as emailIntegration from "../capabilities/providers/email.js";
import * as briefing from "../world/briefing.js";
import * as briefingRepo from "./state/briefing-repo.js";
import * as identity from "../self/identity.js";
import * as identityRepo from "./state/identity-repo.js";
import * as usersRepo from "./state/users-repo.js";
import * as objectivesRepo from "./state/objectives-repo.js";
import * as push from "../interaction/push.js";
import * as mcpServersRepo from "./state/mcp-servers-repo.js";
import * as mcpRegistry from "../capabilities/mcp-registry.js";
import * as obsidian from "../capabilities/providers/obsidian.js";
import * as vaultRepo from "./state/vault-repo.js";
import * as sessionRepo from "./state/session-repo.js";
import * as transcriptEventsRepo from "./state/transcript-events-repo.js";
import * as evolutionRepo from "./state/evolution-repo.js";
import * as outcomeLedgerRepo from "./state/outcome-ledger-repo.js";
import * as wellbeing from "../self/wellbeing.js";
import * as wellbeingRepo from "./state/wellbeing-repo.js";
import { assessSystemHealth, type HealthAssessment } from "../self/health-watchdog.js";
import { positiveIntegerEnv } from "./env.js";

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
  // vault-sync in particular walks every note on disk with no size bound —
  // a run that outlasts its own interval used to let the next tick start a
  // second, fully overlapping walk against the same vault_notes/vault_links
  // rows. This flag makes every job reentrant-safe: a tick that fires while
  // the previous one is still running just logs and skips, instead of two
  // copies of the same job racing on shared state.
  let inFlight = false;
  const run = async () => {
    if (inFlight) {
      observation.logTelemetry("warn", "Scheduler", `Job "${name}" skipped a tick — the previous run is still in flight.`);
      return;
    }
    inFlight = true;
    try {
      await fn();
    } catch (err: any) {
      observation.logTelemetry("warn", "Scheduler", `Job "${name}" failed: ${err.message || err}`);
    } finally {
      inFlight = false;
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
export function startEmailWatchJob(
  intervalMs = 5 * 60 * 1000,
  fetchRecentMessages: typeof emailIntegration.fetchRecentMessages = emailIntegration.fetchRecentMessages
): NodeJS.Timeout | null {
  if (!process.env.IMAP_HOST || !process.env.EMAIL_USER) {
    observation.logTelemetry("info", "Scheduler", "Email watch job not started — IMAP not configured.");
    return null;
  }
  // Scoped to this job instance (not module-level) so each call to
  // startEmailWatchJob gets independent state — production only ever calls
  // this once at boot, so this is purely a testability improvement with no
  // behavior change there.
  let lastSeenEmailUid: number | null = null;
  return registerJob("email-watch", intervalMs, async () => {
    const messages = await fetchRecentMessages(5);
    if (messages.length === 0) return;
    // fetchRecentMessages (email.ts) returns NEWEST-FIRST (it fetches the
    // mailbox in ascending IMAP sequence order, oldest to newest, then
    // reverses the result) -- messages[0] is the newest, not
    // messages[messages.length - 1]. Reading the last element as "newest"
    // was a real bug: it pinned lastSeenEmailUid to the OLDEST of each
    // batch, so the baseline barely advanced and most of the same last-5
    // messages kept re-triggering "new email" notifications on nearly
    // every poll, regardless of whether they'd already been seen/read.
    const newest = messages[0];
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

export function startBriefingJob(router: CognitionRouter | null, intervalMs = 60 * 60 * 1000): NodeJS.Timeout {
  return registerJob("proactive-briefing", intervalMs, async () => {
    const result = await briefing.generateBriefing(router, "admin");
    try {
      await briefingRepo.saveBriefing(result.text, result.itemCount, result.items);
      obsidian.appendBriefingEntry(result.text, result.itemCount).catch((err: any) => {
        observation.logTelemetry("warn", "Interaction", `Failed to write briefing vault entry: ${err.message}`);
      });
    } catch (err: any) {
      observation.logTelemetry("warn", "Briefing", `Failed to persist briefing: ${err.message}`);
    }

    const freshItems = result.items.filter(i => !seenBriefingItemIds.has(i.id));
    // Replace (not just add to) the seen set with exactly this run's open
    // item ids — self-prunes ids for anything no longer open (read,
    // archived, marked done) instead of growing unbounded forever.
    seenBriefingItemIds = new Set(result.items.map(i => i.id));

    if (freshItems.length > 0) {
      const freshText = await briefing.synthesizeBriefing(router, freshItems, [], "admin");
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
 *
 * Runs once per real user (not once globally) — self_reflections/
 * proactive_thoughts are per-user data (see migration
 * 004_username_scope_identity_kg), so a single global thought would either
 * mix reflections drawn from multiple users' separate conversations into
 * one notification, or arbitrarily only ever reflect on whichever user
 * happened to be picked. One user's slow/failed generation can't block
 * another's — each iteration is independent and already-caught.
 */
export function startSelfReflectionJob(router: CognitionRouter | null, intervalMs = 6 * 60 * 60 * 1000): NodeJS.Timeout {
  return registerJob("proactive-self-reflection", intervalMs, async () => {
    if (!router) return;
    const usernames = await usersRepo.listUsernames();
    for (const username of usernames) {
      try {
        const result = await identity.generateProactiveThought(username, router);
        if (!result) continue;
        await identityRepo.saveProactiveThought(username, result.content, result.basedOnCount);
        obsidian.appendReflectionEntry("proactive-thought", result.content).catch((err: any) => {
          observation.logTelemetry("warn", "Interaction", `Failed to write reflection vault entry: ${err.message}`);
        });
        pushNotification(username, result.content, "info");
      } catch (err: any) {
        observation.logTelemetry("warn", "Identity", `Failed to generate/persist proactive thought for "${username}": ${err.message}`);
      }
    }
  });
}

/**
 * Proactive wellbeing check-ins — periodically asks self/wellbeing.ts
 * whether this user's real recorded signals (late-hour messaging ratio,
 * stress language in recent rapport signals) warrant a gentle, honestly
 * grounded check-in, and pushes one if so. Mirrors
 * startSelfReflectionJob's per-user isolation exactly: one user's failed
 * assessment or check-in write can't block or skip another's, and a run
 * with nothing to say (assessWellbeingSignal returns null) is a genuine,
 * expected no-op rather than an error.
 *
 * The check-in is only recorded (wellbeingRepo.recordCheckin) once a
 * message has actually been pushed — assessWellbeingSignal's own
 * MIN_DAYS_BETWEEN_CHECKINS cooldown is keyed off that same timestamp, so
 * recording it any earlier (e.g. on every tick regardless of outcome)
 * would silently suppress a real future signal without ever having told
 * the user anything.
 */
export function startWellbeingCheckJob(intervalMs = 24 * 60 * 60 * 1000): NodeJS.Timeout {
  return registerJob("wellbeing-check", intervalMs, async () => {
    const usernames = await usersRepo.listUsernames();
    for (const username of usernames) {
      try {
        const message = await wellbeing.assessWellbeingSignal(username);
        if (!message) continue;
        pushNotification(username, message, "info");
        await wellbeingRepo.recordCheckin(username);
      } catch (err: any) {
        observation.logTelemetry("warn", "Wellbeing", `Failed to assess/checkin for "${username}": ${err.message}`);
      }
    }
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

/**
 * Self-health watchdog — periodically calls assessSystemHealth() (see
 * self/health-watchdog.ts: real reachability checks for Postgres, the voice
 * daemon, llama-cpp, and ObservationPlatform, never throwing) and notifies a
 * human when something's wrong. This checks Jarvis's own operational state
 * on behalf of the whole deployment, not any one registered user — same
 * "admin" convention startBriefingJob and startEmailWatchJob already use for
 * system-level (not per-user) notifications.
 *
 * Cooldown-gated the same way startBriefingJob gates novelty: without it, a
 * persistent outage (e.g. Postgres down for hours) would renotify on every
 * single tick forever. Unlike startBriefingJob's per-item novelty tracking,
 * this only needs "is this the exact same still-open problem set I already
 * notified about, and are we still within an hour of that notification?" —
 * an exact-match comparison plus a time-based cooldown, not a diffing
 * algorithm. A genuinely NEW problem (one not in the last-notified set)
 * still notifies immediately even mid-cooldown, since that's new information
 * a human hasn't seen yet. Recovery (ok: true) resets the tracked state so a
 * later recurrence of the same problem after a real recovery notifies again
 * rather than staying suppressed forever.
 *
 * "The exact same problem set" is compared by each problem's stable `key`
 * (one fixed identifier per check — "postgres", "companion-staleness", …),
 * NEVER by its rendered message. Messages deliberately embed volatile
 * specifics (the companion-staleness one interpolates the two short SHAs),
 * so comparing message strings meant the identical unresolved problem looked
 * brand-new every time repo HEAD moved, and the cooldown never suppressed
 * anything. The messages are still what gets sent to the human — only the
 * dedup identity changed.
 *
 * runAssessment defaults to the real assessSystemHealth, mirroring
 * assessSystemHealth's own dependency-injection pattern — tests inject a
 * fake here instead of trying to mock real Postgres/voice-daemon/llama-cpp
 * reachability, exactly as health-watchdog.ts's own tests inject fake
 * HealthWatchdogDeps rather than hitting real infrastructure.
 */
export function startSelfHealthCheckJob(
  intervalMs = 10 * 60 * 1000,
  runAssessment: () => Promise<HealthAssessment> = assessSystemHealth
): NodeJS.Timeout {
  let lastNotifiedKeys: string[] = [];
  let lastNotifiedAt = 0;
  const NOTIFY_COOLDOWN_MS = 60 * 60 * 1000;

  return registerJob("self-health-check", intervalMs, async () => {
    const { ok, problems } = await runAssessment();
    if (ok) {
      lastNotifiedKeys = [];
      return;
    }

    const keys = [...new Set(problems.map(p => p.key))];
    const sameAsLastNotified =
      keys.length === lastNotifiedKeys.length &&
      keys.every(k => lastNotifiedKeys.includes(k));
    const withinCooldown = Date.now() - lastNotifiedAt < NOTIFY_COOLDOWN_MS;

    if (sameAsLastNotified && withinCooldown) return;

    const message = `Self-health check found ${problems.length} problem(s):\n${problems.map(p => `- ${p.message}`).join("\n")}`;
    pushNotification("admin", message, "warning");
    lastNotifiedKeys = keys;
    lastNotifiedAt = Date.now();
  });
}

/**
 * Keeps vault_notes/vault_links in sync with the real vault on disk —
 * reacting to edits the user makes directly in Obsidian, which Jarvis has
 * no other way to observe. Only re-parses a file whose content actually
 * changed (via a cheap content hash), so a large vault with mostly-static
 * notes stays fast on every tick. Only runs at all if OBSIDIAN_VAULT_DIR is
 * configured — same "absent env var means the feature quietly doesn't
 * start" pattern as startEmailWatchJob.
 */
// Two tables grow forever with no other cleanup: conversation_history
// (every chat message, every user — the read side already only ever looks
// at the most recent 50 per user) and transcript_events (full stdout/stderr
// per shell command in a coding session — only ever read back while that
// build request is still under review). A daily sweep is frequent enough
// that no single run has much to do, cheap enough not to matter, and
// infrequent enough not to be worth a shorter interval. Both retention
// windows are configurable since "how long is worth keeping" is a genuine
// operator judgment call, not something this codebase should hardcode
// confidently on someone else's behalf.
// positiveIntegerEnv, not `Number(x) || fallback`: a negative retention-days
// value would otherwise flip the prune queries' `now() - ($1 * interval '1
// day')` into matching (and deleting) every row in the table — see
// kernel/env.ts for the full story on why `||` isn't safe here.
const CONVERSATION_RETENTION_DAYS = positiveIntegerEnv(process.env.CONVERSATION_RETENTION_DAYS, 180);
const TRANSCRIPT_RETENTION_DAYS = positiveIntegerEnv(process.env.TRANSCRIPT_RETENTION_DAYS, 30);
// self_reflections/proactive_thoughts are genuine identity-continuity data
// (read back into every system prompt via buildIdentityContext), so they get
// the same generous window as conversation_history rather than the shorter
// transcript-log-style one. evolution_analyses is only ever manually
// triggered (not a recurring job) and its own read functions (getTrend/
// getAllAnalyses) only ever look at the most recent 30-50 rows per type, so
// it can safely use a shorter window without losing anything either
// function actually reads. Found by a follow-up security review — these
// three had no cap at all until now, unlike the two above.
const SELF_REFLECTION_RETENTION_DAYS = positiveIntegerEnv(process.env.SELF_REFLECTION_RETENTION_DAYS, 180);
const PROACTIVE_THOUGHT_RETENTION_DAYS = positiveIntegerEnv(process.env.PROACTIVE_THOUGHT_RETENTION_DAYS, 180);
const EVOLUTION_ANALYSIS_RETENTION_DAYS = positiveIntegerEnv(process.env.EVOLUTION_ANALYSIS_RETENTION_DAYS, 90);
// Same middle-ground default as evolution analyses: outcome_ledger backs a
// "recent success rate" signal that's already windowed to the most recent
// 20 confirmed outcomes, so it doesn't need long retention for that purpose
// — this default just keeps enough history for a user to review "did that
// email I sent last month actually go out."
const OUTCOME_LEDGER_RETENTION_DAYS = positiveIntegerEnv(process.env.OUTCOME_LEDGER_RETENTION_DAYS, 90);

export function startDataRetentionJob(intervalMs = 24 * 60 * 60 * 1000): NodeJS.Timeout {
  return registerJob("data-retention", intervalMs, async () => {
    const [prunedMessages, prunedTranscripts, prunedReflections, prunedThoughts, prunedAnalyses, prunedOutcomes] = await Promise.all([
      sessionRepo.pruneOldMessages(CONVERSATION_RETENTION_DAYS),
      transcriptEventsRepo.pruneOldTranscriptEvents(TRANSCRIPT_RETENTION_DAYS),
      identityRepo.pruneOldSelfReflections(SELF_REFLECTION_RETENTION_DAYS),
      identityRepo.pruneOldProactiveThoughts(PROACTIVE_THOUGHT_RETENTION_DAYS),
      evolutionRepo.pruneOldAnalyses(EVOLUTION_ANALYSIS_RETENTION_DAYS),
      outcomeLedgerRepo.pruneOldEntries(OUTCOME_LEDGER_RETENTION_DAYS),
    ]);
    if (prunedMessages > 0 || prunedTranscripts > 0 || prunedReflections > 0 || prunedThoughts > 0 || prunedAnalyses > 0 || prunedOutcomes > 0) {
      observation.logTelemetry(
        "info",
        "DataRetention",
        `Pruned ${prunedMessages} conversation message(s) older than ${CONVERSATION_RETENTION_DAYS}d, ` +
          `${prunedTranscripts} transcript event(s) older than ${TRANSCRIPT_RETENTION_DAYS}d, ` +
          `${prunedReflections} self-reflection(s) older than ${SELF_REFLECTION_RETENTION_DAYS}d, ` +
          `${prunedThoughts} proactive thought(s) older than ${PROACTIVE_THOUGHT_RETENTION_DAYS}d, ` +
          `${prunedAnalyses} evolution analysis/analyses older than ${EVOLUTION_ANALYSIS_RETENTION_DAYS}d, and ` +
          `${prunedOutcomes} outcome ledger entr(y/ies) older than ${OUTCOME_LEDGER_RETENTION_DAYS}d.`
      );
    }
  });
}

export function startVaultSyncJob(intervalMs = 15 * 60 * 1000): NodeJS.Timeout | null {
  if (!process.env.OBSIDIAN_VAULT_DIR) {
    observation.logTelemetry("info", "Scheduler", "Vault sync job not started — OBSIDIAN_VAULT_DIR not configured.");
    return null;
  }
  return registerJob("vault-sync", intervalMs, async () => {
    const paths = await obsidian.listAllNotePaths();
    for (const notePath of paths) {
      try {
        await obsidian.syncNoteToIndex(notePath);
      } catch (err: any) {
        observation.logTelemetry("warn", "VaultSync", `Failed to sync "${notePath}": ${err.message}`);
      }
    }

    // Prune rows for notes deleted directly in Obsidian since the last
    // sync — otherwise a note removed on disk lingers in the index
    // forever, since the walk-and-upsert loop above only ever adds/updates.
    // vault_links rows for the deleted note are handled automatically via
    // ON DELETE CASCADE on vault_links.from_path.
    const freshPaths = new Set(paths);
    const indexed = await vaultRepo.listNotes();
    for (const row of indexed) {
      if (freshPaths.has(row.path)) continue;
      try {
        await vaultRepo.deleteNote(row.path);
      } catch (err: any) {
        observation.logTelemetry("warn", "VaultSync", `Failed to prune deleted note "${row.path}": ${err.message}`);
      }
    }
  });
}

const activeJobs = new Set<string>();


