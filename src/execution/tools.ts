import type { FunctionDeclaration } from "@google/genai";
import { Type } from "@google/genai";
import * as github from "../integrations/github.js";
import * as emailIntegration from "../integrations/email.js";
import * as tts from "../integrations/tts.js";
import { hasGrant } from "./permissions.js";
import { ObservationPlatform } from "../observation/index.js";
import { AutonomousExecutive } from "./autonomous_executive.js";
import { getSession } from "../cognition/session.js";
import * as knowledgeGraph from "../cognition/knowledge-graph.js";

const observation = ObservationPlatform.getInstance();

export interface ToolCallResult {
  name: string;
  ok: boolean;
  output?: any;
  error?: string;
}

const PERMISSION_BY_TOOL: Record<string, string> = {
  github_get_repo_or_file: "github.read",
  github_create_issue: "github.issues.create",
  send_email: "email.send",
  speak_text: "tts.speak",
  decompose_plan: "executive.plan",
  query_knowledge_graph: "knowledge.read",
};

export const TOOL_DECLARATIONS: FunctionDeclaration[] = [
  {
    name: "github_get_repo_or_file",
    description: "Get metadata about a GitHub repository, or the contents of a specific file/directory within it.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        owner: { type: Type.STRING, description: "Repository owner or organization" },
        repo: { type: Type.STRING, description: "Repository name" },
        path: { type: Type.STRING, description: "Optional file or directory path within the repo" },
      },
      required: ["owner", "repo"],
    },
  },
  {
    name: "github_create_issue",
    description: "Create a new issue on a GitHub repository.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        owner: { type: Type.STRING },
        repo: { type: Type.STRING },
        title: { type: Type.STRING },
        body: { type: Type.STRING, description: "Optional issue body/description" },
      },
      required: ["owner", "repo", "title"],
    },
  },
  {
    name: "send_email",
    description: "Send an email via the configured SMTP account.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        to: { type: Type.STRING },
        subject: { type: Type.STRING },
        text: { type: Type.STRING },
      },
      required: ["to", "subject", "text"],
    },
  },
  {
    name: "speak_text",
    description: "Synthesize the given text as speech through the text-to-speech service.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        text: { type: Type.STRING },
      },
      required: ["text"],
    },
  },
  {
    name: "decompose_plan",
    description:
      "Break a complex, multi-step objective down into a sequence of concrete plan steps. Use this when the user asks to plan, break down, or map out how to accomplish something non-trivial. This produces a plan only — it does not write code, execute commands, or perform any of the plan's steps itself.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        objective: { type: Type.STRING, description: "The high-level objective to decompose into steps" },
      },
      required: ["objective"],
    },
  },
  {
    name: "query_knowledge_graph",
    description: "Reliably look up what's actually been recorded about a specific named person, project, tool, or decision from past conversations — a precise lookup by name, not a fuzzy search. Use this when the user asks 'what do we know about X' or references something discussed before by name.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: { type: Type.STRING, description: "The name (or partial name) of the entity to look up" },
      },
      required: ["query"],
    },
  },
];

export async function executeTool(name: string, args: Record<string, any>, username: string): Promise<ToolCallResult> {
  const requiredGrant = PERMISSION_BY_TOOL[name];
  if (!requiredGrant) {
    return { name, ok: false, error: `Unknown tool "${name}"` };
  }
  if (!hasGrant(username, requiredGrant)) {
    observation.logAuditEvent(username, "tool_call_denied", "failed", `Missing grant "${requiredGrant}" for tool "${name}"`);
    return { name, ok: false, error: `Missing capability grant "${requiredGrant}"` };
  }

  try {
    let output: any;
    switch (name) {
      case "github_get_repo_or_file":
        output = args.path
          ? await github.getFileContent(args.owner, args.repo, args.path)
          : await github.getRepo(args.owner, args.repo);
        break;
      case "github_create_issue": {
        const issue = await github.createIssue(args.owner, args.repo, args.title, args.body);
        output = { number: issue.number, url: issue.html_url };
        break;
      }
      case "send_email":
        output = await emailIntegration.sendEmail(args.to, args.subject, args.text);
        break;
      case "speak_text": {
        const { audio } = await tts.synthesizeSpeech(args.text);
        output = { synthesized: true, bytes: audio.length };
        break;
      }
      case "decompose_plan": {
        const session = await getSession(username);
        output = await AutonomousExecutive.getInstance().executeObjective(args.objective, session);
        break;
      }
      case "query_knowledge_graph":
        output = { results: await knowledgeGraph.queryKnowledge(args.query) };
        break;
      default:
        return { name, ok: false, error: `Unhandled tool "${name}"` };
    }
    observation.logAuditEvent(username, "tool_call", "success", `${name}(${JSON.stringify(args)})`);
    return { name, ok: true, output };
  } catch (err: any) {
    observation.logAuditEvent(username, "tool_call", "failed", `${name}(${JSON.stringify(args)}): ${err.message}`);
    return { name, ok: false, error: err.message || String(err) };
  }
}

// Keyword triggers per tool, not a single flat list — makes it obvious which
// tool a match implies and keeps this in sync with TOOL_DECLARATIONS by
// construction rather than a second hand-maintained list drifting from it.
const TOOL_TRIGGER_WORDS: Record<string, string[]> = {
  github_get_repo_or_file: ["github", "repo", "repository", "pull request", "pr ", "branch"],
  github_create_issue: ["github", "issue", "repo", "repository"],
  send_email: ["email", "e-mail", "send mail", "inbox"],
  speak_text: ["speak", "say it out loud", "read that aloud", "text-to-speech", "text to speech"],
  decompose_plan: ["break this down", "break down", "decompose", "make a plan", "create a plan", "step-by-step plan", "step by step plan", "plan out"],
  query_knowledge_graph: ["what do we know about", "what do you know about", "remind me about", "what did we decide about", "what have we discussed about"],
};

/**
 * Heuristic only — used to decide *routing* (prefer a backend that can
 * actually fulfill the request), never to decide whether to execute a tool.
 * Real execution always goes through Gemini's own function-calling decision
 * plus the permission grant in executeTool(); this just avoids sending an
 * obviously tool-shaped request to a backend (the local model) that's known
 * to fabricate an answer instead of admitting it has no tool access.
 */
export function looksToolShaped(message: string): boolean {
  const lower = message.toLowerCase();
  return Object.values(TOOL_TRIGGER_WORDS).some(words => words.some(w => lower.includes(w)));
}
