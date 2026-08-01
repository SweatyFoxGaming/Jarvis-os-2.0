import { Router } from "express";
import { ObservationPlatform } from "../../kernel/observation.js";
import { validateApiKey } from "../../kernel/auth-middleware.js";
import * as permissions from "../../kernel/security.js";
import * as buildRequestsRepo from "../../kernel/state/build-requests-repo.js";
import * as transcriptEventsRepo from "../../kernel/state/transcript-events-repo.js";
import * as codingPlanTasksRepo from "../../kernel/state/coding-plan-tasks-repo.js";
import * as rewardEventsRepo from "../../kernel/state/reward-events-repo.js";
import * as builderClient from "../../kernel/builder-client.js";
import * as github from "../../capabilities/providers/github.js";
import { runApprovalFlow, isBuildRequestApprovalInFlight } from "../../executive/build-approval.js";
import { issueConfirmTicket, consumeConfirmTicket } from "../../kernel/confirm-tickets.js";
import { AutonomousExecutive } from "../../executive/autonomous_executive.js";
import { isEligibleForConfirmToken } from "./build-request-eligibility.js";

export { isEligibleForConfirmToken };

const observation = ObservationPlatform.getInstance();

export const buildRequestsRouter = Router();

buildRequestsRouter.get("/api/system/build-requests", validateApiKey, async (req: any, res: any) => {
  if (!permissions.hasGrant(req.username, "github.pulls.create")) {
    return res.status(403).json({ error: 'Missing capability grant "github.pulls.create"' });
  }
  try {
    res.json({ buildRequests: await buildRequestsRepo.listBuildRequests(req.query.status as buildRequestsRepo.BuildRequestStatus | undefined) });
  } catch (err: any) {
    res.json({ buildRequests: [], error: err.message });
  }
});

buildRequestsRouter.get("/api/system/build-requests/:id/transcript", validateApiKey, async (req: any, res: any) => {
  if (!permissions.hasGrant(req.username, "github.pulls.create")) {
    return res.status(403).json({ error: 'Missing capability grant "github.pulls.create"' });
  }
  try {
    res.json({ events: await transcriptEventsRepo.listTranscriptEvents(Number(req.params.id)) });
  } catch (err: any) {
    res.json({ events: [], error: err.message });
  }
});

buildRequestsRouter.get("/api/system/build-requests/:id/plan", validateApiKey, async (req: any, res: any) => {
  if (!permissions.hasGrant(req.username, "github.pulls.create")) {
    return res.status(403).json({ error: 'Missing capability grant "github.pulls.create"' });
  }
  try {
    res.json({ tasks: await codingPlanTasksRepo.listPlanTasks(Number(req.params.id)) });
  } catch (err: any) {
    res.json({ tasks: [], error: err.message });
  }
});

// Issues a fresh single-use token for a build request currently awaiting
// the user's direction — gated on the same "executive.plan" capability the
// (now-removed) confirm_build_direction tool used to imply via prompt
// instruction alone. The token itself is what a subsequent confirm-direction
// call must present; issuing one does not confirm anything by itself.
buildRequestsRouter.post("/api/system/build-requests/:id/confirm-token", validateApiKey, async (req: any, res: any) => {
  if (!permissions.hasGrant(req.username, "executive.plan")) {
    return res.status(403).json({ error: 'Missing capability grant "executive.plan"' });
  }
  try {
    const id = Number(req.params.id);
    const buildRequest = await buildRequestsRepo.getBuildRequest(id);
    // Only fetch the reward-gate row when it's actually relevant (status is
    // 'direction_confirmed') — no point spending a second query on the
    // ordinary awaiting_consult path.
    const pendingRewardGate =
      buildRequest?.status === "direction_confirmed"
        ? await buildRequestsRepo.getLatestPendingRewardGate(req.username)
        : null;
    if (!buildRequest || !isEligibleForConfirmToken(buildRequest, pendingRewardGate, id)) {
      return res.status(404).json({ error: "Build request not found or not awaiting direction" });
    }
    // getBuildRequest is unscoped — it resolves any build request by id,
    // regardless of who asked for it. Without this check, every holder of
    // executive.plan could mint a valid token for (and therefore confirm the
    // direction of) somebody else's build request. Deliberately the same 404
    // as "not found": whether a given id exists at all isn't this caller's
    // business either.
    if (buildRequest.requested_by !== req.username) {
      return res.status(404).json({ error: "Build request not found or not awaiting direction" });
    }
    const token = issueConfirmTicket(id, req.username);
    res.json({ token });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// The only place a build request actually moves past awaiting_consult now
// — requires a token minted by the route above, tied to this exact build
// request. There is no LLM-callable path to this outcome anymore (see the
// removal of the confirm_build_direction tool).
buildRequestsRouter.post("/api/system/build-requests/:id/confirm-direction", validateApiKey, async (req: any, res: any) => {
  if (!permissions.hasGrant(req.username, "executive.plan")) {
    return res.status(403).json({ error: 'Missing capability grant "executive.plan"' });
  }
  try {
    const id = Number(req.params.id);
    const { token, directionNotes } = req.body || {};
    if (!token || typeof directionNotes !== "string" || !directionNotes.trim()) {
      return res.status(400).json({ error: "token and directionNotes are required" });
    }
    const ticket = consumeConfirmTicket(token);
    if (!ticket || ticket.buildRequestId !== id) {
      return res.status(403).json({ error: "Invalid, expired, or already-used confirmation token." });
    }
    // The ticket records who it was minted for; a token is only valid in the
    // hands of that same user. Without this, a token leaked or observed by
    // any other executive.plan holder would confirm a build request on its
    // owner's behalf. The token is already consumed at this point, so a
    // mismatch also burns it rather than leaving it replayable.
    if (ticket.username !== req.username) {
      return res.status(403).json({ error: "This confirmation token was not issued to you." });
    }
    const result = await AutonomousExecutive.getInstance().confirmDirectionForBuildRequest(id, directionNotes, req.username);
    if (!result.ok) {
      return res.status(409).json({ error: result.message });
    }
    observation.logAuditEvent(req.username, "build_request_direction_confirmed", "success", `#${id}`);
    res.json({ ok: true, message: result.message });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// The human-driven entry point into the approval pipeline. The pipeline
// itself lives in executive/build-approval.ts so the automatic trigger in
// startCoding goes through the identical gates in the identical order — this
// handler's only remaining jobs are the capability check, loading the row,
// and translating the result into an HTTP response.
buildRequestsRouter.post("/api/system/build-requests/:id/approve-code", validateApiKey, async (req: any, res: any) => {
  if (!permissions.hasGrant(req.username, "github.pulls.create")) {
    return res.status(403).json({ error: 'Missing capability grant "github.pulls.create"' });
  }
  try {
    const buildRequest = await buildRequestsRepo.getBuildRequest(Number(req.params.id));
    if (!buildRequest) {
      return res.status(404).json({ error: "Build request not found or not awaiting approval" });
    }
    const result = await runApprovalFlow(buildRequest, req.username);
    if (!result.ok) {
      return res.status(result.httpStatus).json({ error: result.message });
    }
    res.json({ ...result.buildRequest, qa_summary: result.qaSummary, autonomous_merge: result.autonomousMerge });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

buildRequestsRouter.post("/api/system/build-requests/:id/reject-code", validateApiKey, async (req: any, res: any) => {
  if (!permissions.hasGrant(req.username, "github.pulls.create")) {
    return res.status(403).json({ error: 'Missing capability grant "github.pulls.create"' });
  }
  try {
    const id = Number(req.params.id);
    // Same in-process guard the approval pipeline itself takes — it now lives
    // in build-approval.ts, since the automatic trigger contends for it too.
    if (isBuildRequestApprovalInFlight(id)) {
      return res.status(409).json({ error: "This build request is currently being approved — try again shortly." });
    }
    const updated = await buildRequestsRepo.rejectCode(id);
    if (!updated) return res.status(404).json({ error: "Build request not found or not awaiting code approval" });
    await rewardEventsRepo.recordRewardEvent(updated.id, "terminal_outcome", updated.coding_model_used, updated.task_category || "general", -2);
    await builderClient.destroyWorkspace(updated.id).catch(() => {});
    observation.logAuditEvent(req.username, "build_request_code_rejected", "success", `#${updated.id}`);
    res.json(updated);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// A revert needs its OWN sandbox workspace, keyed separately from the build
// request's original (long-since-destroyed) one, so the two can never collide
// on a container name, a reservation slot, or a teardown.
//
// The obvious encoding — negating the id — does not work, and is why the
// original version of this endpoint could not have created a workspace at
// all: jarvis-builder/server.ts validates `buildRequestId <= 0` and answers
// 400 "buildRequestId must be a positive integer" on all three of
// POST /workspaces, /workspaces/:id/exec and DELETE /workspaces/:id. Worse,
// even if that check were relaxed, workspace.ts's startup reconciliation
// throws on any container whose `jarvis-build-request-id` label isn't a
// positive safe integer — so one leftover negative-id container would break
// the sandbox capacity reconciliation for the whole service on next boot.
//
// A large positive offset gives the same "distinct namespace" property while
// staying inside every one of those constraints. Real build request ids are
// Postgres serial values starting at 1; reaching a billion would take longer
// than this codebase will exist, and Number.isSafeInteger still holds with
// room to spare.
const REVERT_WORKSPACE_ID_OFFSET = 1_000_000_000;

// Runs one revert end-to-end for a single already-merged build request and
// returns a human-readable outcome. Split out of the route body so the loop
// below stays readable and every early exit is a plain `return` rather than a
// `continue` that has to remember to push a result first.
//
// The shape deliberately mirrors build-approval.ts's runApprovalFlow: the
// sandbox computes the content, and the GitHub *Contents API* (createBranch →
// commitFile → createPullRequest) is what publishes it. There is no `git
// push` anywhere, and there cannot be: jarvis-builder's createWorkspace wires
// `origin` to a local host path that is deleted before the container even
// starts, and the container is given no GitHub credentials by design (see
// jarvis-builder/workspace.ts's own comments on both points). A push from
// inside the sandbox has never had anywhere to go.
async function revertOneAutonomousMerge(
  target: buildRequestsRepo.BuildRequestRow,
  prNumber: number,
  owner: string,
  repoName: string,
  requestedBy: string
): Promise<{ ok: boolean; message: string }> {
  const revertBranch = `jarvis/revert-build-request-${target.id}`;
  const workspaceId = REVERT_WORKSPACE_ID_OFFSET + target.id; // see the offset's comment: distinct from the original build request's own workspace id, and still a positive integer jarvis-builder will accept
  if (!Number.isSafeInteger(workspaceId) || workspaceId <= REVERT_WORKSPACE_ID_OFFSET) {
    return { ok: false, message: `Build request id ${target.id} can't be mapped to a revert workspace id.` };
  }

  // Read the repo's real default branch rather than assuming "main" — same
  // call runApprovalFlow makes, and the same value is used for both the
  // sandbox clone's base and the eventual PR's base, so the diff the sandbox
  // computes is against exactly the branch the PR will target.
  const repoInfo = await github.getRepo(owner, repoName);
  const baseBranch = repoInfo.default_branch;

  try {
    await builderClient.createWorkspace(workspaceId, baseBranch);

    const checkout = await builderClient.execInWorkspace(workspaceId, `git checkout -b ${revertBranch}`);
    if (checkout.exitCode !== 0) {
      return { ok: false, message: `git checkout -b failed: ${checkout.stderr.slice(-1000)}` };
    }

    // Task 12 merges via merge_method: "squash", so each autonomous PR is one
    // normal commit on the default branch (not a merge commit) — no --merges
    // filter and no -m parent-selection flag, both of which only apply when
    // reverting an actual merge commit. GitHub's squash-commit *title* ends
    // with "(#<pr_number>)", so the pattern is anchored to end-of-line:
    // a bare "#N" would also match the number appearing anywhere in any
    // unrelated commit body (a build-request id colliding with some other
    // PR's number, an issue reference, a changelog line), and reverting the
    // wrong commit is not a recoverable mistake. --grep is a POSIX basic
    // regex here, so "(" and ")" are literals and only "$" is special.
    const lookup = await builderClient.execInWorkspace(
      workspaceId,
      `git log --format=%H -n 1 --grep="(#${prNumber})$"`
    );
    if (lookup.exitCode !== 0) {
      return { ok: false, message: `git log failed: ${lookup.stderr.slice(-1000)}` };
    }
    const sha = lookup.stdout.trim();
    if (!/^[0-9a-f]{7,40}$/.test(sha)) {
      return { ok: false, message: `Could not find a squash commit whose subject ends with "(#${prNumber})" on ${baseBranch}.` };
    }

    // `git revert` creates a real commit, which needs a git identity — the
    // sandbox image has none configured, so without these -c flags this fails
    // outright with "Please tell me who you are." Exactly the pattern
    // coding-agent.ts already uses for its own per-task commits.
    const revertResult = await builderClient.execInWorkspace(
      workspaceId,
      `git -c user.email=jarvis@local -c user.name=Jarvis revert --no-edit ${sha}`
    );
    if (revertResult.exitCode !== 0) {
      return { ok: false, message: `git revert failed: ${revertResult.stderr.slice(-1000)}` };
    }

    // Which files the revert touched — by definition the same set the
    // original commit touched, so diff the original commit against its own
    // parent rather than trying to diff the revert commit against a base the
    // sandbox would have to re-resolve. Same extraction shape as
    // coding-agent.ts's extractChangedFiles.
    const diff = await builderClient.execInWorkspace(workspaceId, `git diff --name-only ${sha}^ ${sha}`);
    if (diff.exitCode !== 0) {
      return { ok: false, message: `git diff failed: ${diff.stderr.slice(-1000)}` };
    }
    const paths = diff.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (paths.length === 0) {
      return { ok: false, message: `The commit for PR #${prNumber} changed no files — nothing to revert.` };
    }

    // Read each path's CURRENT (post-revert) content out of the worktree.
    // A path that no longer exists means the original commit ADDED it, so
    // reverting deletes it — and the Contents API helper this flow uses can
    // only create/update, never delete. Those paths are collected and called
    // out loudly in the PR body and the response instead of being silently
    // dropped: the resulting PR is a genuine but incomplete revert, and the
    // human reviewing it has to know that.
    const files: { path: string; content: string }[] = [];
    const undeletable: string[] = [];
    for (const path of paths) {
      const catResult = await builderClient.execInWorkspace(workspaceId, `cat "${path}"`);
      if (catResult.exitCode === 0) {
        files.push({ path, content: catResult.stdout });
      } else {
        undeletable.push(path);
      }
    }
    if (files.length === 0) {
      return {
        ok: false,
        message: `Reverting PR #${prNumber} only deletes files (${undeletable.join(", ")}), which this flow cannot express via the GitHub Contents API — revert it manually.`,
      };
    }

    await github.createBranch(owner, repoName, revertBranch, baseBranch);

    const commitMessage = `Revert build request #${target.id} (autonomous merge #${prNumber})`;
    for (const file of files) {
      await github.commitFile(owner, repoName, file.path, file.content, commitMessage, revertBranch);
    }

    const warning =
      undeletable.length > 0
        ? `\n\n**⚠️ Incomplete revert:** the original commit added ${undeletable.length} file(s) that this revert PR cannot delete — remove them by hand before merging: ${undeletable.join(", ")}`
        : "";
    const pr = await github.createPullRequest(
      owner,
      repoName,
      `Revert build request #${target.id}`,
      revertBranch,
      baseBranch,
      `Reverting autonomous merge #${prNumber} (commit ${sha}), requested by ${requestedBy}.${warning}`
    );

    return {
      ok: true,
      message: undeletable.length > 0 ? `${pr.html_url} (incomplete — see PR body)` : pr.html_url,
    };
  } finally {
    await builderClient.destroyWorkspace(workspaceId).catch(() => {});
  }
}

// Human-triggered only — "revert last N autonomous merges" per the design
// spec's guardrails. Reverts still get a real human look via a normal PR;
// they're just not blocked on one to *propose*.
buildRequestsRouter.post("/api/system/build-requests/revert-autonomous", validateApiKey, async (req: any, res: any) => {
  if (!permissions.hasGrant(req.username, "github.pulls.create")) {
    return res.status(403).json({ error: 'Missing capability grant "github.pulls.create"' });
  }
  const owner = process.env.SELF_REPO_OWNER;
  const repoName = process.env.SELF_REPO_NAME;
  if (!owner || !repoName) {
    return res.status(503).json({ error: "SELF_REPO_OWNER/SELF_REPO_NAME are not configured." });
  }
  const count = Number(req.body?.count);
  if (!Number.isInteger(count) || count < 1 || count > 20) {
    return res.status(400).json({ error: "count must be an integer between 1 and 20" });
  }
  try {
    const targets = await buildRequestsRepo.listRecentAutonomousMerges(count);
    if (targets.length === 0) {
      return res.status(404).json({ error: "No autonomous merges found to revert." });
    }
    const results: { buildRequestId: number; ok: boolean; message: string }[] = [];
    for (const target of targets) {
      if (!target.pr_number) {
        results.push({ buildRequestId: target.id, ok: false, message: "No recorded PR number to revert." });
        continue;
      }
      try {
        const outcome = await revertOneAutonomousMerge(target, target.pr_number, owner, repoName, req.username);
        results.push({ buildRequestId: target.id, ...outcome });
      } catch (err: any) {
        results.push({ buildRequestId: target.id, ok: false, message: err.message });
      }
    }
    observation.logAuditEvent(req.username, "build_requests_reverted", "success", JSON.stringify(results));
    res.json({ results });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
