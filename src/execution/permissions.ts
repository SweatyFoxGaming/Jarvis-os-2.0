import { ObservationPlatform } from "../observation/index.js";
import { getPool } from "../data/db.js";

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
] as const;

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
  const missing = ALL_CAPABILITIES.filter(c => !adminGrants.has(c));
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
