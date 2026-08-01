// The scoped rollout for Phase 1 of the coding agent's full-autonomy work
// (see docs/superpowers/specs/2026-08-01-full-autonomy-production-readiness-design.md):
// a deterministic, non-LLM path check — not a risk classifier a model could
// be talked out of, the same reason reviewCodeDiff needed fixing in the
// first place. Any changed file matching one of these prefixes means the
// whole diff falls back to the existing human-merge flow, no matter how
// small a fraction of the diff it is.
// `readonly` + Object.freeze on purpose: this list is the deterministic
// backstop the autonomous-merge decision sits behind, so it must not be
// possible for any importer — now or later, deliberately or by accident — to
// push/splice an entry out of it at runtime and silently widen what Jarvis
// can merge without a human.
export const AUTONOMY_DENYLIST: readonly string[] = Object.freeze([
  "src/kernel/security.ts",
  "src/kernel/auth-middleware.ts",
  "src/kernel/state/migrations/",
  "jarvis-builder/",
  "docker-compose.yml",
  "Dockerfile",
  ".github/",
  "src/executive/",
  // Everything below is on the list for the same one reason src/executive/**
  // is: it is machinery that defines or enforces the autonomy boundary
  // itself, so an autonomous merge touching it could widen what the *next*
  // autonomous merge is allowed to do. Self-modification of the guardrails
  // always goes back to a human.
  //
  // This file — the denylist itself. Without it, the very first thing an
  // autonomous change could do is delete every other entry here.
  "src/kernel/autonomy-scope.ts",
  // countAutonomousMergesToday (the daily blast-radius cap) and
  // markAutonomousMerge (the audit column both the cap and the revert tooling
  // read off) both live here.
  "src/kernel/state/build-requests-repo.ts",
  // The grant/revoke gate — the route that turns executive.autonomous_merge
  // on and off, i.e. the pause switch for this whole capability.
  "src/interaction/routes/permissions-routes.ts",
  // The test suite is a real gate, not just documentation: final verification
  // runs `npm test` before any PR opens, and every future autonomous merge is
  // gated on it passing. A merge that weakens the tests weakens every merge
  // after it.
  "tests/",
]);

export function isAutoMergeEligible(changedFiles: string[]): boolean {
  return !changedFiles.some((file) => AUTONOMY_DENYLIST.some((denied) => file.startsWith(denied)));
}
