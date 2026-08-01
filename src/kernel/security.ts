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

// Granted automatically the moment an invite is redeemed (Task 4) — every
// name here must already be a member of ALL_CAPABILITIES above; this is a
// subset used for auto-provisioning, not a separate grantable-capability
// concept. calendar.read/write and email.read/send are deliberately
// excluded here until the personal-OAuth work (Tasks 8-13) actually ships —
// granting them earlier would point a new user at the shared admin Google
// account, not their own. Add them here once that work is live, not before.
export const DEFAULT_PERSONAL_CAPABILITIES: readonly string[] = [
  "web.search",
  "news.read",
  "tts.speak",
  "knowledge.read",
  "identity.read",
  "hud.read",
  "feature.propose",
  "system.sandbox_execute",
];

export type Capability = (typeof ALL_CAPABILITIES)[number];

const grants = new Map<string, Set<string>>();

// Available immediately at process start, before the DB round-trip in
// loadGrantsFromDb() completes — self-registered users start with nothing
// until explicitly granted either way, so this only affects the admin
// bootstrap window.
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
