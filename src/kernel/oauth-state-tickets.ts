import crypto from "crypto";

// Single-use tokens carrying identity across an OAuth redirect — Google's
// callback is the user's own browser navigating back after consent, which
// can't attach an X-API-Key header, so this is how the callback route
// learns which user initiated the connection. Same shape as server.ts's own
// voiceTickets (search for "voiceTickets" in src/server.ts): a Map of
// ticket -> {username, expiresAt}, with an opportunistic sweep on issue to
// keep the map bounded. A Google consent screen can sit unattended far
// longer than a voice-ticket handshake, so this uses a longer TTL (10
// minutes vs. voiceTickets' 30 seconds) — long enough for a real user to
// read and approve the consent screen, short enough that an abandoned flow
// or an auth-url-spam loop doesn't grow the map unboundedly.
const OAUTH_STATE_TICKET_TTL_MS = 10 * 60 * 1000;
const stateTickets = new Map<string, { username: string; expiresAt: number }>();

// The opportunistic sweep below only removes entries that have ALREADY
// expired — it does nothing to stop an authenticated user from spamming
// GET /api/integrations/google/auth-url and growing this map to an
// arbitrary size within any single 10-minute TTL window (memory pressure).
// This hard cap is the backstop: every Map in V8 preserves insertion order,
// and every ticket here shares the same fixed TTL from the moment it's
// issued, so the oldest-inserted entry is always also the soonest to expire
// — evicting it first (rather than refusing to issue new tickets outright)
// keeps the map bounded without ever turning a burst of legitimate
// auth-url clicks into hard failures for the caller.
const MAX_STATE_TICKETS = 1000;

export function issueOAuthStateTicket(username: string): string {
  const now = Date.now();
  for (const [s, v] of stateTickets) {
    if (v.expiresAt < now) stateTickets.delete(s); // opportunistic sweep, keeps the map bounded
  }
  if (stateTickets.size >= MAX_STATE_TICKETS) {
    const oldestKey = stateTickets.keys().next().value;
    if (oldestKey !== undefined) stateTickets.delete(oldestKey);
  }
  const state = crypto.randomUUID();
  stateTickets.set(state, { username, expiresAt: now + OAUTH_STATE_TICKET_TTL_MS });
  return state;
}

export function consumeOAuthStateTicket(state: string): string | null {
  const entry = stateTickets.get(state);
  stateTickets.delete(state); // single-use regardless of outcome
  if (!entry || entry.expiresAt < Date.now()) return null;
  return entry.username;
}
