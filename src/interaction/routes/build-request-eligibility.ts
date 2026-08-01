import type { BuildRequestRow } from "../../kernel/state/build-requests-repo.js";

// Pure and dependency-free on purpose: build-requests-routes.ts imports
// auth-middleware (which fails fast at module load if INTERNAL_API_KEY isn't
// set), so a test importing isEligibleForConfirmToken FROM
// build-requests-routes.ts would crash the whole process in any environment
// where that key lives only in .env (never loaded outside server.ts's own
// dotenv.config() call) rather than the raw process env — same reasoning
// hud-badge.ts documents for deriveHudBadge, and the same fix.
//
// A build request is eligible for a fresh confirm-token in exactly two
// cases: the normal path (still 'awaiting_consult'), or the reward-gate
// recovery path (status 'direction_confirmed' AND this exact build request
// is the caller's current pending reward gate — confirmDirectionForBuildRequest
// already handles that case correctly once it receives the id; the gap this
// closes is that there was previously no way to ever get a *token* for it).
export function isEligibleForConfirmToken(
  buildRequest: BuildRequestRow,
  pendingRewardGate: BuildRequestRow | null,
  buildRequestId: number
): boolean {
  if (buildRequest.status === "awaiting_consult") return true;
  return buildRequest.status === "direction_confirmed" && pendingRewardGate?.id === buildRequestId;
}
