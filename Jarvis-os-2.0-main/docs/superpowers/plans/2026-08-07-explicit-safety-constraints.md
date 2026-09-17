# Explicit Safety Constraints Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Jarvis's existing safety boundaries (human-approval gate before autonomous code changes, sandbox isolation, capability-gated tools, shadow-verify's detection-only scope) explicit, auditable, and queryable — a single source of truth that both defends in depth at the points that already enforce these boundaries structurally, and lets a user or Jarvis itself state its own hard limits accurately on request.

**Architecture:** One new registry module (`src/self/constraints.ts`) defines the constraint list as data and an `assertConstraint(id, context)` function that (a) re-verifies the invariant where mechanically checkable, and (b) logs every check to the existing `ObservationPlatform.logAuditEvent` audit trail under a distinguishable actor. Two existing autonomy gate points (`autonomous_executive.ts`'s human-approval checkpoint, `shadow-verifier.ts`'s detection-only boundary) call it additively — this does not change their existing behavior when everything is already correct, it only adds a real, monitorable assertion plus an audit trail entry at the exact place each boundary already lives. A new read-only tool (`list_constraints`) lets the constraint list be queried directly, so "what are your hard limits" gets a grounded, accurate answer instead of an improvised one.

**Tech Stack:** TypeScript. No new dependencies — reuses `ObservationPlatform.logAuditEvent` (`src/kernel/observation.ts:228`), the existing tools.ts registration pattern, and the existing `EventBus`/capability-grant infrastructure already in the codebase.

## Global Constraints

- This plan does not change any existing enforcement behavior — every constraint documented here is already true today (verified against the codebase, not aspirational). The assertions added are additive defense-in-depth plus audit logging, not new restrictions. If any assertion added by this plan would actually fire under current code (i.e. an existing invariant is NOT actually true), that is a genuine bug this plan surfaces — stop and report it rather than silently loosening the assertion to make it pass.
- `assertConstraint` must never throw in a way that crashes the calling process on the happy path — a failed assertion should log at `"failed"` outcome via `logAuditEvent` and, at the two call sites wired in Task 2, cause the calling code to abort the specific unsafe action (return/reject), not the whole server process.
- The constraint registry is a single source of truth — do not duplicate constraint text elsewhere; the query tool (Task 3) reads directly from the same array Task 1 defines.
- No capability gate is required on the `list_constraints` tool — it's read-only, describes Jarvis's own limits, and withholding it from any authenticated user would defeat its purpose (a user should always be able to ask what Jarvis won't do).

---

### Task 1: `src/self/constraints.ts` — the constraint registry

**Files:**
- Create: `src/self/constraints.ts`
- Test: `tests/index.test.ts`

**Interfaces:**
- Consumes: `ObservationPlatform.getInstance().logAuditEvent(actor: string, action: string, outcome: "success"|"failed"|"started"|"completed"|"warning", details: string): void` (already exists, `src/kernel/observation.ts:228`).
- Produces:
  - `interface Constraint { id: string; statement: string; rationale: string; enforcedIn: string; }` — `enforcedIn` names the real file:function that structurally enforces this constraint today, e.g. `"autonomous_executive.ts:executeObjectiveLocked (awaiting_consult gate)"`.
  - `export const CONSTRAINTS: Constraint[]` — the registry, containing exactly these 4 entries (grounded in the codebase audit already performed for this plan — do not invent additional constraints beyond these 4, and do not omit any):
    ```typescript
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
    ```
  - `export function assertConstraint(id: string, holds: boolean, details: string): void` — looks up the constraint by `id` (throw a clear error if `id` isn't in `CONSTRAINTS` — that's a caller bug, fail loud in development, not a silent no-op), then calls `ObservationPlatform.getInstance().logAuditEvent("system:constraints", id, holds ? "success" : "failed", details)`. Does NOT throw when `holds` is false — logging the failure is this function's entire job; the caller (Task 2's call sites) decides what to do about a `holds: false` result using the boolean return isn't needed since the caller already knows `holds` before calling (it computed it) — this function is purely the audit-and-record step, not a gate itself. (This keeps `constraints.ts` a pure, dependency-light logging/registry module — the actual gating logic stays where it already correctly lives, in `autonomous_executive.ts` and `shadow-verifier.ts`.)
  - `export function listConstraints(): Constraint[]` — returns a shallow copy of `CONSTRAINTS` (so callers can't mutate the registry).

- [ ] **Step 1: Write the failing test**

Check `tests/index.test.ts`'s real test-registration convention first (confirmed by prior work on this branch: `registerTest(category, name, fn)` with `throw new Error(...)` assertions) and use that exact convention, not generic `test`/`assert` pseudocode. Example shape (translate to the real convention):

```typescript
// category "Constraints"
// test: "CONSTRAINTS contains exactly the 4 expected ids, each with a non-empty statement/rationale/enforcedIn"
// - import { CONSTRAINTS, assertConstraint, listConstraints } from "../src/self/constraints.js"
// - assert CONSTRAINTS.length === 4
// - assert every entry has non-empty id/statement/rationale/enforcedIn (no placeholder text)
// - assert the 4 ids are exactly: "human-approval-before-code-apply", "shadow-verify-detection-only", "sandbox-isolation", "capability-gated-tools" (order-independent set comparison)

// test: "listConstraints returns a copy, not the live array"
// - const copy = listConstraints(); copy.push({...fake entry...});
// - assert CONSTRAINTS.length is still 4 (unaffected by mutating the returned copy)

// test: "assertConstraint logs a success audit event when holds is true"
// - call assertConstraint("sandbox-isolation", true, "test detail")
// - read ObservationPlatform.getInstance().getAuditLogs() (or getAuditLogsForActor("system:constraints") if that's more precise — check observation.ts's real method signatures)
// - assert the most recent entry's string contains "sandbox-isolation" and reflects a success outcome

// test: "assertConstraint logs a failed audit event when holds is false, without throwing"
// - call assertConstraint("capability-gated-tools", false, "test detail") — must not throw
// - assert the logged entry reflects a failed outcome

// test: "assertConstraint throws for an unknown constraint id"
// - assert calling assertConstraint("not-a-real-id", true, "x") throws
```

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL — `Cannot find module '../src/self/constraints.js'`.

- [ ] **Step 3: Write the implementation**

Implement `src/self/constraints.ts` exactly per the Interfaces section above — the `CONSTRAINTS` array content is given verbatim, use it exactly as written (these statements were derived from a real audit of this codebase's current enforcement points; do not paraphrase or add/remove entries).

- [ ] **Step 4: Run test to verify it passes**

Expected: PASS.

- [ ] **Step 5: Run the full suite**

Export `POSTGRES_HOST=localhost POSTGRES_USER=jarvis_user POSTGRES_DB=jarvis INTERNAL_API_KEY=<real value from .env> OAUTH_TOKEN_ENCRYPTION_KEY=<real value from .env>` first (this worktree's `.env` is missing `POSTGRES_HOST`). Run `npx tsc --noEmit && npm test`.
Expected: all tests pass, including the new ones.

- [ ] **Step 6: Commit**

```bash
git add src/self/constraints.ts tests/index.test.ts
git commit -m "feat: add an explicit, auditable safety-constraint registry"
```

---

### Task 2: Wire `assertConstraint` into the two real gate points

**Files:**
- Modify: `src/executive/autonomous_executive.ts`
- Modify: `src/executive/shadow-verifier.ts`
- Test: `tests/index.test.ts`

**Interfaces:**
- Consumes: `assertConstraint(id, holds, details)` from Task 1's `src/self/constraints.ts`.
- Produces: no new exports — this task only adds calls at two existing points, it does not change either file's public interface or existing control flow.

- [ ] **Step 1: Read the current gate points before touching them**

In `src/executive/autonomous_executive.ts`, find the `awaiting_consult` state transition inside `executeObjectiveLocked` (the point where a coding objective stops and waits for `confirmDirection()` before any code is drafted — the report from the earlier codebase audit in this session located this at roughly `autonomous_executive.ts:176-291`, but re-locate it exactly by reading the file, don't trust a stale line number). In `src/executive/shadow-verifier.ts`, find `startShadowVerifier`'s subscriber body (the point where it calls `execFn(...)` after confirming `hasHighSeverity`).

- [ ] **Step 2: Add the assertion call in `autonomous_executive.ts`**

At the exact point the code transitions to `awaiting_consult` (i.e., the moment it has decided NOT to draft code yet and IS waiting for human confirmation), add:

```typescript
assertConstraint(
  "human-approval-before-code-apply",
  true, // this code path is, by construction, the one that stops before drafting — holds is true because reaching this line IS the enforcement
  `Objective "${objective}" requires code changes; stopped at awaiting_consult, no code drafted yet.`
);
```

with the corresponding import (`import { assertConstraint } from "../self/constraints.js";`). Do not add this call anywhere else in the file — specifically, do NOT add it to the path that runs after `confirmDirection()` has been called (that path is expected to draft code; asserting the same constraint there would be a false alarm, since by that point a human already approved proceeding).

- [ ] **Step 3: Add the assertion call in `shadow-verifier.ts`**

Immediately before the `execFn(SANDBOX_KEY, VERIFY_COMMAND)` call, add:

```typescript
assertConstraint(
  "shadow-verify-detection-only",
  true, // this module structurally never calls createWorkspace/execInWorkspace — see the file-level comment
  `Shadow-verifying after a high-severity adaptation:analysis finding, sandbox key "${SANDBOX_KEY}".`
);
```

with the corresponding import. Keep the module's existing file-level scope-boundary comment as-is (Task 2 of the prior plan already added it) — this assertion call reinforces it with a real audit-log entry, it doesn't replace the comment.

- [ ] **Step 4: Write tests confirming both call sites actually log**

Add to `tests/index.test.ts` (match the file's real test convention, as established in prior tasks on this branch):
- A test that runs an objective requiring code changes through the existing test harness for `autonomous_executive.ts` (find and reuse whatever existing test already exercises the `awaiting_consult` path — check the file for one before writing a new harness from scratch) and confirms `ObservationPlatform.getInstance().getAuditLogs()` (or the actor-scoped variant) contains an entry for `"human-approval-before-code-apply"` with a `success` outcome after that run.
- A test that triggers `shadow-verifier.ts`'s existing test setup (from the prior plan's Task 2 — a fake `execFn` injected via `startShadowVerifier(fakeExecFn)`) with a `hasHighSeverity: true` payload, and confirms the audit log contains an entry for `"shadow-verify-detection-only"` with a `success` outcome.

If no existing test harness exercises the `awaiting_consult` path in `autonomous_executive.ts` cheaply (e.g. it requires a real Groq/OmniRoute call), scope this sub-test down to what's actually testable without a live LLM call — check how existing tests in this file handle that (the codebase audit found `runDailyAdaptation` tests that "never start a candidate objective when Postgres isn't reachable, even with no Groq client" as a precedent for testing this layer without live AI credentials) and follow the same no-live-AI-required pattern rather than skipping the test.

- [ ] **Step 5: Run the full suite**

Run: `npx tsc --noEmit && npm test` (same env exports as Task 1's Step 5).
Expected: all tests pass, no change to any existing test's outcome (this task is additive-only).

- [ ] **Step 6: Commit**

```bash
git add src/executive/autonomous_executive.ts src/executive/shadow-verifier.ts tests/index.test.ts
git commit -m "feat: assert and audit-log the two real autonomy safety gates at their enforcement points"
```

---

### Task 3: `list_constraints` tool — query surface

**Files:**
- Modify: `src/capabilities/tools.ts`
- Test: `tests/index.test.ts`

**Interfaces:**
- Consumes: `listConstraints()` from `src/self/constraints.ts`.
- Produces: a new tool registered in `tools.ts` following this file's existing tool-registration pattern (read a couple of existing simple, no-argument, no-capability-gated tools in the same file first — e.g. whatever the simplest existing read-only tool looks like — and match its exact shape: name, description, parameters schema, handler). Tool name: `list_constraints`. No parameters. No `TOOL_REQUIRED_CAPABILITY` entry (per this plan's Global Constraints — always available). Handler returns `listConstraints()` (or a JSON-stringified version, matching whatever this file's other tools return — check the convention).

- [ ] **Step 1: Read the existing tool-registration pattern**

Open `src/capabilities/tools.ts` and find `query_knowledge_graph` or another simple, existing read-only tool (the codebase audit already confirmed this tool exists) as your template for exact shape (name/description/parameters/handler wiring, and how `TOOL_REQUIRED_CAPABILITY` is or isn't set for a tool that has no gate).

- [ ] **Step 2: Write the failing test**

Add a test (matching the file's real convention) that finds `list_constraints` in the tool registry, invokes its handler with no arguments, and asserts the result contains all 4 constraint ids from Task 1's `CONSTRAINTS` array (import `CONSTRAINTS` directly and compare, don't hardcode the ids a second time in this test — if Task 1's registry ever changes, this test should track it automatically rather than needing a parallel update).

- [ ] **Step 3: Run test to verify it fails**

Expected: FAIL — tool not found / handler undefined.

- [ ] **Step 4: Implement the tool**

Add `list_constraints` to `tools.ts` per the pattern found in Step 1, with a description along these lines (adjust to match this file's actual description-writing convention/tone from neighboring tools): `"List Jarvis's explicit, auditable safety constraints — the hard limits on what autonomous actions Jarvis will take without human approval, and where each is enforced in the codebase."`

- [ ] **Step 5: Run test to verify it passes, then the full suite**

Run: `npx tsc --noEmit && npm test` (same env exports as before).
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/capabilities/tools.ts tests/index.test.ts
git commit -m "feat: add list_constraints tool so Jarvis can state its own safety boundaries on request"
```

---

## Final check

- [ ] Run `npx tsc --noEmit && npm test` end to end.
- [ ] Confirm no existing test's pass/fail outcome changed from before this plan (this plan is additive-only; a pre-existing test that now fails is a real regression, stop and fix before considering this plan done).
- [ ] Confirm `assertConstraint` is called with `holds: true` at both Task 2 call sites (not `false` — both call sites represent the constraint actually holding at that point in the code, this plan does not manufacture a failure case in production code, only in tests).
- [ ] Manually invoke `list_constraints` (or its underlying `listConstraints()` function) and read the output — confirm all 4 statements are grammatical, accurate, and non-generic (each should read as a real, specific claim about this codebase, not boilerplate).
