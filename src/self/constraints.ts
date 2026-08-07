import { ObservationPlatform } from "../kernel/observation.js";

// An explicit, auditable registry of the safety constraints this codebase
// structurally enforces today. Each entry is grounded in a real enforcement
// point (see `enforcedIn`) discovered by an audit of the current code — this
// module does not invent new policy, it documents and logs against policy
// that already exists elsewhere (autonomous_executive.ts's human-approval
// gate, shadow-verifier.ts's detection-only scope, jarvis-builder's sandbox
// isolation, tools.ts's capability gating).
export interface Constraint {
  id: string;
  statement: string;
  rationale: string;
  enforcedIn: string;
}

export const CONSTRAINTS: Constraint[] = [
  {
    id: "human-approval-before-code-apply",
    statement: "An autonomous objective that requires code changes never drafts or applies code without an explicit human confirming the direction first.",
    rationale: "The single largest source of real-world AI-safety incidents in both fiction (HAL 9000, Ultron) and practice is an autonomous system taking an irreversible action on an under-specified or unverified goal. Requiring a human checkpoint before any code is drafted keeps that decision point in human hands.",
    enforcedIn: "src/executive/autonomous_executive.ts:executeObjectiveLocked (awaiting_consult gate, only proceeds to drafting after confirmDirection())",
  },
  {
    id: "shadow-verify-detection-only",
    statement: "Anomaly-triggered shadow verification only re-runs tests to report pass/fail — it never creates a build request, drafts code, or applies any change to the running system.",
    rationale: "Automatic detection and automatic re-verification are safe to run unattended; automatic *application* of a fix is not, because a wrong automatic fix is exactly as hard to reverse as a wrong human-approved one, minus the review step that catches mistakes.",
    enforcedIn: "src/executive/shadow-verifier.ts:startShadowVerifier (calls execInChatSandbox only, never createWorkspace/execInWorkspace)",
  },
  {
    id: "sandbox-isolation",
    statement: "Free-form shell command execution (run_sandbox_command) always runs inside an isolated, per-user sandbox with no production credentials or access to the host Docker daemon beyond jarvis-builder's own minimal, purpose-built surface.",
    rationale: "Giving an LLM-driven agent unrestricted shell access to a production system is a well-documented failure class; isolating it to a disposable per-user sandbox bounds the blast radius of a bad or manipulated command to that sandbox alone.",
    enforcedIn: "src/kernel/builder-client.ts:execInChatSandbox + jarvis-builder's own container isolation (jarvis-builder is described in its own package.json as the only Docker-socket access in the stack, deliberately minimal)",
  },
  {
    id: "capability-gated-tools",
    statement: "Every tool call requires the calling user to hold the specific capability grant that tool declares — there is no tool that executes for a user who lacks its required grant, regardless of what the user asks for in conversation.",
    rationale: "A capability model that can be bypassed by clever prompting isn't a capability model — this constraint documents that the check happens structurally (grant lookup), not through the LLM's own judgment about whether the request seems reasonable.",
    enforcedIn: "src/kernel/security.ts:hasGrant + src/capabilities/tools.ts:TOOL_REQUIRED_CAPABILITY (checked before every tool dispatch)",
  },
];

// Looks up `id` in CONSTRAINTS and records the pass/fail outcome as an audit
// event. This is purely the audit-and-record step: it does not gate
// anything, and it does not throw when `holds` is false (the caller already
// computed `holds` and decides what to do about it — that decision stays in
// autonomous_executive.ts and shadow-verifier.ts, not here). An unknown `id`
// is a caller bug, not a runtime condition to swallow, so that case throws.
export function assertConstraint(id: string, holds: boolean, details: string): void {
  const constraint = CONSTRAINTS.find((c) => c.id === id);
  if (!constraint) {
    throw new Error(`assertConstraint: unknown constraint id "${id}" — not present in CONSTRAINTS`);
  }
  ObservationPlatform.getInstance().logAuditEvent("system:constraints", id, holds ? "success" : "failed", details);
}

// Returns a shallow copy so callers can't mutate the live registry.
export function listConstraints(): Constraint[] {
  return [...CONSTRAINTS];
}
