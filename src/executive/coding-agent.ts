import { ObservationPlatform } from "../kernel/observation.js";
import * as builderClient from "../kernel/builder-client.js";
import { recordTranscriptEvent } from "../kernel/state/transcript-events-repo.js";
import { callNvidiaChat, NvidiaMessage, NvidiaTool } from "../runtime/nvidia-client.js";
import type { DraftedFile } from "../kernel/state/build-requests-repo.js";

const observation = ObservationPlatform.getInstance();

// Defense-in-depth alongside jarvis-builder's own 1-hour reaper (Plan 1) —
// bounds a model that never calls finish_coding, surfaced as an honest
// error rather than silently truncated (design spec, "The agentic loop").
const MAX_TURNS = 40;

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

export type CodingAgentResult = { ok: true; summary: string; files: DraftedFile[] } | { ok: false; error: string };

export async function runCodingAgent(
  buildRequestId: number,
  objective: string,
  researchSummary: string,
  directionNotes: string,
  baseBranch: string,
  nvidiaApiKey: string | null
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
        // A bare text reply with no tool call means the model is confused,
        // not finished — nudge it back rather than silently ending the loop.
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

        // Unknown tool name — only two tools are offered, but a model can hallucinate a call.
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ error: `Unknown tool: ${call.function.name}` }) });
      }

      if (finishedSummary !== null) {
        const files = await extractChangedFiles(buildRequestId, baseSha);
        if (files.length === 0) {
          await builderClient.destroyWorkspace(buildRequestId).catch(() => {});
          return { ok: false, error: "The coding session finished but left no changed files to propose." };
        }
        return { ok: true, summary: finishedSummary, files };
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
// gets proposed at the approval checkpoint. `baseSha` (captured via `git
// rev-parse HEAD` right after workspace creation) is used instead of a branch
// ref because it's a plain commit SHA resolved from inside the sandbox
// itself — it doesn't depend on a ref name meaning the same thing in two
// different repos, so it's immune to the clone's remote-tracking-ref quirk
// entirely. `git add -A` stages new files first so untracked additions show
// up in the diff, not just modifications to already-tracked files.
async function extractChangedFiles(buildRequestId: number, baseSha: string): Promise<DraftedFile[]> {
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
  for (const path of paths) {
    const catResult = await builderClient.execInWorkspace(buildRequestId, `cat "${path}"`);
    if (catResult.exitCode === 0) {
      files.push({ path, content: catResult.stdout });
    }
  }
  return files;
}
