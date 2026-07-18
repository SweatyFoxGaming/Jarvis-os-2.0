import type { FunctionDeclaration } from "@google/genai";
import { Type } from "@google/genai";
import * as github from "../integrations/github.js";
import * as emailIntegration from "../integrations/email.js";
import * as tts from "../integrations/tts.js";
import { hasGrant } from "./permissions.js";
import { ObservationPlatform } from "../observation/index.js";
import { AutonomousExecutive } from "./autonomous_executive.js";
import { getSession } from "../cognition/session.js";
import * as calendar from "../integrations/calendar.js";
import * as briefing from "./briefing.js";
import * as files from "../integrations/files.js";

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
  calendar_list_events: "calendar.read",
  calendar_create_event: "calendar.write",
  get_briefing: "briefing.read",
  list_files: "files.read",
  read_file: "files.read",
  write_file: "files.write",
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
    name: "calendar_list_events",
    description: "List upcoming events on the user's Google Calendar within an optional time range.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        timeMinISO: { type: Type.STRING, description: "Optional ISO 8601 start of range; defaults to now" },
        timeMaxISO: { type: Type.STRING, description: "Optional ISO 8601 end of range" },
      },
    },
  },
  {
    name: "calendar_create_event",
    description: "Create a new event on the user's Google Calendar.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        summary: { type: Type.STRING, description: "Event title" },
        startISO: { type: Type.STRING, description: "ISO 8601 start datetime" },
        endISO: { type: Type.STRING, description: "ISO 8601 end datetime" },
        description: { type: Type.STRING, description: "Optional event description" },
      },
      required: ["summary", "startISO", "endISO"],
    },
  },
  {
    name: "get_briefing",
    description: "Get a real, up-to-date briefing synthesized from connected sources (unread email, GitHub notifications) right now. Use this when the user asks what's new, what needs their attention, or for a status update.",
    parameters: {
      type: Type.OBJECT,
      properties: {},
    },
  },
  {
    name: "list_files",
    description: "List files and folders in the user's dedicated Jarvis notes folder (or a subfolder within it).",
    parameters: {
      type: Type.OBJECT,
      properties: {
        path: { type: Type.STRING, description: "Relative subfolder path, or omit for the top-level folder" },
      },
    },
  },
  {
    name: "read_file",
    description: "Read the contents of a text file in the user's dedicated Jarvis notes folder.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        path: { type: Type.STRING, description: "Relative path to the file within the notes folder" },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write (create or overwrite) a text file in the user's dedicated Jarvis notes folder.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        path: { type: Type.STRING, description: "Relative path to the file within the notes folder" },
        content: { type: Type.STRING, description: "The full text content to write" },
      },
      required: ["path", "content"],
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
      case "calendar_list_events":
        output = await calendar.listEvents(args.timeMinISO, args.timeMaxISO);
        break;
      case "calendar_create_event":
        output = await calendar.createEvent(args.summary, args.startISO, args.endISO, args.description);
        break;
      case "get_briefing": {
        const result = await briefing.generateBriefing(briefing.getConfiguredAi());
        output = { text: result.text, itemCount: result.itemCount };
        break;
      }
      case "list_files":
        output = await files.listFiles(args.path);
        break;
      case "read_file":
        output = { content: await files.readFile(args.path) };
        break;
      case "write_file":
        output = await files.writeFile(args.path, args.content);
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
  calendar_list_events: ["calendar", "schedule", "my agenda", "upcoming events", "what's on my"],
  calendar_create_event: ["calendar", "schedule a", "book a", "add an event", "set up a meeting"],
  get_briefing: ["briefing", "what's new", "whats new", "what do i need to know", "catch me up", "status update", "anything i need to know"],
  list_files: ["my notes", "my files", "list files", "what files"],
  read_file: ["read my", "open my note", "read the file", "read that note"],
  write_file: ["save this", "write this down", "save a note", "create a note", "write a note", "jot this down"],
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
