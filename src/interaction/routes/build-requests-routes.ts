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
      const revertBranch = `jarvis/revert-build-request-${target.id}`;
      const workspaceId = -target.id; // negative id keys a dedicated revert workspace, distinct from the original build request's own (already-destroyed) workspace id
      try {
        await builderClient.createWorkspace(workspaceId, "main");
        await builderClient.execInWorkspace(workspaceId, `git checkout -b ${revertBranch}`);
        // Task 12 merges via merge_method: "squash", so each autonomous PR is
        // one normal commit on main (not a merge commit) — no --merges filter
        // and no -m parent-selection flag, both of which only apply when
        // reverting an actual merge commit. GitHub's default squash-commit
        // title includes "(#<pr_number>)", which --grep finds directly.
        const revertResult = await builderClient.execInWorkspace(workspaceId, `git revert --no-edit $(git log --format=%H -n 1 --grep="#${target.pr_number}")`);
        if (revertResult.exitCode !== 0) {
          results.push({ buildRequestId: target.id, ok: false, message: `git revert failed: ${revertResult.stderr.slice(-1000)}` });
          continue;
        }
        await builderClient.execInWorkspace(workspaceId, `git push origin ${revertBranch}`);
        const pr = await github.createPullRequest(owner, repoName, `Revert build request #${target.id}`, revertBranch, "main", `Reverting autonomous merge #${target.pr_number}, requested by ${req.username}.`);
        results.push({ buildRequestId: target.id, ok: true, message: pr.html_url });
      } catch (err: any) {
        results.push({ buildRequestId: target.id, ok: false, message: err.message });
      } finally {
        await builderClient.destroyWorkspace(workspaceId).catch(() => {});
      }
    }
    observation.logAuditEvent(req.username, "build_requests_reverted", "success", JSON.stringify(results));
    res.json({ results });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
