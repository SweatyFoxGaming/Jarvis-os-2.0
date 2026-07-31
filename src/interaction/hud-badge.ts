// Pure and dependency-free on purpose: hud-routes.ts imports auth-middleware
// (which fails fast at module load if INTERNAL_API_KEY isn't set), so a test
// importing deriveHudBadge FROM hud-routes.ts would crash the whole process
// in any environment where that key lives only in .env (never loaded outside
// server.ts's own dotenv.config() call) rather than the raw process env —
// matching this codebase's existing pattern of factoring a pure classifier
// out of its own file (see classifyTaskCategory) specifically so it's
// testable without pulling in unrelated framework machinery.
export function deriveHudBadge(executiveStatus: string, recentFailure: boolean): "idle" | "thinking" | "executing" | "error" {
  if (recentFailure) return "error";
  if (executiveStatus === "Executing") return "executing";
  if (executiveStatus === "Thinking" || executiveStatus === "Planning" || executiveStatus === "Reflecting") return "thinking";
  if (executiveStatus === "Idle") return "idle";
  return "idle";
}
