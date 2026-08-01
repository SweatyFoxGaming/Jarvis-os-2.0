import { ObservationPlatform } from "./observation.js";
import { getPool } from "./state/db.js";
import { getCachedMcpTools } from "../capabilities/mcp-registry.js";

const observation = ObservationPlatform.getInstance();

/**
 * Capability grants — gates every real action Jarvis can take on a user's
 * behalf (GitHub, email, TTS, ...). Default-deny: a capability only works for
 * a user once explicitly granted. Every grant/revoke is audited.
 *
 * The in-memory Map is a read cache, not the source of truth — it's
 * rehydrated from the `capability_grants` Postgres table at startup
 * (loadGrantsFromDb) and kept in sync on every grant/revoke, so hasGrant()
 * (called on every tool invocation) stays a synchronous, zero-latency
 * lookup instead of a DB round-trip per tool call.
 */

/**
 * ALL_CAPABILITIES is TWO things at once, and both matter:
 *
 *   1. Part of what POST /api/permissions/grant validates against (see
 *      isGrantableCapability below).
 *   2. The list loadGrantsFromDb()'s bootstrap backfill SEEDS to the admin
 *      identity on every startup.
 *
 * Because of (2), adding a name here means "admin gets this automatically,
 * forever, on every restart, with no explicit action." That is correct for
 * ordinary capabilities and CATASTROPHICALLY WRONG for anything whose entire
 * safety story is "off unless a human deliberately turned it on."
 *
 * ==> NEVER add `executive.autonomous_merge` (or any other off-by-default
 *     capability) to this list. Put it in EXTRA_GRANTABLE_CAPABILITIES
 *     instead — that list is grantable through the real API but is never
 *     auto-seeded. Merging the two lists would silently switch unattended
 *     merging on for every deployment, which is precisely the failure mode
 *     docs/superpowers/specs/2026-08-01-full-autonomy-production-readiness-design.md
 *     exists to prevent.
 */
export const ALL_CAPABILITIES = [
  "github.read",
  "github.issues.create",
  "github.pulls.create",
  "email.send",
  "email.read",
  "tts.speak",
  "executive.plan",
  "calendar.read",
  "calendar.write",
  "briefing.read",
  "files.read",
  "files.write",
  "knowledge.read",
  "identity.read",
  "news.read",
  "web.search",
  "feature.propose",
  "security.read",
  "security.manage",
  "screen.view",
  "objectives.read",
  "objectives.write",
  "system.execute",
  "system.mcp_manage",
  "vault.read",
  "vault.write",
  "settings.write",
  "evolution.read",
  "evolution.manage",
  // Deliberately separate from system.execute (propose_command, which
  // proposes a HOST command a human must explicitly approve before a
  // separate host-side script runs it) — run_sandbox_command executes
  // immediately, with no approval step, inside an isolated per-user
  // container with no credentials, no production data, and no network
  // path to any other service (see jarvis-builder/workspace.ts's chat
  // sandboxes). An operator should be able to grant one without the other:
  // the risk profile isn't remotely the same.
  "system.sandbox_execute",
  // Read-only: the reward ledger's own summary (dashboard), no write action.
  "reward.read",
  // Read-only: the desktop HUD's own status summary, no write action.
  "hud.read",
  // Triggers the daily adaptation engine — reads/analyzes/proposes, never writes code or registers tools unattended.
  "adaptation.run",
] as const;

/**
 * Capabilities that CAN be granted through the real POST /api/permissions/grant
 * route, but that the bootstrap backfill in loadGrantsFromDb() must NEVER seed.
 *
 * This list is the deliberate seam between "grantable" and "granted by
 * default". Everything in ALL_CAPABILITIES is both; everything here is only
 * the former. An operator turning autonomy on is therefore the same single
 * admin action as any other grant (as the design spec promises) — while a
 * fresh database, a restart, or a redeploy still comes up with autonomy OFF,
 * because nothing in this list is ever inserted automatically.
 *
 * ==> Adding an entry here is safe. MOVING an entry from here into
 *     ALL_CAPABILITIES is not: it would convert "an operator explicitly chose
 *     this" into "every deployment has this, permanently, by default." Don't.
 *
 * `executive.autonomous_merge` is the capability that lets the coding-agent
 * pipeline merge its own PR with no human click (see
 * src/executive/build-approval.ts's isEligibleForAutomaticApproval). It is the
 * pause switch for the entire Phase 1 rollout: revoke it and every build
 * request goes straight back to waiting for a human.
 */
export const EXTRA_GRANTABLE_CAPABILITIES = ["executive.autonomous_merge"] as const;

export type Capability = (typeof ALL_CAPABILITIES)[number];

/**
 * The single predicate the grant route validates against. Deliberately a
 * function rather than a concatenated constant, so there is exactly one place
 * that decides "is this a real capability name" and no temptation to build a
 * merged array that someone later feeds to the bootstrap backfill by mistake.
 */
export function isGrantableCapability(capability: string): boolean {
  return (
    (ALL_CAPABILITIES as readonly string[]).includes(capability) ||
    (EXTRA_GRANTABLE_CAPABILITIES as readonly string[]).includes(capability)
  );
}

const grants = new Map<string, Set<string>>();

// Available immediately at process start, before the DB round-trip in
// loadGrantsFromDb() completes — self-registered users start with nothing
// until explicitly granted either way, so this only affects the admin
// bootstrap window. ALL_CAPABILITIES only, for the same reason the DB
// backfill below is: nothing in EXTRA_GRANTABLE_CAPABILITIES may ever be
// present without an explicit, audited grant — not even for the few hundred
// milliseconds before loadGrantsFromDb() replaces this map.
grants.set("admin", new Set(ALL_CAPABILITIES));

/**
 * Rehydrates the in-memory grant cache from Postgres. Call once after
 * initDatabase() succeeds. Seeds the admin's default grants into Postgres so
 * they're stable across restarts (an operator could later revoke one)
 * instead of being silently re-derived from ALL_CAPABILITIES every time —
 * but also backfills any capability ALL_CAPABILITIES gained since this
 * deployment's table was first created (e.g. a new tool added in a later
 * release), so admin isn't left missing it just because the table already
 * had rows from before that tool existed.
 */
export async function loadGrantsFromDb(): Promise<void> {
  const db = getPool();
  const { rows } = await db.query<{ username: string; capability: string }>(
    `SELECT username, capability FROM capability_grants;`
  );

  grants.clear();
  for (const row of rows) {
    if (!grants.has(row.username)) grants.set(row.username, new Set());
    grants.get(row.username)!.add(row.capability);
  }

  const adminGrants = grants.get("admin") ?? new Set<string>();
  const dynamicMcpCapabilities = getCachedMcpTools().map(t => `mcp.${t.serverName}.${t.toolName}`);

  // ALL_CAPABILITIES only — never EXTRA_GRANTABLE_CAPABILITIES. Those are
  // grantable on request but must stay off until an operator explicitly
  // grants them; seeding them here would make e.g. autonomous merging
  // permanently on-by-default on every restart. See both list definitions.
  const missing = [...ALL_CAPABILITIES, ...dynamicMcpCapabilities].filter(c => !adminGrants.has(c));
  if (missing.length > 0) {
    for (const capability of missing) {
      await db.query(
        `INSERT INTO capability_grants (username, capability, granted_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING;`,
        ["admin", capability, "system"]
      );
      adminGrants.add(capability);
    }
    grants.set("admin", adminGrants);
    observation.logTelemetry("info", "Permissions", `Backfilled admin grant(s) for: ${missing.join(", ")}.`);
  }

  observation.logTelemetry("info", "Permissions", `Loaded ${rows.length} persisted capability grant(s) from Postgres.`);
}

export function hasGrant(username: string, capability: string): boolean {
  return grants.get(username)?.has(capability) ?? false;
}

export async function grantCapability(username: string, capability: string, grantedBy: string): Promise<void> {
  if (!grants.has(username)) grants.set(username, new Set());
  grants.get(username)!.add(capability);
  try {
    await getPool().query(
      `INSERT INTO capability_grants (username, capability, granted_by) VALUES ($1, $2, $3) ON CONFLICT (username, capability) DO UPDATE SET granted_by = $3, granted_at = now();`,
      [username, capability, grantedBy]
    );
  } catch (err: any) {
    observation.logTelemetry("warn", "Permissions", `Failed to persist grant "${capability}" for "${username}": ${err.message}`);
  }
  observation.logAuditEvent(grantedBy, "grant_capability", "success", `Granted "${capability}" to "${username}"`);
}

export async function revokeCapability(username: string, capability: string, revokedBy: string): Promise<void> {
  grants.get(username)?.delete(capability);
  try {
    await getPool().query(
      `DELETE FROM capability_grants WHERE username = $1 AND capability = $2;`,
      [username, capability]
    );
  } catch (err: any) {
    observation.logTelemetry("warn", "Permissions", `Failed to persist revoke of "${capability}" for "${username}": ${err.message}`);
  }
  observation.logAuditEvent(revokedBy, "revoke_capability", "success", `Revoked "${capability}" from "${username}"`);
}

export function listGrants(username: string): string[] {
  return Array.from(grants.get(username) ?? []);
}

// A handful of REST endpoints (e.g. under /api/integrations/*) perform the
// exact same actions (send email, open a GitHub issue/PR, read/write files)
// that executeTool() already gates behind hasGrant() for the chat
// tool-calling path — but as plain routes they only had validateApiKey, no
// capability check, so a zero-grant account could hit them directly and
// bypass the grant system entirely. This factory is reusable middleware for
// exactly that gate, so every action surface enforces the same check
// tools.ts does instead of each route re-implementing (or forgetting) it.
export const requireCapability = (capability: string) => (req: any, res: any, next: any) => {
  if (!hasGrant(req.username, capability)) {
    observation.logAuditEvent(req.username, "route_denied", "failed", `Missing grant "${capability}" for ${req.method} ${req.path}`);
    return res.status(403).json({ error: `Missing capability grant "${capability}"` });
  }
  next();
};
