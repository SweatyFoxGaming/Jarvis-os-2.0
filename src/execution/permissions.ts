import { ObservationPlatform } from "../observation/index.js";

const observation = ObservationPlatform.getInstance();

/**
 * Capability grants — gates every real action Jarvis can take on a user's
 * behalf (GitHub, email, TTS, ...). Default-deny: a capability only works for
 * a user once explicitly granted. Every grant/revoke is audited.
 *
 * Known limitation: in-memory only, not yet persisted to Postgres — grants
 * reset on restart (the admin default re-seeds itself; anyone else who was
 * granted a capability needs it re-granted). Durable storage is a natural
 * next step once there's a UI to manage grants; see docs/architecture/VISION.md.
 */

export const ALL_CAPABILITIES = [
  "github.read",
  "github.issues.create",
  "github.pulls.create",
  "email.send",
  "email.read",
  "tts.speak",
] as const;

export type Capability = (typeof ALL_CAPABILITIES)[number];

const grants = new Map<string, Set<string>>();

// The admin key is usable out of the box without a separate grant step.
// Self-registered users start with nothing until explicitly granted.
grants.set("admin", new Set(ALL_CAPABILITIES));

export function hasGrant(username: string, capability: string): boolean {
  return grants.get(username)?.has(capability) ?? false;
}

export function grantCapability(username: string, capability: string, grantedBy: string): void {
  if (!grants.has(username)) grants.set(username, new Set());
  grants.get(username)!.add(capability);
  observation.logAuditEvent(grantedBy, "grant_capability", "success", `Granted "${capability}" to "${username}"`);
}

export function revokeCapability(username: string, capability: string, revokedBy: string): void {
  grants.get(username)?.delete(capability);
  observation.logAuditEvent(revokedBy, "revoke_capability", "success", `Revoked "${capability}" from "${username}"`);
}

export function listGrants(username: string): string[] {
  return Array.from(grants.get(username) ?? []);
}
