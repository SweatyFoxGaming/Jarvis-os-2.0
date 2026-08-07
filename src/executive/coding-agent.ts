import { ObservationPlatform } from "../kernel/observation.js";
import * as builderClient from "../kernel/builder-client.js";
import { recordTranscriptEvent } from "../kernel/state/transcript-events-repo.js";
import * as codingPlanTasksRepo from "../kernel/state/coding-plan-tasks-repo.js";
import type { PlannedTaskInput } from "../kernel/state/coding-plan-tasks-repo.js";
import { incrementTokenUsage } from "../kernel/state/build-requests-repo.js";
import { callGroqAgentChat, AgentMessage, AgentTool, DEFAULT_MODELS } from "../runtime/groq-agent-client.js";
import * as departments from "./departments.js";
import type { DraftedFile } from "../kernel/state/build-requests-repo.js";
import { positiveIntegerEnv } from "../kernel/env.js";
import type { OpenAiCompatibleConfig } from "../runtime/openai-compatible-client.js";
import * as rewardEventsRepo from "../kernel/state/reward-events-repo.js";
import { classifyTaskCategory } from "./task-category.js";

const observation = ObservationPlatform.getInstance();

// Defense-in-depth alongside jarvis-builder's own 1-hour reaper (Plan 1) —
// bounds a model that never calls finish_coding/finish_task, surfaced as an
// honest error rather than silently truncated (design spec, "The agentic
// loop"). MAX_TURNS bounds the flat-loop fallback (the whole objective in
// one pass); MAX_TASK_TURNS bounds one task across all its fix attempts
// combined, not per attempt — simpler to reason about than a separate
// budget per retry.
const MAX_TURNS = 40;
const MAX_TASK_TURNS = 30;
const MAX_TASK_FIX_ATTEMPTS = 2;
const MAX_PLAN_TASKS = 10;

// Turn caps alone bound *how many* Groq calls a session can make (up to
// 300: MAX_PLAN_TASKS × MAX_TASK_TURNS), not how much any of them actually
// cost — a worst case of 300 calls with a large, growing conversation
// history could still run up real spend with nothing tracking it. This is
// a token count, not a dollar figure, deliberately: Groq pricing varies by
// model and this codebase isn't going to guess a number it can't verify.
// Convert to a dollar ceiling yourself via JARVIS_CODING_AGENT_TOKEN_BUDGET
// based on your actual Groq pricing tier — see .env.example. 4,000,000 is
// a first-pass, deliberately generous
// backstop (a session that legitimately needs more than that is unusual),
// not a carefully tuned number — the point is having *a* ceiling where
// today there is none, the same spirit as MAX_TURNS/MAX_TASK_TURNS above.
const MAX_TOKENS_PER_SESSION = positiveIntegerEnv(process.env.JARVIS_CODING_AGENT_TOKEN_BUDGET, 4_000_000);

// Shared by both the per-task loop and the flat-loop fallback, which build
// otherwise-different system prompts but want the identical caution.
// Not empirically tuned yet — a first-pass threshold pending real usage
// data; see the design spec's Open Questions section.
async function buildCategoryCaution(category: string): Promise<string> {
  const categoryScore = await rewardEventsRepo.getCategoryScore(category);
  return categoryScore && categoryScore.count >= 3 && categoryScore.score < -0.3
    ? ` Note: past sessions touching ${category} work have had a rough track record (${categoryScore.count} prior attempts) — be extra careful here.`
    : "";
}

const RUN_SHELL_TOOL: AgentTool = {
  type: "function",
  function: {
    name: "run_shell_command",
    description:
      "Run a shell command in the sandboxed workspace (cwd is the repository root) and get back stdout, stderr, and the exit code.",
    parameters: {
      type: "object",
      properties: { command: { type: "string", description: "The shell command to run." } },
      required: ["command"],
      additionalProperties: false,
    },
  },
};

const FINISH_CODING_TOOL: AgentTool = {
  type: "function",
  function: {
    name: "finish_coding",
    description:
      "Call this once the objective is fully implemented, tested, and ready for human review. Ends the coding session.",
    parameters: {
      type: "object",
      properties: { summary: { type: "string", description: "A concise summary of what was changed and why." } },
      required: ["summary"],
      additionalProperties: false,
    },
  },
};

const FINISH_TASK_TOOL: AgentTool = {
  type: "function",
  function: {
    name: "finish_task",
    description: "Call this once this specific task is fully implemented and ready for review. Ends this task's turn.",
    parameters: {
      type: "object",
      properties: { summary: { type: "string", description: "A concise summary of what this task changed." } },
      required: ["summary"],
      additionalProperties: false,
    },
  },
};

const PROPOSE_PLAN_TOOL: AgentTool = {
  type: "function",
  function: {
    name: "propose_plan",
    description: "Break the objective into an ordered list of small, self-contained tasks.",
    parameters: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string", description: "Short task title." },
              description: { type: "string", description: "What this task does and why." },
            },
            required: ["title", "description"],
            additionalProperties: false,
          },
        },
      },
      required: ["tasks"],
      additionalProperties: false,
    },
  },
};

export type CodingAgentResult =
  | { ok: true; summary: string; files: DraftedFile[]; modelUsed: string | null; category: string }
  | { ok: false; error: string };

export async function runCodingAgent(
  buildRequestId: number,
  objective: string,
  researchSummary: string,
  directionNotes: string,
  baseBranch: string,
  omniRoute: OpenAiCompatibleConfig | null
): Promise<CodingAgentResult> {
  // omniRoute is now the single client for both the tool-calling backend
  // (planning/coding) and departments.reviewTaskDiff's review gate below —
  // departments.ts finished migrating off the raw Groq SDK in the same
  // OmniRoute cognition gateway migration this function did, so there's no
  // longer a second, separately-fetched client to null-check here.
  if (!omniRoute) {
    return { ok: false, error: "No OmniRoute client is configured — the agentic coding loop is unavailable." };
  }

  const category = classifyTaskCategory(objective);
  const modelOrder = await rewardEventsRepo.getModelPreferenceOrder(DEFAULT_MODELS);

  try {
    await builderClient.createWorkspace(buildRequestId, baseBranch);
  } catch (err: any) {
    return { ok: false, error: `Failed to create the sandboxed workspace: ${err.message}` };
  }

  // execInWorkspace can reject outright (network/transport failure against
  // jarvis-builder), not just resolve with a nonzero exitCode — this is the
  // same failure class proposePlan's own try/catch guards against below,
  // and without a guard here a transport-level throw would escape
  // runCodingAgent entirely, leaking the workspace and leaving the build
  // request wedged in 'coding' with no recovery path.
  let baseShaResult: { stdout: string; stderr: string; exitCode: number };
  try {
    baseShaResult = await builderClient.execInWorkspace(buildRequestId, "git rev-parse HEAD");
  } catch (err: any) {
    await builderClient.destroyWorkspace(buildRequestId).catch(() => {});
    return { ok: false, error: `Failed to resolve the workspace's starting commit: ${err.message}` };
  }
  if (baseShaResult.exitCode !== 0) {
    await builderClient.destroyWorkspace(buildRequestId).catch(() => {});
    return { ok: false, error: `Failed to resolve the workspace's starting commit: ${baseShaResult.stderr}` };
  }
  const baseSha = baseShaResult.stdout.trim();

  const planResult = await proposePlan(buildRequestId, omniRoute, objective, researchSummary, directionNotes, modelOrder);
  // Planning is the session's genuinely first LLM call, so its model is the
  // session's first model. Seeding here (rather than starting at null below)
  // keeps the "first non-null wins" capture in the loops from overwriting it
  // with whatever the second call happened to land on.
  let sessionModelUsed: string | null = planResult.modelUsed;

  if (planResult.tasks === null) {
    // Planning couldn't produce a usable task list after a retry — fall
    // back to running the whole objective through the flat loop rather
    // than failing the build request outright. Planning is meant to
    // improve reliability, not become a new single point of failure.
    // planResult.tokensUsed seeds the flat loop's own counter so planning's
    // spend still counts against the one session budget, not a separate
    // allowance outside it.
    return runFlatCodingLoop(buildRequestId, objective, researchSummary, directionNotes, baseSha, omniRoute, category, modelOrder, planResult.modelUsed, planResult.tokensUsed);
  }
  const plan = planResult.tasks;

  await codingPlanTasksRepo.createPlan(buildRequestId, plan);

  let seq = 0;
  // Shared across every task in the plan, not reset per task — the budget
  // bounds the whole session's spend, the same way MAX_TASK_TURNS bounds
  // one task's turns but the overall 300-call ceiling (MAX_PLAN_TASKS ×
  // MAX_TASK_TURNS) is what actually bounds the session today. Seeded with
  // planResult.tokensUsed for the same reason as the flat-loop fallback
  // above — planning's own Groq calls count against this same budget.
  let tokensUsed = planResult.tokensUsed;
  const completedSummaries: string[] = [];

  const categoryCaution = await buildCategoryCaution(category);

  try {
    for (const task of plan) {
      await codingPlanTasksRepo.updateTaskStatus(buildRequestId, task.seq, "in_progress");

      const taskBaseShaResult = await builderClient.execInWorkspace(buildRequestId, "git rev-parse HEAD");
      if (taskBaseShaResult.exitCode !== 0) {
        await codingPlanTasksRepo.updateTaskStatus(buildRequestId, task.seq, "failed");
        await builderClient.destroyWorkspace(buildRequestId).catch(() => {});
        return { ok: false, error: `Failed to resolve the starting commit for task "${task.title}": ${taskBaseShaResult.stderr}` };
      }
      const taskBaseSha = taskBaseShaResult.stdout.trim();

      const planText = plan.map((t) => `${t.seq}. ${t.title} — ${t.description}`).join("\n");
      const completedText = completedSummaries.length > 0 ? completedSummaries.join("\n") : "(none yet)";

      const messages: AgentMessage[] = [
        {
          role: "system",
          content:
            `You are Jarvis's coding agent, working alone in an isolated sandboxed git worktree at the repository root. ` +
            `Objective: ${objective}\n\nResearch summary:\n${researchSummary || "(none)"}\n\nConfirmed direction:\n${directionNotes}\n\n` +
            `Full plan:\n${planText}\n\nAlready completed:\n${completedText}\n\n` +
            `Your current task: ${task.title} — ${task.description}\n\n` +
            `You have exactly one tool for doing work — run_shell_command — plus finish_task to end this task once it's ` +
            `fully implemented. Read files with cat, edit with heredocs or sed, run tests with the project's test command, ` +
            `check types, and use git to inspect your changes. Don't worry about committing — that happens automatically ` +
            `once your work passes review.${categoryCaution}`,
        },
        // Some OpenAI-compatible tool-calling backends behave more
        // reliably with an explicit user turn before tools are offered
        // (NVIDIA NIM, this loop's previous backend, rejected requests
        // with none at all) — kept as a cheap defensive habit even though
        // Groq hasn't shown the same requirement. Doesn't change what's
        // actually being asked (that's all in the system message above).
        { role: "user", content: "Begin." },
      ];

      let taskTurns = 0;
      let taskApproved = false;
      let taskSummary = "";
      let hitTurnCap = false;
      let hitBudgetCap = false;
      let lastFindings = "";

      for (let fixAttempt = 0; fixAttempt <= MAX_TASK_FIX_ATTEMPTS && !taskApproved; fixAttempt++) {
        let finishedSummary: string | null = null;

        while (finishedSummary === null) {
          if (taskTurns >= MAX_TASK_TURNS) {
            hitTurnCap = true;
            break;
          }
          if (tokensUsed >= MAX_TOKENS_PER_SESSION) {
            hitBudgetCap = true;
            break;
          }
          taskTurns++;

          const response = await callGroqAgentChat(omniRoute, messages, [RUN_SHELL_TOOL, FINISH_TASK_TOOL], modelOrder);
          if (response.totalTokens) {
            tokensUsed += response.totalTokens;
            await incrementTokenUsage(buildRequestId, response.totalTokens);
          }
          if (response.modelUsed && !sessionModelUsed) {
            sessionModelUsed = response.modelUsed;
          }
          // Checked again immediately after this call, not just before the
          // next one: the pre-call check above only ever catches a session
          // that was ALREADY over budget — without this, the exact call
          // that first crosses the cap still gets its tool calls processed,
          // including a finish_task that would let the task complete as if
          // nothing were wrong, one call past where the session was
          // supposed to stop.
          if (tokensUsed >= MAX_TOKENS_PER_SESSION) {
            hitBudgetCap = true;
            break;
          }

          if (!response.toolCalls || response.toolCalls.length === 0) {
            messages.push({ role: "assistant", content: response.content });
            messages.push({
              role: "user",
              content: "Use run_shell_command to keep working, or finish_task if this task is complete.",
            });
            continue;
          }

          messages.push({ role: "assistant", content: response.content, tool_calls: response.toolCalls });

          for (const call of response.toolCalls) {
            if (call.function.name === "finish_task") {
              let summary = `Task "${task.title}" finished.`;
              try {
                const parsed = JSON.parse(call.function.arguments);
                if (typeof parsed.summary === "string" && parsed.summary.trim()) summary = parsed.summary;
              } catch {
                // Malformed arguments — fall back to the default summary.
              }
              finishedSummary = summary;
              messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ ok: true }) });
              continue;
            }

            if (call.function.name === "run_shell_command") {
              let command = "";
              try {
                const parsed = JSON.parse(call.function.arguments);
                command = typeof parsed.command === "string" ? parsed.command : "";
              } catch {
                messages.push({
                  role: "tool",
                  tool_call_id: call.id,
                  content: JSON.stringify({ error: "Malformed arguments — command must be valid JSON with a string 'command' field." }),
                });
                continue;
              }
              if (!command) {
                messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ error: "command was empty." }) });
                continue;
              }

              const result = await builderClient
                .execInWorkspace(buildRequestId, command)
                .catch((err: any) => ({ stdout: "", stderr: err.message || String(err), exitCode: -1 }));

              seq++;
              await recordTranscriptEvent(buildRequestId, seq, command, result.stdout, result.stderr, result.exitCode);

              messages.push({
                role: "tool",
                tool_call_id: call.id,
                content: JSON.stringify({
                  stdout: result.stdout.slice(0, 8000),
                  stderr: result.stderr.slice(0, 4000),
                  exitCode: result.exitCode,
                }),
              });
              continue;
            }

            messages.push({
              role: "tool",
              tool_call_id: call.id,
              content: JSON.stringify({ error: `Unknown tool: ${call.function.name}` }),
            });
          }
        }

        if (finishedSummary === null) {
          // Hit the turn cap without a finish_task call — same failure
          // class as exhausting fix attempts, handled below the loop.
          break;
        }

        const { files: taskFiles, skipped: taskSkipped } = await extractChangedFiles(buildRequestId, taskBaseSha);
        // A deterministic gate ahead of the LLM reviewer: code that doesn't
        // even compile or pass its own tests shouldn't reach an LLM
        // judgment call at all — this is real, not up to interpretation.
        // Reuses the exact retry-with-feedback path below (rewardEventsRepo
        // recording, lastFindings, the approve/retry branch) unchanged;
        // only the source of `verdict` changes on a verification failure.
        const verifyResult = await builderClient
          .execInWorkspace(buildRequestId, "npx tsc --noEmit && npm test")
          .catch((err: any) => ({ stdout: "", stderr: err.message || String(err), exitCode: -1 }));
        seq++;
        await recordTranscriptEvent(buildRequestId, seq, "npx tsc --noEmit && npm test", verifyResult.stdout, verifyResult.stderr, verifyResult.exitCode);
        const verdict = verifyResult.exitCode !== 0
          ? {
              approved: false,
              findings: `Deterministic verification failed (exit ${verifyResult.exitCode}) before LLM review:\n${verifyResult.stdout.slice(-2000)}\n${verifyResult.stderr.slice(-2000)}`,
            }
          : await departments.reviewTaskDiff(task.title, task.description, taskFiles, omniRoute);
        await rewardEventsRepo.recordRewardEvent(buildRequestId, "task_review", sessionModelUsed, category, verdict.approved ? 1 : -1);
        lastFindings = verdict.findings;

        if (verdict.approved) {
          taskApproved = true;
          taskSummary =
            taskSkipped.length > 0
              ? `${finishedSummary}\n\n(Note: ${taskSkipped.length} changed path(s) could not be read back: ${taskSkipped.join(", ")})`
              : finishedSummary;
          // Nothing else in this loop ever commits — extractChangedFiles only
          // stages (`git add -A`). Without a real commit here, HEAD never
          // moves between tasks, so every later task's taskBaseSha would
          // silently equal this one's, and "task-scoped" review would
          // actually be reviewing the whole session's cumulative diff
          // against just that task's narrow title/description — the exact
          // bug the per-task scoping exists to prevent. `-c user.email/name`
          // sidesteps the sandbox image having no git identity configured;
          // `--allow-empty` and `.catch(() => {})` make this best-effort —
          // if it fails for any reason, the next task's taskBaseSha just
          // falls back to reviewing more than its own diff, same as today,
          // not worse.
          await builderClient
            .execInWorkspace(
              buildRequestId,
              `git -c user.email=jarvis@local -c user.name=Jarvis commit -q --allow-empty -m "Task ${task.seq} committed by Jarvis"`
            )
            .catch(() => {});
          await codingPlanTasksRepo.updateTaskStatus(buildRequestId, task.seq, "done", taskSummary);
        } else if (fixAttempt < MAX_TASK_FIX_ATTEMPTS) {
          await codingPlanTasksRepo.updateTaskStatus(buildRequestId, task.seq, "needs_fixes");
          messages.push({
            role: "user",
            content: `The review found issues with this task — please fix them and call finish_task again once resolved:\n\n${verdict.findings || "(the reviewer returned no specific findings — re-verify the task against its description.)"}`,
          });
        }
      }

      if (!taskApproved) {
        // hitTurnCap/hitBudgetCap alone doesn't mean no review ever ran — a
        // task can be reviewed, rejected, and then run out of turns or
        // budget while acting on those findings. lastFindings distinguishes
        // "never got reviewed" from "was reviewed, and here's why it still
        // failed."
        const failureReason = hitBudgetCap
          ? lastFindings
            ? `ran out of its ${MAX_TOKENS_PER_SESSION.toLocaleString()}-token session budget before fixing the review findings: ${lastFindings}`
            : `hit the ${MAX_TOKENS_PER_SESSION.toLocaleString()}-token session budget without calling finish_task`
          : hitTurnCap
          ? lastFindings
            ? `ran out of its ${MAX_TASK_TURNS}-turn budget before fixing the review findings: ${lastFindings}`
            : `hit its ${MAX_TASK_TURNS}-turn limit without calling finish_task`
          : `did not pass review after ${MAX_TASK_FIX_ATTEMPTS + 1} attempt(s)${lastFindings ? `: ${lastFindings}` : ""}`;
        await codingPlanTasksRepo.updateTaskStatus(buildRequestId, task.seq, "failed", failureReason);
        await builderClient.destroyWorkspace(buildRequestId).catch(() => {});
        return { ok: false, error: `Task "${task.title}" ${failureReason}.` };
      }

      completedSummaries.push(`- ${task.title}: ${taskSummary}`);
    }

    const { files, skipped } = await extractChangedFiles(buildRequestId, baseSha);
    if (files.length === 0) {
      await builderClient.destroyWorkspace(buildRequestId).catch(() => {});
      return { ok: false, error: "The coding session finished but left no changed files to propose." };
    }
    const summary =
      `${objective}\n\nCompleted tasks:\n${completedSummaries.join("\n")}` +
      (skipped.length > 0 ? `\n\n(Note: ${skipped.length} changed path(s) could not be read back: ${skipped.join(", ")})` : "");
    return { ok: true, summary, files, modelUsed: sessionModelUsed, category };
  } catch (err: any) {
    observation.logTelemetry("warn", "Executive", `Coding agent loop failed for build request #${buildRequestId}: ${err.message}`);
    await builderClient.destroyWorkspace(buildRequestId).catch(() => {});
    return { ok: false, error: `The coding session failed: ${err.message}` };
  }
}

interface ProposePlanResult {
  tasks: PlannedTaskInput[] | null;
  // Counted against the same MAX_TOKENS_PER_SESSION meter the caller's main
  // loop uses — planning is capped at 2 attempts so this is normally small,
  // but a failed plan followed by the flat-loop fallback must not spend
  // this outside the session's budget just because it happened before
  // tokensUsed existed in the caller.
  tokensUsed: number;
  // The model that actually served planning — the session's genuinely first
  // LLM call. Threaded back out so the caller can seed its own
  // sessionModelUsed with it instead of recording whatever the next call
  // happened to land on.
  modelUsed: string | null;
}

// One forced tool call asking the model to decompose the objective before
// any code gets written. Retries once with a corrective nudge on a missing
// or malformed call; returns tasks: null (triggering the flat-loop fallback
// in runCodingAgent) rather than failing the whole build request if
// planning itself can't produce a usable list.
async function proposePlan(
  buildRequestId: number,
  omniRoute: OpenAiCompatibleConfig,
  objective: string,
  researchSummary: string,
  directionNotes: string,
  modelOrder: string[]
): Promise<ProposePlanResult> {
  const messages: AgentMessage[] = [
    {
      role: "system",
      content:
        `You are Jarvis's coding agent. Before writing any code, break the following objective down into an ordered ` +
        `list of small, self-contained tasks (at most ${MAX_PLAN_TASKS}). Call propose_plan exactly once with the full list.\n\n` +
        `Objective: ${objective}\n\nResearch summary:\n${researchSummary || "(none)"}\n\nConfirmed direction:\n${directionNotes}`,
    },
    // See the identical note in the per-task loop above.
    { role: "user", content: "Begin." },
  ];

  let tokensUsed = 0;
  let modelUsed: string | null = null;

  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await callGroqAgentChat(omniRoute, messages, [PROPOSE_PLAN_TOOL], modelOrder);
      if (response.modelUsed && !modelUsed) {
        modelUsed = response.modelUsed;
      }
      if (response.totalTokens) {
        tokensUsed += response.totalTokens;
        await incrementTokenUsage(buildRequestId, response.totalTokens);
      }
      const call = response.toolCalls?.find((c) => c.function.name === "propose_plan");

      if (call) {
        try {
          const parsed = JSON.parse(call.function.arguments);
          const rawTasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
          const tasks: PlannedTaskInput[] = rawTasks
            .filter(
              (t: any) =>
                typeof t.title === "string" && t.title.trim() && typeof t.description === "string" && t.description.trim()
            )
            .map((t: any, i: number) => ({ seq: i + 1, title: t.title, description: t.description }));

          if (tasks.length > 0 && tasks.length <= MAX_PLAN_TASKS) {
            return { tasks, tokensUsed, modelUsed };
          }
        } catch {
          // Malformed arguments — fall through to the retry nudge below.
        }
      }

      messages.push({ role: "assistant", content: response.content, tool_calls: response.toolCalls || undefined });
      // Every tool_call in the assistant message above needs a matching
      // tool response, or the next request is a structurally invalid
      // conversation that an OpenAI-compatible endpoint will reject outright
      // — this is exactly the retry path meant to rescue a malformed plan,
      // so it has to itself be well-formed.
      if (response.toolCalls) {
        for (const toolCall of response.toolCalls) {
          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify({ error: "That did not produce a usable plan — see the instructions that follow." }),
          });
        }
      }
      messages.push({
        role: "user",
        content: `That didn't produce a usable plan. Call propose_plan exactly once with a "tasks" array of 1-${MAX_PLAN_TASKS} items, each with a "title" and "description".`,
      });
    }

    return { tasks: null, tokensUsed, modelUsed };
  } catch (err: any) {
    // Any Groq call failure here (rate limit, cold-start error, network
    // issue) must degrade to the flat-loop fallback, not escape and wedge
    // the build request — this is the single most likely failure point in
    // the whole session (the first Groq call), and by this point the
    // sandbox workspace already exists, so an uncaught throw here would
    // leak it and leave the build request permanently stuck in 'coding'
    // with no recovery path.
    observation.logTelemetry("warn", "Executive", `Plan phase failed: ${err.message}. Falling back to the flat coding loop.`);
    return { tasks: null, tokensUsed, modelUsed };
  }
}

// The pre-Plan-3 behavior, unchanged: one continuous conversation covering
// the whole objective in a single pass, no task decomposition, no
// per-task review. Kept as a safety net for when the planning phase itself
// can't produce a usable task list, so planning failures degrade to
// "today's known-working behavior" rather than failing the build request.
async function runFlatCodingLoop(
  buildRequestId: number,
  objective: string,
  researchSummary: string,
  directionNotes: string,
  baseSha: string,
  omniRoute: OpenAiCompatibleConfig,
  category: string,
  modelOrder: string[],
  // Whatever model served the (failed) planning phase in runCodingAgent —
  // planning always runs before this fallback, so its model, not this loop's
  // first call, is the session's genuinely first model.
  seedModelUsed: string | null,
  // Seeds this loop's own budget counter with whatever the (failed)
  // planning attempt already spent — see the call site in runCodingAgent —
  // so the two phases share one session budget instead of planning's spend
  // living outside it. Defaults to 0 for the (currently nonexistent, but
  // cheap to keep honest) case of a direct caller that skipped planning
  // entirely.
  initialTokensUsed = 0
): Promise<CodingAgentResult> {
  const categoryCaution = await buildCategoryCaution(category);

  const messages: AgentMessage[] = [
    {
      role: "system",
      content:
        `You are Jarvis's coding agent, working alone in an isolated sandboxed git worktree at the repository root. ` +
        `Objective: ${objective}\n\nResearch summary:\n${researchSummary || "(none)"}\n\nConfirmed direction:\n${directionNotes}\n\n` +
        `You have exactly one tool for doing work — run_shell_command — plus finish_coding to end the session. ` +
        `Read files with cat, edit with heredocs or sed, run tests with the project's test command, check types, use git to ` +
        `inspect and commit your work. Call finish_coding once the objective is fully implemented and verified.${categoryCaution}`,
    },
  ];

  let seq = 0;
  let tokensUsed = initialTokensUsed;
  let sessionModelUsed: string | null = seedModelUsed;

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      if (tokensUsed >= MAX_TOKENS_PER_SESSION) {
        await builderClient.destroyWorkspace(buildRequestId).catch(() => {});
        return {
          ok: false,
          error: `The coding session hit its ${MAX_TOKENS_PER_SESSION.toLocaleString()}-token session budget without calling finish_coding.`,
        };
      }

      const response = await callGroqAgentChat(omniRoute, messages, [RUN_SHELL_TOOL, FINISH_CODING_TOOL], modelOrder);
      if (response.totalTokens) {
        tokensUsed += response.totalTokens;
        await incrementTokenUsage(buildRequestId, response.totalTokens);
      }
      if (response.modelUsed && !sessionModelUsed) {
        sessionModelUsed = response.modelUsed;
      }
      // Same reasoning as the per-task loop's post-call check: without
      // this, the exact call that first crosses the cap still gets its
      // tool calls processed, including a finish_coding that would let the
      // whole session complete as if it never went over budget.
      if (tokensUsed >= MAX_TOKENS_PER_SESSION) {
        await builderClient.destroyWorkspace(buildRequestId).catch(() => {});
        return {
          ok: false,
          error: `The coding session hit its ${MAX_TOKENS_PER_SESSION.toLocaleString()}-token session budget without calling finish_coding.`,
        };
      }

      if (!response.toolCalls || response.toolCalls.length === 0) {
        messages.push({ role: "assistant", content: response.content });
        messages.push({
          role: "user",
          content: "Use run_shell_command to keep working, or finish_coding if the objective is complete.",
        });
        continue;
      }

      messages.push({ role: "assistant", content: response.content, tool_calls: response.toolCalls });

      let finishedSummary: string | null = null;

      for (const call of response.toolCalls) {
        if (call.function.name === "finish_coding") {
          let summary = "Coding session finished.";
          try {
            const parsed = JSON.parse(call.function.arguments);
            if (typeof parsed.summary === "string" && parsed.summary.trim()) summary = parsed.summary;
          } catch {
            // Malformed arguments — fall back to the default summary rather than failing the whole session.
          }
          finishedSummary = summary;
          messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ ok: true }) });
          continue;
        }

        if (call.function.name === "run_shell_command") {
          let command = "";
          try {
            const parsed = JSON.parse(call.function.arguments);
            command = typeof parsed.command === "string" ? parsed.command : "";
          } catch {
            messages.push({
              role: "tool",
              tool_call_id: call.id,
              content: JSON.stringify({ error: "Malformed arguments — command must be valid JSON with a string 'command' field." }),
            });
            continue;
          }
          if (!command) {
            messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ error: "command was empty." }) });
            continue;
          }

          const result = await builderClient
            .execInWorkspace(buildRequestId, command)
            .catch((err: any) => ({ stdout: "", stderr: err.message || String(err), exitCode: -1 }));

          seq++;
          await recordTranscriptEvent(buildRequestId, seq, command, result.stdout, result.stderr, result.exitCode);

          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: JSON.stringify({
              stdout: result.stdout.slice(0, 8000),
              stderr: result.stderr.slice(0, 4000),
              exitCode: result.exitCode,
            }),
          });
          continue;
        }

        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ error: `Unknown tool: ${call.function.name}` }) });
      }

      if (finishedSummary !== null) {
        const { files, skipped } = await extractChangedFiles(buildRequestId, baseSha);
        if (files.length === 0) {
          await builderClient.destroyWorkspace(buildRequestId).catch(() => {});
          return { ok: false, error: "The coding session finished but left no changed files to propose." };
        }
        const summary =
          skipped.length > 0
            ? `${finishedSummary}\n\n(Note: ${skipped.length} changed path(s) could not be read back and are not included in this proposal — likely deletions or unusual filenames: ${skipped.join(", ")})`
            : finishedSummary;
        return { ok: true, summary, files, modelUsed: sessionModelUsed, category };
      }
    }

    await builderClient.destroyWorkspace(buildRequestId).catch(() => {});
    return { ok: false, error: `The coding session hit its ${MAX_TURNS}-turn limit without calling finish_coding.` };
  } catch (err: any) {
    observation.logTelemetry("warn", "Executive", `Coding agent loop failed for build request #${buildRequestId}: ${err.message}`);
    await builderClient.destroyWorkspace(buildRequestId).catch(() => {});
    return { ok: false, error: `The coding session failed: ${err.message}` };
  }
}

// Reads back whatever the agent actually left on disk (committed or not) by
// diffing the working tree against the commit the sandbox started from — the
// worktree, not any model-recalled text, is the source of truth for what
// gets proposed at the approval checkpoint. Paths the diff names but `cat`
// can't read back (deletions, git's C-quoted non-ASCII filenames, binaries)
// are returned separately as `skipped` rather than silently dropped or
// thrown over: deletions are a normal part of a coding session, so failing
// the whole session over one would be worse than proposing the rest — but
// the human at the approval gate still has to be told something was left
// out. The caller passes either a task-scoped SHA (captured right before
// that task's loop starts) or the session's original baseSha for the final
// cumulative extraction — a plain commit SHA resolved from inside the
// sandbox itself, immune to any ref-mapping quirk between the sandbox's
// clone and the host repo. `git add -A` stages new files first so untracked
// additions show up in the diff, not just modifications to already-tracked
// files.
async function extractChangedFiles(
  buildRequestId: number,
  baseSha: string
): Promise<{ files: DraftedFile[]; skipped: string[] }> {
  const addResult = await builderClient.execInWorkspace(buildRequestId, "git add -A");
  if (addResult.exitCode !== 0) {
    throw new Error(`git add -A failed: ${addResult.stderr}`);
  }

  const diffResult = await builderClient.execInWorkspace(buildRequestId, `git diff --name-only ${baseSha}`);
  if (diffResult.exitCode !== 0) {
    throw new Error(`git diff failed: ${diffResult.stderr}`);
  }
  const paths = diffResult.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const files: DraftedFile[] = [];
  const skipped: string[] = [];
  for (const path of paths) {
    const catResult = await builderClient.execInWorkspace(buildRequestId, `cat "${path}"`);
    if (catResult.exitCode === 0) {
      files.push({ path, content: catResult.stdout });
    } else {
      skipped.push(path);
    }
  }
  return { files, skipped };
}
