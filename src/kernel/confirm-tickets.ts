// Single-use tokens for confirming a build request's direction — mirrors
// server.ts's existing voice-ticket pattern (issueVoiceTicket/
// consumeVoiceTicket), the same proven shape already used elsewhere in this
// codebase for "a server-minted token, echoed back through a real UI
// action, is what actually authorizes this — not an LLM's belief that
// confirmation happened." Unlike the voice ticket (a live-session
// handshake, correctly 30 seconds), this token has no separate expiry
// clock: a build proposal can legitimately sit unconfirmed for hours while
// a human gets to it, the same way build_requests already sit in
// "awaiting_consult" today with no timeout. It's invalidated by being
// consumed, by a newer ticket being issued for the same build request, or
// — enforced one layer up, by the repo's own status guard, not here — by
// the underlying build request no longer being in "awaiting_consult" by
// the time the token is presented.
interface ConfirmTicketEntry {
  buildRequestId: number;
  username: string;
}

const ticketsByToken = new Map<string, ConfirmTicketEntry>();
const tokenByBuildRequestId = new Map<number, string>();

export function issueConfirmTicket(buildRequestId: number, username: string): string {
  const previousToken = tokenByBuildRequestId.get(buildRequestId);
  if (previousToken) ticketsByToken.delete(previousToken);

  const token = crypto.randomUUID();
  ticketsByToken.set(token, { buildRequestId, username });
  tokenByBuildRequestId.set(buildRequestId, token);
  return token;
}

export function consumeConfirmTicket(token: string): ConfirmTicketEntry | null {
  const entry = ticketsByToken.get(token);
  ticketsByToken.delete(token); // single-use regardless of outcome
  if (!entry) return null;
  // Only clear the reverse-index entry if it still points at the token
  // being consumed — an already-superseded reverse-index entry (this
  // build request has since had a newer ticket issued) must not be
  // clobbered by a stale consume.
  if (tokenByBuildRequestId.get(entry.buildRequestId) === token) {
    tokenByBuildRequestId.delete(entry.buildRequestId);
  }
  return entry;
}
