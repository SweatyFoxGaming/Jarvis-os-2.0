import { ObservationPlatform } from "../kernel/observation.js";
import * as permissions from "../kernel/security.js";
import * as buildRequestsRepo from "../kernel/state/build-requests-repo.js";
import type { BuildRequestRow } from "../kernel/state/build-requests-repo.js";
import * as rewardEventsRepo from "../kernel/state/reward-events-repo.js";
import * as builderClient from "../kernel/builder-client.js";
import * as github from "../capabilities/providers/github.js";
import * as departments from "./departments.js";
import * as obsidian from "../capabilities/providers/obsidian.js";
import * as scheduler from "../kernel/scheduler.js";
import { getGroq } from "../runtime/clients.js";
import { isAutoMergeEligible } from "../kernel/autonomy-scope.js";

const observation = ObservationPlatform.getInstance();

// Deliberately NOT a member of ALL_CAPABILITIES in kernel/security.ts: that
// list is what the admin bootstrap seeds by default, so keeping this name out
// of it is what makes autonomous merging off-by-default and impossible to
// acquire by accident — it only ever exists as an explicit, audited grant.
const AUTONOMOUS_MERGE_CAPABILITY = "executive.autonomous_merge";
// A blast-radius ceiling, not a throughput target: even with the grant
// present and every diff eligible, at most this many merges can land without
// a human in a single day. countAutonomousMergesToday reads the
// build_requests.autonomous_merge column, so the cap survives restarts.
const AUTONOMOUS_MERGE_DAILY_CAP = 3;

export type ApprovalFlowResult =
  | { ok: true; buildRequest: BuildRequestRow; qaSummary: string; autonomousMerge: boolean }
  // `userNotified` tells an *automatic* caller (startCoding) whether this
  // branch already pushed a notification of its own. The HTTP route ignores
  // it — a human clicking Approve reads the failure straight off the
  // response — but the automatic path has nobody watching a response, so it
  // has to guarantee the user hears about every outcome without
  // double-notifying on the one branch that speaks for itself.
  | { ok: false; httpStatus: number; message: string; userNotified: boolean };

// Every failure return goes through this, so `userNotified` is always an
// explicit decision rather than something a newly-added branch can silently
// forget to set.
function fail(httpStatus: number, message: string, userNotified = false): ApprovalFlowResult {
  return { ok: false, httpStatus, message, userNotified };
}

/**
 * The single source of truth for "should this attempt proceed with zero human
 * involvement" — used both to gate whether startCoding invokes the pipeline
 * automatically at all, and (inside runApprovalFlow) to gate the merge call
 * specifically. One function, one place, so the two call sites can never
 * silently diverge on what "eligible" means.
 *
 * Ordered cheapest-and-most-restrictive first: the grant is a synchronous
 * in-memory lookup and is false by default, so the DB round-trip for the
 * daily count is never issued on the ordinary path.
 */
export async function isEligibleForAutomaticApproval(changedFilePaths: string[]): Promise<boolean> {
  return (
    permissions.hasGrant("admin", AUTONOMOUS_MERGE_CAPABILITY) &&
    isAutoMergeEligible(changedFilePaths) &&
    (await buildRequestsRepo.countAutonomousMergesToday()) < AUTONOMOUS_MERGE_DAILY_CAP
  );
}

// Rejects a proposed file path before any GitHub call happens. Nothing
// upstream validates these paths beyond "non-empty string" — the coding
// agent loop reads them straight back out of the sandbox worktree, with no
// traversal or absolute-path check anywhere — and this flow is the first
// (and only) place a model-drafted path reaches a real GitHub write:
// untrusted input, real repo, no prior gate.
function isUnsafeProposedPath(path: string): boolean {
  if (!path || path.startsWith("/") || path.includes("\0")) return true;
  return path.split("/").some((segment) => segment === "..");
}

// In-process guard against approve-code, reject-code, and the automatic
// trigger racing on the same build request — the final-verification pass can
// take minutes, widening what used to be a sub-second window where a reject
// could land mid-approval and destroy a workspace the approve flow is still
// using. Lives here rather than in the route file because this module is now
// the one place all three paths converge. Scoped to this process only (no new
// persisted status, per this plan's Global Constraints) — sufficient for this
// single-instance deployment.
const inFlightBuildRequestApprovals = new Set<number>();

export function isBuildRequestApprovalInFlight(id: number): boolean {
  return inFlightBuildRequestApprovals.has(id);
}

/**
 * The full approve-code pipeline: path safety -> final verification ->
 * independent review -> branch/commit/PR -> QA + reward + vault records ->
 * the scoped autonomous-merge decision. Callable from the HTTP route (a
 * human clicking Approve) and from startCoding (the automatic trigger), so
 * both go through exactly the same gates in exactly the same order.
 *
 * Returns a result rather than writing to an Express `res`, so the automatic
 * caller isn't obliged to fabricate one.
 */
export async function runApprovalFlow(buildRequest: BuildRequestRow, triggeredBy: string): Promise<ApprovalFlowResult> {
  const owner = process.env.SELF_REPO_OWNER;
  const repoName = process.env.SELF_REPO_NAME;
  if (!owner || !repoName) {
    return fail(503, "SELF_REPO_OWNER/SELF_REPO_NAME are not configured.");
  }
  if (buildRequest.status !== "awaiting_code_approval") {
    return fail(404, "Build request not found or not awaiting approval");
  }
  if (inFlightBuildRequestApprovals.has(buildRequest.id)) {
    return fail(409, "This build request is already being approved or rejected.");
  }
  inFlightBuildRequestApprovals.add(buildRequest.id);

  try {
    const files = buildRequest.proposed_files || [];
    if (files.length === 0) {
      await buildRequestsRepo.markPrError(buildRequest.id, "No proposed files to commit.");
      await builderClient.destroyWorkspace(buildRequest.id).catch(() => {});
      return fail(422, "No proposed files to commit.");
    }

    // Closing the gap noted above: reject the whole approval loudly and
    // cleanly if any proposed file targets a path outside the intended scope
    // (traversal, absolute path, or a null byte) — never commit any of them.
    const unsafePaths = files.map((f) => f.path).filter(isUnsafeProposedPath);
    if (unsafePaths.length > 0) {
      const message = `Refusing to commit unsafe file path(s): ${unsafePaths.join(", ")}`;
      await buildRequestsRepo.markPrError(buildRequest.id, message);
      await builderClient.destroyWorkspace(buildRequest.id).catch(() => {});
      return fail(422, message);
    }

    // From here on, this build request's sandbox workspace is still alive —
    // it was deliberately kept alive since coding-agent.ts's finish_coding,
    // specifically so this verification pass can run against the exact
    // on-disk state the coding session actually left, not any residual
    // assumption about it. Whatever happens next (success or any failure
    // below), the workspace's job ends here — torn down exactly once, in
    // `finally`, so no future edit to any branch below can forget to.
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
        return fail(502, message);
      }

      // A missing/reaped sandbox container (the approval sat long enough for
      // the reaper to reclaim it, or the coding session itself ran close to
      // the sandbox's lifetime) surfaces here as a normal nonzero exit, not a
      // thrown error — indistinguishable from a real test failure unless
      // explicitly checked for. Deliberately NOT calling markPrError here:
      // misreporting an infrastructure timing issue as a code-quality failure
      // would permanently burn the build request. Leaving status at
      // awaiting_code_approval means the human can still explicitly reject it
      // to close it out cleanly.
      const sandboxGone = verify.exitCode === 125 || /No such container|is not running/i.test(verify.stderr);
      if (sandboxGone) {
        return fail(
          503,
          "The sandbox workspace for this build request is no longer available (it may have expired). The proposed files are still recorded — reject this request to close it out."
        );
      }

      if (verify.exitCode !== 0) {
        const message = `Final verification failed (exit ${verify.exitCode}):\n${verify.stdout.slice(-2000)}\n${verify.stderr.slice(-2000)}`;
        await buildRequestsRepo.markPrError(buildRequest.id, message);
        return fail(422, message);
      }

      // Runs before any GitHub write happens, not after: this diff is about
      // to become a real, public PR opened on Jarvis's own behalf, and its one
      // independent review used to only run once that PR already existed —
      // meaning it was live and unreviewed by anyone, human or AI, for as long
      // as the review call took. Computing it first means its findings can
      // actually be baked into the PR body itself instead of arriving as a
      // note attached after the fact. It is also the gate the autonomous-merge
      // decision below sits behind: a rejected review returns here, long
      // before any github.* call is reachable.
      const review = await departments.reviewCodeDiff(buildRequest.objective, files, getGroq());
      if (!review.approved) {
        await buildRequestsRepo.markReviewFailed(buildRequest.id, review.findings);
        observation.logAuditEvent(
          triggeredBy,
          "build_request_review_failed",
          "success",
          `#${buildRequest.id}: ${review.findings.slice(0, 200)}`
        );
        scheduler.pushNotification(
          buildRequest.requested_by,
          `I held build request #${buildRequest.id} back from opening a pull request, sir — my own review found a problem: ${review.findings.slice(0, 300)}`,
          "warning"
        );
        // userNotified: this branch pushed its own specific warning above.
        return fail(422, `Automated review did not approve this change: ${review.findings}`, true);
      }
      const qaSummary = review.findings;

      const branchName = `jarvis/build-request-${buildRequest.id}`;

      let repoInfo: any;
      try {
        repoInfo = await github.getRepo(owner, repoName);
      } catch (err: any) {
        const message = `Failed to read repo default branch: ${err.message}`;
        await buildRequestsRepo.markPrError(buildRequest.id, message);
        return fail(502, message);
      }
      const baseBranch = repoInfo.default_branch;

      try {
        await github.createBranch(owner, repoName, branchName, baseBranch);
      } catch (err: any) {
        const message = `Failed to create branch: ${err.message}`;
        await buildRequestsRepo.markPrError(buildRequest.id, message);
        return fail(502, message);
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
          const message = `Failed to commit "${file.path}": ${err.message}. Branch "${branchName}" may exist with a partial commit — review it manually.`;
          await buildRequestsRepo.markPrError(buildRequest.id, message);
          return fail(502, message);
        }
      }

      // The QA summary computed above goes into the PR body itself, so the
      // review is visible from the moment the PR exists rather than arriving
      // as a note attached some time after it's already public.
      const prBody = [buildRequest.code_summary, "---", "**Automated QA review:**", qaSummary].filter(Boolean).join("\n\n");

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
        const message = `Branch and commits succeeded but opening the PR failed: ${err.message}`;
        await buildRequestsRepo.markPrError(buildRequest.id, message);
        return fail(502, message);
      }

      const updated = await buildRequestsRepo.recordPrOpened(buildRequest.id, pr.html_url, pr.number);
      if (!updated) {
        return fail(500, "PR was opened but couldn't be recorded — check GitHub directly.");
      }

      observation.logAuditEvent(triggeredBy, "build_request_pr_opened", "success", `#${updated.id} -> ${pr.html_url}`);

      // recordQaReview's own UPDATE only matches status = 'pr_opened' (the
      // state recordPrOpened just set), so this must run after it, not before
      // — the review itself was already computed above, ahead of the PR going
      // live; only persisting the qa_complete status waits for the row to
      // actually reach that state.
      await buildRequestsRepo.recordQaReview(updated.id, qaSummary);

      await rewardEventsRepo.recordRewardEvent(
        updated.id,
        "terminal_outcome",
        updated.coding_model_used,
        updated.task_category || "general",
        2
      );

      obsidian
        .writeOrUpdateCodingNote(updated.id, updated.objective, {
          directionNotes: updated.direction_notes || undefined,
          codeSummary: updated.code_summary || undefined,
          files: files.map((f: any) => f.path),
          prUrl: updated.pr_url || undefined,
          qaSummary,
          status: "qa_complete",
        })
        .catch((err: any) => {
          observation.logTelemetry("warn", "Interaction", `Failed to write coding vault note: ${err.message}`);
        });

      // The one new decision point: eligible path + grant present + under the
      // daily cap -> merge immediately instead of waiting for a human click.
      // Any one condition failing falls through to exactly the pre-existing
      // behavior (PR open, notification sent, waiting). Ordered cheapest-and-
      // most-restrictive first: the grant is a synchronous in-memory lookup
      // and is the condition that is false by default, so the DB round-trip
      // for the daily count is never even issued on the ordinary path.
      let autonomousMerge = false;
      if (await isEligibleForAutomaticApproval(files.map((f) => f.path))) {
        try {
          await github.mergePullRequest(owner, repoName, pr.number);
          const merged = await buildRequestsRepo.markAutonomousMerge(updated.id);
          if (merged) {
            autonomousMerge = true;
            observation.logAuditEvent(
              triggeredBy,
              "build_request_autonomous_merge",
              "success",
              `#${updated.id} -> ${pr.html_url}`
            );
            scheduler.pushNotification(
              updated.requested_by,
              `I autonomously merged build request #${updated.id}, sir: ${pr.html_url}. QA review: ${qaSummary.slice(0, 300)}${qaSummary.length > 300 ? "..." : ""}`,
              "info"
            );
          }
        } catch (err: any) {
          // Merge failing after the PR already opened is not a build-request
          // error — the PR still exists, correctly, waiting for a human, and
          // the row is already at qa_complete with its pr_url recorded. Not
          // calling markPrError here on purpose: it would overwrite a
          // perfectly good terminal state with an error one.
          observation.logTelemetry(
            "warn",
            "Executive",
            `Autonomous merge failed for build request ${updated.id}, leaving PR open for manual merge: ${err.message}`
          );
        }
      }

      if (!autonomousMerge) {
        scheduler.pushNotification(
          updated.requested_by,
          `Opened the pull request for build request #${updated.id}, sir: ${pr.html_url}. QA review: ${qaSummary.slice(0, 300)}${qaSummary.length > 300 ? "..." : ""} Check GitHub for CI status.`,
          "info"
        );
      }

      return { ok: true, buildRequest: updated, qaSummary, autonomousMerge };
    } finally {
      await builderClient.destroyWorkspace(buildRequest.id).catch(() => {});
    }
  } finally {
    inFlightBuildRequestApprovals.delete(buildRequest.id);
  }
}
