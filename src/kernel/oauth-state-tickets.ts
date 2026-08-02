import crypto from "crypto";

// Single-use tokens carrying identity across an OAuth redirect — Google's
// callback is the user's own browser navigating back after consent, which
// can't attach an X-API-Key header, so this is how the callback route
// learns which user initiated the connection. Same proven shape as
// src/kernel/confirm-tickets.ts. No separate expiry clock: an OAuth consent
// flow completes in seconds in the same browser tab, so single-use
// (invalidated the moment it's consumed) is sufficient — there's no
// legitimate reason for a state value to survive being read once.
const stateTickets = new Map<string, string>();

export function issueOAuthStateTicket(username: string): string {
  const state = crypto.randomUUID();
  stateTickets.set(state, username);
  return state;
}

export function consumeOAuthStateTicket(state: string): string | null {
  const username = stateTickets.get(state);
  stateTickets.delete(state); // single-use regardless of outcome
  return username ?? null;
}
