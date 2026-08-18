// Short-lived, single-use WebAuthn ceremony challenges, keyed by username
// rather than a random opaque ticket — unlike oauth-state-tickets.ts (which
// needs an opaque token because a real browser redirect loses all other
// context), a WebAuthn ceremony is a synchronous same-page exchange: the
// caller already knows (or, for login, just supplied) the username at both
// the options-generation and verify steps, so the username itself is
// sufficient as the correlation key. Two entirely separate maps (not one
// map with a purpose field) so a registration challenge can never be
// consumed as a login challenge or vice versa, by construction rather than
// by an extra runtime check.
//
// A generous-but-bounded TTL: a WebAuthn ceremony is a real OS-level
// prompt (Face ID / Windows Hello dialog) that can take a few seconds
// longer than oauth-state-tickets.ts's redirect-carrying use case, but
// must not sit valid indefinitely if the user abandons it.
const CHALLENGE_TTL_MS = 2 * 60 * 1000;
const MAX_TICKETS = 1000;

interface ChallengeEntry {
  challenge: string;
  expiresAt: number;
}

const registrationChallenges = new Map<string, ChallengeEntry>();
const loginChallenges = new Map<string, ChallengeEntry>();

function issue(map: Map<string, ChallengeEntry>, username: string, challenge: string): void {
  const now = Date.now();
  for (const [k, v] of map) {
    if (v.expiresAt < now) map.delete(k); // opportunistic sweep, same pattern as oauth-state-tickets.ts
  }
  if (map.size >= MAX_TICKETS) {
    const oldestKey = map.keys().next().value;
    if (oldestKey !== undefined) map.delete(oldestKey);
  }
  map.set(username, { challenge, expiresAt: now + CHALLENGE_TTL_MS });
}

function consume(map: Map<string, ChallengeEntry>, username: string): string | null {
  const entry = map.get(username);
  map.delete(username); // single-use regardless of outcome
  if (!entry || entry.expiresAt < Date.now()) return null;
  return entry.challenge;
}

export function issueRegistrationChallenge(username: string, challenge: string): void {
  issue(registrationChallenges, username, challenge);
}

export function consumeRegistrationChallenge(username: string): string | null {
  return consume(registrationChallenges, username);
}

export function issueLoginChallenge(username: string, challenge: string): void {
  issue(loginChallenges, username, challenge);
}

export function consumeLoginChallenge(username: string): string | null {
  return consume(loginChallenges, username);
}
