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
]);

export function isAutoMergeEligible(changedFiles: string[]): boolean {
  return !changedFiles.some((file) => AUTONOMY_DENYLIST.some((denied) => file.startsWith(denied)));
}
