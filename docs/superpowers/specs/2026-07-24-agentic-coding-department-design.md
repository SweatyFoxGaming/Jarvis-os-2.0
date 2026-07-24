# Agentic Coding Department — Design Spec

## Context

The user asked why Jarvis "seems to have a problem in the coding department" and can't reliably build what's asked of it, wanting its coding agent to work like Claude Code's. Reading the actual implementation (`src/executive/departments.ts`, `src/executive/autonomous_executive.ts`, and the approval route in `src/server.ts`) confirms a real, specific architectural gap, not a small bug:

- **`draftCodeChanges`** is a single LLM call (Groq `gpt-oss-120b`) given only the objective, research summary, and direction notes as *text*. It has never read the actual current content of any file it's about to touch — it generates a guess at complete file contents, in one shot, with no tools and no ground truth about the real repository.
- **`reviewCodeDiff`** is one more single call (`llama-3.3-70b-versatile`) asked to write a prose critique of that generated text. It cannot run the code, run tests, or check that it compiles.
- Only after a human approves in the dashboard does anything touch a real file — and even then, it commits directly via GitHub's REST API (`github.createBranch`/`commitFile`/`createPullRequest`), with no local checkout involved at any point.

This is the opposite of an agentic loop: no reading real files before editing, no targeted edits, no test execution, no iteration on real failures. That is the actual reason Jarvis can't reliably "create everything" asked of it. (Separately, GitHub branch creation currently 403s in production due to a fine-grained PAT missing write access — a real, already-diagnosed issue, but a credential-permission fix on GitHub's side, not a code change, and explicitly out of scope here.)

This spec replaces `draftCodeChanges`/`reviewCodeDiff`'s internals with a genuine agentic loop: an isolated, sandboxed workspace where a tool-calling LLM reads, edits, and runs real commands (including tests) across many turns, the same shape that makes Claude Code work — while keeping exactly the two human checkpoints the user asked for.

## Architecture

### Isolated workspace: one git worktree per build request

When a build request moves from `direction_confirmed` to `coding` (same transition that exists today), a dedicated git worktree is created via `git worktree add` off the repository's default branch, on a fresh branch named `jarvis/build-request-<id>` (the exact branch name the existing PR-opening code already uses — unchanged). The worktree lives at a dedicated path (e.g. `<repo>/.jarvis-build-workspaces/br-<id>/`), fully separate from the live production checkout at `/mnt/jarvis_home/llm` that the running `jarvis-os-api` container actually serves from. The live checkout is never reachable from, or mutated by, this workspace.

### Sandboxed execution: one ephemeral Docker container per build request

The coding agent needs "free reign" to run arbitrary commands — but "free reign" is scoped *by the isolation*, not by filtering which commands are allowed. That isolation is a dedicated, ephemeral Docker container per build request:

- Built from the same base as this repo's existing `Dockerfile` (`node:20-alpine`), plus `git` (not currently installed in that image).
- Only that one build request's worktree directory is bind-mounted in (at a fixed path, e.g. `/workspace`) — no other host path, no Docker socket, no privileged mode, no host device access. A command that does something destructive can only affect its own container's filesystem and that one bind-mounted directory — never the host, never other containers, never other build requests' workspaces.
- Resource-bounded: CPU/memory caps (`docker run --cpus --memory`) and a wall-clock timeout on the overall coding session, to bound a runaway or stuck process.
- No GitHub credentials and no production secrets (`.env`) are present in this container at all — during the free-reign coding phase, the sandbox has no path to the internet beyond what package installation needs (the npm registry). This is a deliberate, explicit exception, not a hardened egress firewall — noted under Explicitly Out of Scope. It directly delivers what the user asked for: whatever Jarvis is coding stays local until a human confirms it's ready to leave the sandbox.
- Torn down (`docker rm`, `git worktree remove`) once the build request reaches a terminal state (`pr_opened`, `rejected_at_code`, or `error`) — never left running indefinitely.

### The one tool: `run_shell_command`

Rather than a curated tool-per-action set (a separate Read tool, Edit tool, etc.), the coding agent gets exactly one tool: `run_shell_command(command: string): { stdout, stderr, exitCode }`, executed via `docker exec` into that build request's sandbox container, cwd fixed to `/workspace`. Reading a file is `cat`; editing is a heredoc or `sed`; testing is `npm test`; checking types is `npx tsc --noEmit`; inspecting history is `git diff`/`git log`. This is deliberately the simplest, most powerful primitive rather than reimplementing a bespoke toolbox — matching the "free reign within the isolation boundary" the user asked for.

### The agentic loop

A new function (replacing `draftCodeChanges`'s role) drives a genuine multi-turn tool-calling loop against NVIDIA NIM's OpenAI-compatible chat-completions API:

1. System prompt: the objective, the research summary, the confirmed direction notes, and the one available tool.
2. Loop: the model either calls `run_shell_command` (result fed back as the next turn) or calls a `finish_coding` signal-tool with a summary of what it did — repeated until `finish_coding` is called or a max-turn/wall-clock cap is hit (treated as an error state, surfaced honestly, not silently truncated).
3. Every turn (the command issued, its stdout/stderr/exit code, and any model reasoning text) is persisted as a transcript event tied to the build request's id, in the order it happened.
4. When the model signals `finish_coding`, the loop stops. **This is the first half of the testing-and-deployment checkpoint** — the agent does not run a final verification pass or touch GitHub on its own; it surfaces its summary and diff to the user via the existing notification mechanism and waits.

### Checkpoints: exactly two, reusing the existing state machine

No new build-request statuses are needed — the existing schema (`researching` → `awaiting_consult` → `direction_confirmed` → `coding` → `awaiting_code_approval` → `pr_opened`, with `rejected_at_code`/`error` branches) already has the right shape; only what happens *during* `coding` and *on approval* changes:

1. **Direction** (unchanged) — research runs, Jarvis discusses direction with the user, waits for `confirm_build_direction`.
2. **Testing-and-deployment** (the existing `awaiting_code_approval` → approve/reject step, now more meaningful) — once the agent calls `finish_coding`, the build request moves to `awaiting_code_approval` exactly as today, but now the user is approving a real, already-iterated-on set of file changes sitting in a real worktree, not blindly-generated text. On approval, a **fresh final verification pass** runs — not by trusting whatever state the free-reign session happened to leave the container in, but in a brand-new container built from the same worktree's actual on-disk file state (fresh `npm install`, full test suite, typecheck), so the result reflects exactly what's about to be committed, not any residual/stateful side effect from the coding session. Only if that passes does the existing `github.createBranch`/`commitFile`/`createPullRequest` flow run — now committing the worktree's actual real file diff, not re-generating content. If the final verification fails, the build request goes to `error` with the real failure output attached, rather than opening a PR on unverified code.

Everything between those two checkpoints — reading files, making edits, running tests, iterating on failures, running them again — happens with zero human checkpoints, per the user's explicit request.

### Visibility: on-demand, not push-based

A new Postgres table stores transcript events (build request id, sequence number, command, stdout/stderr, exit code, timestamp). A new route, `GET /api/system/build-requests/:id/transcript`, returns them. The existing build-requests dashboard panel gets a "View Activity" affordance per build request that fetches and renders this transcript — available to open at any time, including mid-task while the agent is still working, but never pushed at the user proactively. This matches the user's explicit "viewing is upon request" framing.

### Model / provider: NVIDIA NIM, not Groq

This coding-agent loop runs against NVIDIA NIM's OpenAI-compatible API (the user provided a real API key for this), kept entirely separate from the existing Groq (`groq-client.ts`) and Gemini clients used elsewhere in the app — chat, the research department, and code review stay exactly as they are today. This is a deliberate choice to avoid the token-hungry iterative loop colliding with Groq's rate limits, which this session already hit once (a single research pass consumed most of a day's TPD quota). A new provider module (`src/runtime/nvidia-client.ts`, mirroring `groq-client.ts`'s shape) wraps this, using plain `fetch` rather than adding the `openai` npm package as a dependency — consistent with every other backend HTTP integration in this codebase (`websearch.ts`, `wikipedia.ts`, `github.ts`), none of which pull in a client SDK. The exact NVIDIA-hosted model to use is **not fixed by this spec** — it must be verified during implementation to actually support tool-calling well in the OpenAI-compatible format, rather than assumed.

## Explicitly out of scope

- **The GitHub token permission fix.** Branch creation will still 403 in production until the fine-grained PAT's `Contents` permission is corrected on GitHub's side — a credential fix, not a code change, tracked separately.
- **Hardened network egress filtering for the sandbox.** The container has no GitHub credentials and no production secrets, but is not sitting behind an allowlist-based egress proxy — package-registry access during the coding phase is an accepted, explicit exception, not a fully locked-down network boundary. A stronger egress control is a reasonable future follow-up, not bundled here.
- **Any change to the research department, direction-confirmation flow, or the chat agent's own Groq/Gemini usage.** This spec touches only what happens between `direction_confirmed` and `pr_opened`.
- **Automatic merge.** This gets a build request to an opened PR; merging remains a separate, human (or existing tooling) action, same as today.
- **Docker socket access, privileged containers, or any host-escape-capable configuration.** Never granted, no exceptions — this is the one hard line the whole safety model depends on.
- **A curated/allowlisted command set.** Explicitly rejected per the user's direction — the isolation boundary, not command filtering, is the safety mechanism inside the sandbox.

## Testing

- Following this codebase's established convention, no unit tests are added for the Docker/NVIDIA-API-dependent orchestration itself (matching `github.ts`/`websearch.ts`/`wikipedia.ts`, none of which have tests, since they depend entirely on live external systems). `npm test`/`tsc --noEmit` must stay green throughout implementation.
- Any genuinely pure logic introduced (e.g., transcript-event formatting, worktree-path safety validation, the state-machine transition helpers) gets normal unit tests, matching the degrade-cleanly precedent already established for `vault-repo.ts`.
- End-to-end behavior — a real build request running a real sandboxed agent loop against a real NVIDIA API key, producing a real, passing diff, and reaching `awaiting_code_approval` — is verified manually against a real running instance, the same precedent every other live-system-dependent feature in this codebase already follows.

## Decisions made during brainstorming

- **A dedicated isolated worktree + ephemeral sandbox container**, not working directly in the live production checkout — explicit user direction, protecting the running service from an autonomous agent's mistakes.
- **One unrestricted `run_shell_command` tool**, not a curated/allowlisted toolset — explicit user choice ("free reign... in its isolation"); the container boundary itself is the safety mechanism.
- **Exactly two checkpoints** (direction, then a combined testing-and-deployment gate) reusing the existing `build_requests` state machine, rather than adding new statuses or new stop points — explicit user direction, and it improves on today's system by making the approval checkpoint fire on already-tested code instead of an untested draft.
- **No GitHub credentials or production secrets during the free-reign coding phase** — directly per the user's "keep whatever Jarvis is coding off the internet" framing; secrets and GitHub access only enter the picture at the final, human-confirmed deployment step.
- **NVIDIA NIM as a separate provider for this agent only**, not routed through the existing Groq client — explicit user choice, motivated by Groq's rate-limit ceiling already being hit once this session.
- **Visibility is pull-based (a transcript the user can open on demand), not push-based** — explicit user direction ("viewing is upon request").
