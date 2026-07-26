import { Router } from "express";
import { ObservationPlatform } from "../../kernel/observation.js";
import { validateApiKey } from "../../kernel/auth-middleware.js";
import * as permissions from "../../kernel/security.js";
import * as buildRequestsRepo from "../../kernel/state/build-requests-repo.js";
import * as transcriptEventsRepo from "../../kernel/state/transcript-events-repo.js";
import * as codingPlanTasksRepo from "../../kernel/state/coding-plan-tasks-repo.js";
import * as builderClient from "../../kernel/builder-client.js";
import * as github from "../../capabilities/providers/github.js";
import * as departments from "../../executive/departments.js";
import * as obsidian from "../../capabilities/providers/obsidian.js";
import * as scheduler from "../../kernel/scheduler.js";
import { getGroq } from "../../runtime/clients.js";

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

// Rejects a proposed file path before any GitHub call happens. Nothing
// upstream validates these paths beyond "non-empty string" — the coding
// agent loop reads them straight back out of the sandbox worktree, with no
// traversal or absolute-path check anywhere — and this route is the first
// (and only) place a model-drafted path reaches a real GitHub write:
// untrusted input, real repo, no prior gate.
function isUnsafeProposedPath(path: string): boolean {
  if (!path || path.startsWith("/") || path.includes("\0")) return true;
  return path.split("/").some((segment) => segment === "..");
}

// In-process guard against approve-code and reject-code racing on the same
// build request — the new final-verification pass (Task 5) can take minutes,
// widening what used to be a sub-second window where a reject could land
// mid-approval and destroy a workspace the approve flow is still using.
// Scoped to this process only (no new persisted status, per this plan's
// Global Constraints) — sufficient for this single-instance deployment.
const inFlightBuildRequestApprovals = new Set<number>();

// The only place in this codebase that opens a real PR on Jarvis's own
// behalf. Every GitHub call here (branch -> commit each file -> open PR) is
// wrapped so a partial failure records exactly which step failed via
// markPrError rather than silently claiming a status it didn't reach — see
// this plan's Global Constraints.
buildRequestsRouter.post("/api/system/build-requests/:id/approve-code", validateApiKey, async (req: any, res: any) => {
  if (!permissions.hasGrant(req.username, "github.pulls.create")) {
    return res.status(403).json({ error: 'Missing capability grant "github.pulls.create"' });
  }
  const owner = process.env.SELF_REPO_OWNER;
  const repoName = process.env.SELF_REPO_NAME;
  if (!owner || !repoName) {
    return res.status(503).json({ error: "SELF_REPO_OWNER/SELF_REPO_NAME are not configured." });
  }
  try {
    const buildRequest = await buildRequestsRepo.getBuildRequest(Number(req.params.id));
    if (!buildRequest || buildRequest.status !== "awaiting_code_approval") {
      return res.status(404).json({ error: "Build request not found or not awaiting approval" });
    }
    if (inFlightBuildRequestApprovals.has(buildRequest.id)) {
      return res.status(409).json({ error: "This build request is already being approved or rejected." });
    }
    inFlightBuildRequestApprovals.add(buildRequest.id);

    try {
      const files = buildRequest.proposed_files || [];
      if (files.length === 0) {
        await buildRequestsRepo.markPrError(buildRequest.id, "No proposed files to commit.");
        await builderClient.destroyWorkspace(buildRequest.id).catch(() => {});
        return res.status(422).json({ error: "No proposed files to commit." });
      }

      // Closing the gap noted above: reject the whole approval loudly and
      // cleanly if any proposed file targets a path outside the intended
      // scope (traversal, absolute path, or a null byte) — never commit any
      // of them.
      const unsafePaths = files.map((f) => f.path).filter(isUnsafeProposedPath);
      if (unsafePaths.length > 0) {
        const message = `Refusing to commit unsafe file path(s): ${unsafePaths.join(", ")}`;
        await buildRequestsRepo.markPrError(buildRequest.id, message);
        await builderClient.destroyWorkspace(buildRequest.id).catch(() => {});
        return res.status(422).json({ error: message });
      }

      // From here on, this build request's sandbox workspace (Plan 1) is
      // still alive — it was deliberately kept alive since coding-agent.ts's
      // finish_coding, specifically so this verification pass can run
      // against the exact on-disk state the coding session actually left,
      // not any residual/stateful assumption about it. Whatever happens next
      // (success or any failure below), the workspace's job ends here — torn
      // down exactly once, in `finally`, so no future edit to any branch
      // below can forget to.
      try {
        // Final verification: a fresh install and the full test suite/typecheck
        // — not trusting whatever state the free-reign coding session happened
        // to leave the container in — so this reflects exactly what's about to
        // be committed, per the design spec's testing-and-deployment checkpoint.
        let verify: { stdout: string; stderr: string; exitCode: number };
        try {
          verify = await builderClient.execInWorkspace(
            buildRequest.id,
            "rm -rf node_modules && npm ci && npm test && npx tsc --noEmit"
          );
        } catch (err: any) {
          const message = `Final verification could not run: ${err.message}`;
          await buildRequestsRepo.markPrError(buildRequest.id, message);
          return res.status(502).json({ error: message });
        }

        // A missing/reaped sandbox container (the approval sat long enough for
        // the reaper to reclaim it, or the coding session itself ran close to
        // the sandbox's lifetime) surfaces here as a normal nonzero exit, not a
        // thrown error — indistinguishable from a real test failure unless
        // explicitly checked for. Deliberately NOT calling markPrError here:
        // misreporting an infrastructure timing issue as a code-quality
        // failure would permanently burn the build request. Leaving status at
        // awaiting_code_approval means the human can still explicitly reject
        // it to close it out cleanly.
        const sandboxGone = verify.exitCode === 125 || /No such container|is not running/i.test(verify.stderr);
        if (sandboxGone) {
          const message =
            "The sandbox workspace for this build request is no longer available (it may have expired). The proposed files are still recorded — reject this request to close it out.";
          return res.status(503).json({ error: message });
        }

        if (verify.exitCode !== 0) {
          const message = `Final verification failed (exit ${verify.exitCode}):\n${verify.stdout.slice(-2000)}\n${verify.stderr.slice(-2000)}`;
          await buildRequestsRepo.markPrError(buildRequest.id, message);
          return res.status(422).json({ error: message });
        }

        // Runs before any GitHub write happens, not after: this diff is about
        // to become a real, public PR opened on Jarvis's own behalf, and its
        // one independent review used to only run once that PR already
        // existed — meaning it was live and unreviewed by anyone, human or
        // AI, for as long as the review call took. Computing it first means
        // its findings can actually be baked into the PR body itself instead
        // of arriving as a note attached after the fact.
        const qaSummary = await departments.reviewCodeDiff(buildRequest.objective, files, getGroq());
        await buildRequestsRepo.recordQaReview(buildRequest.id, qaSummary);

        const branchName = `jarvis/build-request-${buildRequest.id}`;

        let repoInfo: any;
        try {
          repoInfo = await github.getRepo(owner, repoName);
        } catch (err: any) {
          await buildRequestsRepo.markPrError(buildRequest.id, `Failed to read repo default branch: ${err.message}`);
          return res.status(502).json({ error: `Failed to read repo default branch: ${err.message}` });
        }
        const baseBranch = repoInfo.default_branch;

        try {
          await github.createBranch(owner, repoName, branchName, baseBranch);
        } catch (err: any) {
          await buildRequestsRepo.markPrError(buildRequest.id, `Failed to create branch: ${err.message}`);
          return res.status(502).json({ error: `Failed to create branch: ${err.message}` });
        }

        for (const file of files) {
          try {
            await github.commitFile(
              owner,
              repoName,
              file.path,
              file.content,
              `Build request #${buildRequest.id}: ${buildRequest.code_summary || buildRequest.objective}`,
              branchName
            );
          } catch (err: any) {
            await buildRequestsRepo.markPrError(
              buildRequest.id,
              `Failed to commit "${file.path}": ${err.message}. Branch "${branchName}" may exist with a partial commit — review it manually.`
            );
            return res.status(502).json({ error: `Failed to commit "${file.path}": ${err.message}` });
          }
        }

        // The QA summary computed above goes into the PR body itself, so the
        // review is visible from the moment the PR exists rather than
        // arriving as a note attached some time after it's already public.
        const prBody = [buildRequest.code_summary, "---", "**Automated QA review:**", qaSummary]
          .filter(Boolean)
          .join("\n\n");

        let pr: any;
        try {
          pr = await github.createPullRequest(
            owner,
            repoName,
            `Build request #${buildRequest.id}: ${buildRequest.objective}`,
            branchName,
            baseBranch,
            prBody || undefined
          );
        } catch (err: any) {
          await buildRequestsRepo.markPrError(buildRequest.id, `Branch and commits succeeded but opening the PR failed: ${err.message}`);
          return res.status(502).json({ error: `Failed to open PR: ${err.message}` });
        }

        const updated = await buildRequestsRepo.recordPrOpened(buildRequest.id, pr.html_url, pr.number);
        if (!updated) {
          return res.status(500).json({ error: "PR was opened but couldn't be recorded — check GitHub directly." });
        }

        observation.logAuditEvent(req.username, "build_request_pr_opened", "success", `#${updated.id} -> ${pr.html_url}`);

        obsidian.writeOrUpdateCodingNote(updated.id, updated.objective, {
          directionNotes: updated.direction_notes || undefined,
          codeSummary: updated.code_summary || undefined,
          files: files.map((f: any) => f.path),
          prUrl: updated.pr_url || undefined,
          qaSummary,
          status: "qa_complete",
        }).catch((err: any) => {
          observation.logTelemetry("warn", "Interaction", `Failed to write coding vault note: ${err.message}`);
        });

        scheduler.pushNotification(
          req.username,
          `Opened the pull request for build request #${updated.id}, sir: ${pr.html_url}. QA review: ${qaSummary.slice(0, 300)}${qaSummary.length > 300 ? "..." : ""} Check GitHub for CI status.`,
          "info"
        );

        res.json({ ...updated, qa_summary: qaSummary });
      } finally {
        await builderClient.destroyWorkspace(buildRequest.id).catch(() => {});
      }
    } finally {
      inFlightBuildRequestApprovals.delete(buildRequest.id);
    }
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
    if (inFlightBuildRequestApprovals.has(id)) {
      return res.status(409).json({ error: "This build request is currently being approved — try again shortly." });
    }
    const updated = await buildRequestsRepo.rejectCode(id);
    if (!updated) return res.status(404).json({ error: "Build request not found or not awaiting code approval" });
    await builderClient.destroyWorkspace(updated.id).catch(() => {});
    observation.logAuditEvent(req.username, "build_request_code_rejected", "success", `#${updated.id}`);
    res.json(updated);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
