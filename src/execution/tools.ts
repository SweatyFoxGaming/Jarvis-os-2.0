import type { FunctionDeclaration } from "@google/genai";
import { Type } from "@google/genai";
import * as github from "../integrations/github.js";
import * as emailIntegration from "../integrations/email.js";
import * as tts from "../integrations/tts.js";
import { hasGrant } from "./permissions.js";
import { ObservationPlatform } from "../observation/index.js";

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
