// The scoped rollout for Phase 1 of the coding agent's full-autonomy work
// (see docs/superpowers/specs/2026-08-01-full-autonomy-production-readiness-design.md):
// a deterministic, non-LLM path check — not a risk classifier a model could
// be talked out of, the same reason reviewCodeDiff needed fixing in the
// first place. Any changed file matching one of these prefixes means the
// whole diff falls back to the existing human-merge flow, no matter how
// small a fraction of the diff it is.
export const AUTONOMY_DENYLIST: string[] = [
  "src/kernel/security.ts",
  "src/kernel/auth-middleware.ts",
  "src/kernel/state/migrations/",
  "jarvis-builder/",
  "docker-compose.yml",
  "Dockerfile",
  ".github/",
  "src/executive/",
];

export function isAutoMergeEligible(changedFiles: string[]): boolean {
  return !changedFiles.some((file) => AUTONOMY_DENYLIST.some((denied) => file.startsWith(denied)));
}
