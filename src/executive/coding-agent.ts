import { ObservationPlatform } from "../kernel/observation.js";
import * as builderClient from "../kernel/builder-client.js";
import { recordTranscriptEvent } from "../kernel/state/transcript-events-repo.js";
import * as codingPlanTasksRepo from "../kernel/state/coding-plan-tasks-repo.js";
import type { PlannedTaskInput } from "../kernel/state/coding-plan-tasks-repo.js";
import { callNvidiaChat, NvidiaMessage, NvidiaTool } from "../runtime/nvidia-client.js";
import * as departments from "./departments.js";
import type { DraftedFile } from "../kernel/state/build-requests-repo.js";
import Groq from "groq-sdk";

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

const RUN_SHELL_TOOL: NvidiaTool = {
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

const FINISH_CODING_TOOL: NvidiaTool = {
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

const FINISH_TASK_TOOL: NvidiaTool = {
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

const PROPOSE_PLAN_TOOL: NvidiaTool = {
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

export type CodingAgentResult = { ok: true; summary: string; files: DraftedFile[] } | { ok: false; error: string };

export async function runCodingAgent(
  buildRequestId: number,
  objective: string,
  researchSummary: string,
  directionNotes: string,
  baseBranch: string,
  nvidiaApiKey: string | null,
  groq: Groq | null
): Promise<CodingAgentResult> {
  if (!nvidiaApiKey) {
    return { ok: false, error: "No NVIDIA_API_KEY is configured — the agentic coding loop is unavailable." };
  }

  try {
    await builderClient.createWorkspace(buildRequestId, baseBranch);
  } catch (err: any) {
    return { ok: false, error: `Failed to create the sandboxed workspace: ${err.message}` };
  }

  const baseShaResult = await builderClient.execInWorkspace(buildRequestId, "git rev-parse HEAD");
  if (baseShaResult.exitCode !== 0) {
    await builderClient.destroyWorkspace(buildRequestId).catch(() => {});
    return { ok: false, error: `Failed to resolve the workspace's starting commit: ${baseShaResult.stderr}` };
  }
  const baseSha = baseShaResult.stdout.trim();

  const plan = await proposePlan(nvidiaApiKey, objective, researchSummary, directionNotes);

  if (plan === null) {
    // Planning couldn't produce a usable task list after a retry — fall
    // back to running the whole objective through the flat loop rather
    // than failing the build request outright. Planning is meant to
    // improve reliability, not become a new single point of failure.
    return runFlatCodingLoop(buildRequestId, objective, researchSummary, directionNotes, baseSha, nvidiaApiKey);
  }

  await codingPlanTasksRepo.createPlan(buildRequestId, plan);

  let seq = 0;
  const completedSummaries: string[] = [];

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

      const messages: NvidiaMessage[] = [
        {
          role: "system",
          content:
            `You are Jarvis's coding agent, working alone in an isolated sandboxed git worktree at the repository root. ` +
            `Objective: ${objective}\n\nResearch summary:\n${researchSummary || "(none)"}\n\nConfirmed direction:\n${directionNotes}\n\n` +
            `Full plan:\n${planText}\n\nAlready completed:\n${completedText}\n\n` +
            `Your current task: ${task.title} — ${task.description}\n\n` +
            `You have exactly one tool for doing work — run_shell_command — plus finish_task to end this task once it's ` +
            `fully implemented. Read files with cat, edit with heredocs or sed, run tests with the project's test command, ` +
            `check types, use git to inspect and commit your work.`,
        },
      ];

      let taskTurns = 0;
      let taskApproved = false;
      let taskSummary = "";

      for (let fixAttempt = 0; fixAttempt <= MAX_TASK_FIX_ATTEMPTS && !taskApproved; fixAttempt++) {
        let finishedSummary: string | null = null;

        while (finishedSummary === null) {
          if (taskTurns >= MAX_TASK_TURNS) break;
          taskTurns++;

          const response = await callNvidiaChat(nvidiaApiKey, messages, [RUN_SHELL_TOOL, FINISH_TASK_TOOL]);

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
        const verdict = await departments.reviewTaskDiff(task.title, task.description, taskFiles, groq);

        if (verdict.approved) {
          taskApproved = true;
          taskSummary =
            taskSkipped.length > 0
              ? `${finishedSummary}\n\n(Note: ${taskSkipped.length} changed path(s) could not be read back: ${taskSkipped.join(", ")})`
              : finishedSummary;
          await codingPlanTasksRepo.updateTaskStatus(buildRequestId, task.seq, "done", taskSummary);
        } else if (fixAttempt < MAX_TASK_FIX_ATTEMPTS) {
          await codingPlanTasksRepo.updateTaskStatus(buildRequestId, task.seq, "needs_fixes");
          messages.push({
            role: "user",
            content: `The review found issues with this task — please fix them and call finish_task again once resolved:\n\n${verdict.findings}`,
          });
        }
      }

      if (!taskApproved) {
        await codingPlanTasksRepo.updateTaskStatus(buildRequestId, task.seq, "failed");
        await builderClient.destroyWorkspace(buildRequestId).catch(() => {});
        return { ok: false, error: `Task "${task.title}" did not pass review after ${MAX_TASK_FIX_ATTEMPTS + 1} attempt(s).` };
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
    return { ok: true, summary, files };
  } catch (err: any) {
    observation.logTelemetry("warn", "Executive", `Coding agent loop failed for build request #${buildRequestId}: ${err.message}`);
    await builderClient.destroyWorkspace(buildRequestId).catch(() => {});
    return { ok: false, error: `The coding session failed: ${err.message}` };
  }
}

// One forced tool call asking the model to decompose the objective before
// any code gets written. Retries once with a corrective nudge on a missing
// or malformed call; returns null (triggering the flat-loop fallback in
// runCodingAgent) rather than failing the whole build request if planning
// itself can't produce a usable list.
async function proposePlan(
  nvidiaApiKey: string,
  objective: string,
  researchSummary: string,
  directionNotes: string
): Promise<PlannedTaskInput[] | null> {
  const messages: NvidiaMessage[] = [
    {
      role: "system",
      content:
        `You are Jarvis's coding agent. Before writing any code, break the following objective down into an ordered ` +
        `list of small, self-contained tasks (at most ${MAX_PLAN_TASKS}). Call propose_plan exactly once with the full list.\n\n` +
        `Objective: ${objective}\n\nResearch summary:\n${researchSummary || "(none)"}\n\nConfirmed direction:\n${directionNotes}`,
    },
  ];

  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await callNvidiaChat(nvidiaApiKey, messages, [PROPOSE_PLAN_TOOL]);
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
          return tasks;
        }
      } catch {
        // Malformed arguments — fall through to the retry nudge below.
      }
    }

    messages.push({ role: "assistant", content: response.content, tool_calls: response.toolCalls || undefined });
    messages.push({
      role: "user",
      content: `That didn't produce a usable plan. Call propose_plan exactly once with a "tasks" array of 1-${MAX_PLAN_TASKS} items, each with a "title" and "description".`,
    });
  }

  return null;
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
  nvidiaApiKey: string
): Promise<CodingAgentResult> {
  const messages: NvidiaMessage[] = [
    {
      role: "system",
      content:
        `You are Jarvis's coding agent, working alone in an isolated sandboxed git worktree at the repository root. ` +
        `Objective: ${objective}\n\nResearch summary:\n${researchSummary || "(none)"}\n\nConfirmed direction:\n${directionNotes}\n\n` +
        `You have exactly one tool for doing work — run_shell_command — plus finish_coding to end the session. ` +
        `Read files with cat, edit with heredocs or sed, run tests with the project's test command, check types, use git to ` +
        `inspect and commit your work. Call finish_coding once the objective is fully implemented and verified.`,
    },
  ];

  let seq = 0;

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const response = await callNvidiaChat(nvidiaApiKey, messages, [RUN_SHELL_TOOL, FINISH_CODING_TOOL]);

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
        return { ok: true, summary, files };
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
