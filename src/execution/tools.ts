import type { FunctionDeclaration, GoogleGenAI } from "@google/genai";
import { Type } from "@google/genai";
import * as memoryStore from "../cognition/memory-store.js";
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
import * as knowledgeGraph from "../cognition/knowledge-graph.js";
import * as identity from "../cognition/identity.js";
import * as news from "../integrations/news.js";
import * as webSearch from "../integrations/websearch.js";
import * as featureRequestsRepo from "../data/feature-requests-repo.js";
import * as securityRepo from "../data/security-repo.js";
import * as commandProposalsRepo from "../data/command-proposals-repo.js";
import * as objectivesRepo from "../data/objectives-repo.js";
import * as mcpServersRepo from "../data/mcp-servers-repo.js";
import * as mcpRegistry from "../execution/mcp-registry.js";

const observation = ObservationPlatform.getInstance();

export interface ToolCallResult {
  name: string;
  ok: boolean;
  output?: any;
  error?: string;
  // Set when a tool can't execute server-side and needs the connected
  // client to do something first (currently only view_screen) — see
  // Task 2 in docs/superpowers/plans/2026-07-20-view-screen-tool.md.
  needsClientAction?: "capture_screen";
  // Set by display_content — relayed to the client as a "display: " SSE
  // frame by /api/chat. See Task 1 in
  // docs/superpowers/plans/2026-07-20-display-content-panel.md.
  displayDirective?: { type: string; title: string; content: any };
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
  query_knowledge_graph: "knowledge.read",
  reflect_on_self: "identity.read",
  get_news: "news.read",
  search_web: "web.search",
  queue_feature_request: "feature.propose",
  get_security_status: "security.read",
  propose_command: "system.execute",
  view_screen: "screen.view",
  set_objective: "objectives.write",
  list_objectives: "objectives.read",
  update_objective_status: "objectives.write",
  record_command_outcome: "system.execute",
  propose_mcp_server: "system.mcp_manage",
  confirm_build_direction: "executive.plan",
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
    name: "confirm_build_direction",
    description:
      "Call this ONLY when the user has explicitly confirmed the direction for something you researched and discussed with them (not just a casual 'sounds interesting') — this locks in the direction and starts drafting real code. Never call this speculatively or before a genuine research-and-discussion exchange about a build request.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        directionNotes: { type: Type.STRING, description: "A clear summary of the direction the user confirmed — what to build, key choices discussed (stack, scope, style)" },
      },
      required: ["directionNotes"],
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
  {
    name: "reflect_on_self",
    description: "Recall genuine things you (Jarvis) have said, believed, or committed to in past conversations — real self-reflection, not fabricated introspection. Use this when the user asks what you've been thinking about, what you believe, or references something you said before.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: { type: Type.STRING, description: "Optional topic to search within past self-reflections; omit for the most recent ones" },
      },
    },
  },
  {
    name: "get_news",
    description: "Get real current news headlines, optionally on a specific topic. Use this when the user asks what's happening in the news, for a topic-specific news search, or current events.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: { type: Type.STRING, description: "Optional topic/keyword to search news for; omit for general top headlines" },
        category: { type: Type.STRING, description: "Optional category for top headlines: business, entertainment, general, health, science, sports, technology" },
      },
    },
  },
  {
    name: "search_web",
    description: "Search the live web for real, current results — use this for anything requiring up-to-date information you wouldn't already know (current events, prices, recent releases, documentation, anything time-sensitive).",
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: { type: Type.STRING, description: "The search query" },
      },
      required: ["query"],
    },
  },
  {
    name: "queue_feature_request",
    description:
      "Queue a request for a genuinely new capability to be built by a human developer — use this ONLY after the user has explicitly approved building something you don't currently have a tool for (research it with search_web first, present a concrete plan, and wait for clear approval before calling this). You never write or execute code yourself; this hands the approved request to a real, reviewed development process.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        title: { type: Type.STRING, description: "Short title for the requested capability" },
        description: { type: Type.STRING, description: "What the user actually wants this to do, in their own words/intent" },
        plan: { type: Type.STRING, description: "The concrete plan you researched and the user approved — what would need to be built, roughly how" },
      },
      required: ["title", "description", "plan"],
    },
  },
  {
    name: "get_security_status",
    description: "Get the real current network/system security status: unrecognized devices on the network, open security findings, and pending remediation proposals awaiting approval. Use this when the user asks about network security, unknown devices, or vulnerabilities.",
    parameters: {
      type: Type.OBJECT,
      properties: {},
    },
  },
  {
    name: "propose_command",
    description:
      "Propose a specific shell command to run on the user's machine. This ONLY creates a proposal for the user to review in the dashboard — it never executes anything. Only call this when you have a concrete, specific command in mind and have explained to the user what it does and why; never propose a command the user hasn't discussed or wouldn't recognize.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        command: { type: Type.STRING, description: "The exact shell command to propose" },
        reason: { type: Type.STRING, description: "Why this command, in plain terms the user can judge before approving" },
      },
      required: ["command", "reason"],
    },
  },
  {
    name: "view_screen",
    description: "Look at what's currently on the user's screen. Only call this when screen content would genuinely help answer the question (e.g. \"what am I looking at\", \"help me with this error\", \"what does this say\") — not for every message.",
    parameters: {
      type: Type.OBJECT,
      properties: {},
    },
  },
  {
    name: "display_content",
    description: "Show something in the dashboard's display panel — use this whenever a reply has something genuinely better shown than said: an image, a code/text snippet, a simple chart, or a web page. Don't call this for plain conversational replies with nothing visual to show.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        type: { type: Type.STRING, description: "One of: image, code, chart, webpage" },
        title: { type: Type.STRING, description: "Short title shown at the top of the panel" },
        content: {
          type: Type.OBJECT,
          description: "Shape depends on type. image: {url} or {base64}. code: {code, language}. chart: {labels: string[], values: number[]}. webpage: {url}.",
          properties: {
            url: { type: Type.STRING },
            base64: { type: Type.STRING },
            code: { type: Type.STRING },
            language: { type: Type.STRING },
            labels: { type: Type.ARRAY, items: { type: Type.STRING } },
            values: { type: Type.ARRAY, items: { type: Type.NUMBER } },
          },
        },
      },
      required: ["type", "title", "content"],
    },
  },
  {
    name: "set_objective",
    description: "Record a standing goal the user wants Jarvis to track and proactively follow up on over time (e.g. \"help me train for a marathon by October\", \"I want to get better at guitar\"). Only call this for something the user actually wants tracked across future conversations, not a one-off question.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        description: { type: Type.STRING, description: "A clear, short description of the goal" },
        targetDateISO: { type: Type.STRING, description: "Optional ISO 8601 date (YYYY-MM-DD) the user wants to hit, if they mentioned one" },
      },
      required: ["description"],
    },
  },
  {
    name: "list_objectives",
    description: "List the user's currently active standing objectives. Use this when the user asks what goals they're tracking, or before calling update_objective_status if you don't already know the objective's id from earlier in this conversation.",
    parameters: {
      type: Type.OBJECT,
      properties: {},
    },
  },
  {
    name: "update_objective_status",
    description: "Mark a standing objective as completed or abandoned. Call list_objectives first if you don't already know the objective's numeric id.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        objectiveId: { type: Type.NUMBER, description: "The objective's id, from list_objectives" },
        status: { type: Type.STRING, description: "Either \"completed\" or \"abandoned\"" },
      },
      required: ["objectiveId", "status"],
    },
  },
  {
    name: "record_command_outcome",
    description:
      "Record whether a previously-executed command actually fixed the user's problem. Call this when the user answers a question about whether an executed command worked (e.g. after Jarvis asked \"did that fix it?\"), using the command's numeric id from the conversation. Never call this speculatively — only when the user has actually told you whether it worked.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        commandId: { type: Type.NUMBER, description: "The command proposal's numeric id, from the notification or earlier conversation" },
        outcome: { type: Type.STRING, description: "Either \"worked\" or \"not_worked\", based on what the user said" },
      },
      required: ["commandId", "outcome"],
    },
  },
  {
    name: "propose_mcp_server",
    description:
      "Propose a new MCP (Model Context Protocol) server as a new source of capabilities. This ONLY creates a pending registration for the user to review and approve — it never connects to or trusts the server automatically. Only call this when the user has given you a specific server name and URL and clearly wants it registered.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        name: { type: Type.STRING, description: "A short, unique name for this server (used in capability names, e.g. \"github-mcp\")" },
        url: { type: Type.STRING, description: "The server's MCP endpoint URL" },
      },
      required: ["name", "url"],
    },
  },
];

// Static declarations plus whatever MCP servers are currently approved and
// reachable — called fresh each time a chat turn builds its Gemini
// function-calling request, so a newly-approved server's tools appear
// without a restart, and a disabled/unreachable one's disappear.
export function getAllToolDeclarations(): FunctionDeclaration[] {
  const mcpDeclarations: FunctionDeclaration[] = mcpRegistry.getCachedMcpTools().map(t => ({
    name: `mcp.${t.serverName}.${t.toolName}`,
    description: t.description,
    parameters: t.inputSchema as any
  }));
  return [...TOOL_DECLARATIONS, ...mcpDeclarations];
}

export async function executeTool(
  name: string,
  args: Record<string, any>,
  username: string,
  ai: GoogleGenAI | null = null,
  localEndpoint: string | null = null,
  screenContext: { alreadyAttached: boolean; supportsRoundTrip: boolean } = { alreadyAttached: false, supportsRoundTrip: false }
): Promise<ToolCallResult> {
  // display_content has no real-world side effect or access to anything
  // private beyond what the conversation already contains, so it's the one
  // tool deliberately left out of PERMISSION_BY_TOOL/ALL_CAPABILITIES rather
  // than gated behind a grant every user would need to be given anyway.
  const UNGATED_TOOLS = new Set(["display_content"]);
  const requiredGrant = PERMISSION_BY_TOOL[name];

  // Not a static tool — check whether it's a currently-cached MCP tool
  // before concluding it's genuinely unknown.
  const mcpTool = !requiredGrant && !UNGATED_TOOLS.has(name)
    ? mcpRegistry.getCachedMcpTools().find(t => `mcp.${t.serverName}.${t.toolName}` === name)
    : undefined;

  if (!requiredGrant && !UNGATED_TOOLS.has(name) && !mcpTool) {
    return { name, ok: false, error: `Unknown tool "${name}"` };
  }

  const mcpCapability = mcpTool ? `mcp.${mcpTool.serverName}.${mcpTool.toolName}` : undefined;
  const effectiveRequiredGrant = requiredGrant || mcpCapability;
  if (effectiveRequiredGrant && !hasGrant(username, effectiveRequiredGrant)) {
    observation.logAuditEvent(username, "tool_call_denied", "failed", `Missing grant "${effectiveRequiredGrant}" for tool "${name}"`);
    return { name, ok: false, error: `Missing capability grant "${effectiveRequiredGrant}"` };
  }

  if (mcpTool) {
    const result = await mcpRegistry.callMcpTool(mcpTool.serverId, mcpTool.toolName, args);
    if (!result.ok) {
      observation.logAuditEvent(username, "tool_call", "failed", `${name}(${JSON.stringify(args)}): ${result.error}`);
      return { name, ok: false, error: result.error };
    }
    observation.logAuditEvent(username, "tool_call", "success", `${name}(${JSON.stringify(args)})`);
    return { name, ok: true, output: result.content };
  }

  try {
    let output: any;
    let displayDirective: ToolCallResult["displayDirective"];
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
        output = await AutonomousExecutive.getInstance().executeObjective(args.objective, session, username);
        break;
      }
      case "confirm_build_direction": {
        const result = await AutonomousExecutive.getInstance().confirmDirection(username, args.directionNotes);
        if (!result.ok) {
          return { name, ok: false, error: result.message };
        }
        output = { message: result.message };
        break;
      }
      case "calendar_list_events":
        output = await calendar.listEvents(args.timeMinISO, args.timeMaxISO);
        break;
      case "calendar_create_event":
        output = await calendar.createEvent(args.summary, args.startISO, args.endISO, args.description);
        break;
      case "get_briefing": {
        const result = await briefing.generateBriefing(briefing.getConfiguredGroq(), username);
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
      case "query_knowledge_graph":
        output = { results: await knowledgeGraph.queryKnowledge(args.query) };
        break;
      case "reflect_on_self":
        output = { reflections: await identity.reflectOnSelf(args.query) };
        break;
      case "get_news": {
        const articles = args.query
          ? await news.searchNews(args.query)
          : await news.getTopHeadlines({ category: args.category });
        output = { articles };
        break;
      }
      case "search_web": {
        const results = await webSearch.webSearch(args.query);
        output = { results };
        // Store the actual findings, not just a truncated mention that
        // research happened — the automatic per-exchange memory capture in
        // server.ts only keeps the first 500 chars of Jarvis's final reply,
        // which loses most of what a real research result contains. Fire
        // -and-forget: memoryStore already logs its own failures, and this
        // must never block the tool response the user is waiting on.
        if (results.length > 0) {
          const summary = results
            .map((r) => `- ${r.title} (${r.url})${r.description ? `: ${r.description}` : ""}`)
            .join("\n");
          memoryStore
            .remember(username, `Research on "${args.query}":\n${summary}`, ai, localEndpoint)
            .catch(() => {});
        }
        break;
      }
      case "queue_feature_request": {
        const queued = await featureRequestsRepo.addFeatureRequest(
          args.title, args.description, null, args.plan, username
        );
        observation.logAuditEvent(username, "feature_request_queued", "success", `"${args.title}" (id ${queued.id})`);
        output = { id: queued.id, status: queued.status };
        break;
      }
      case "get_security_status": {
        const [devices, findings, proposals] = await Promise.all([
          securityRepo.getNetworkDevices(),
          securityRepo.getFindings("open"),
          securityRepo.getProposals("pending"),
        ]);
        output = {
          unrecognizedDevices: devices.filter(d => !d.is_known).map(d => ({ mac: d.mac_address, ip: d.ip_address, vendor: d.vendor })),
          openFindings: findings.map(f => ({ id: f.id, severity: f.severity, title: f.title })),
          pendingProposals: proposals.map(p => ({ id: p.id, action: p.proposed_action })),
        };
        break;
      }
      case "propose_command": {
        const proposed = await commandProposalsRepo.addCommandProposal(args.command, args.reason, username);
        observation.logAuditEvent(username, "command_proposed", "success", `"${args.command}" (id ${proposed.id})`);
        output = { id: proposed.id, status: proposed.status, message: "Proposed — awaiting your review and approval in the dashboard. Nothing runs until you approve it." };
        break;
      }
      case "record_command_outcome": {
        if (args.outcome !== "worked" && args.outcome !== "not_worked") {
          return { name, ok: false, error: "outcome must be either \"worked\" or \"not_worked\"." };
        }
        const recorded = await commandProposalsRepo.recordCommandOutcome(args.commandId, args.outcome);
        if (!recorded) {
          return { name, ok: false, error: "No matching executed command found awaiting an outcome for that id." };
        }
        output = { recorded: true };
        break;
      }
      case "view_screen": {
        if (screenContext.alreadyAttached) {
          output = "A screenshot is already attached to this message — describe what's visible in it directly, no need to look again.";
          break;
        }
        if (!screenContext.supportsRoundTrip) {
          return { name, ok: false, error: "Screen viewing isn't available in this mode yet — ask via text chat instead." };
        }
        return { name, ok: false, error: "Screen capture requested", needsClientAction: "capture_screen" };
      }
      case "set_objective":
        output = await objectivesRepo.createObjective(username, args.description, args.targetDateISO || null);
        break;
      case "list_objectives":
        output = { objectives: await objectivesRepo.listActiveObjectives(username) };
        break;
      case "update_objective_status": {
        if (args.status !== "completed" && args.status !== "abandoned") {
          return { name, ok: false, error: "status must be either \"completed\" or \"abandoned\"." };
        }
        const updated = await objectivesRepo.updateObjectiveStatus(username, args.objectiveId, args.status);
        if (!updated) {
          return { name, ok: false, error: "No matching active objective found for that id." };
        }
        output = { updated: true };
        break;
      }
      case "propose_mcp_server": {
        const proposed = await mcpServersRepo.proposeMcpServer(args.name, args.url, username);
        observation.logAuditEvent(username, "mcp_server_proposed", "success", `"${args.name}" (${args.url}, id ${proposed.id})`);
        output = { id: proposed.id, status: proposed.status, message: "Proposed — awaiting your review and approval. Nothing connects until you approve it." };
        break;
      }
      case "display_content": {
        displayDirective = { type: args.type, title: args.title, content: args.content };
        output = `Displayed ${args.type} "${args.title}" in the display panel.`;
        break;
      }
      default:
        return { name, ok: false, error: `Unhandled tool "${name}"` };
    }
    observation.logAuditEvent(username, "tool_call", "success", `${name}(${JSON.stringify(args)})`);
    return { name, ok: true, output, displayDirective };
  } catch (err: any) {
    observation.logAuditEvent(username, "tool_call", "failed", `${name}(${JSON.stringify(args)}): ${err.message}`);
    return { name, ok: false, error: err.message || String(err) };
  }
}

// Keyword triggers per tool, not a single flat list — makes it obvious which
// tool a match implies. This is a hand-maintained list, deliberately not
// derived from TOOL_DECLARATIONS: several tools (e.g. propose_command,
// display_content, update_objective_status, record_command_outcome,
// queue_feature_request) are intentionally absent because they should only
// ever be invoked as a model-driven follow-up, never routed to directly by
// keyword match. If you add a tool that SHOULD be keyword-routable, add its
// entry here too — nothing enforces the two staying in sync.
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
  query_knowledge_graph: ["what do we know about", "what do you know about", "remind me about", "what did we decide about", "what have we discussed about"],
  reflect_on_self: ["what have you been thinking", "what do you think about", "what do you believe", "have you thought about", "your opinion on", "what did you say about"],
  get_news: ["news", "headlines", "what's happening in", "current events", "latest on"],
  search_web: ["search the web", "search for", "look up", "google", "find out about", "what's the latest"],
  get_security_status: ["network security", "unknown device", "unrecognized device", "vulnerabilit", "security findings", "is my network safe"],
  view_screen: ["what's on my screen", "whats on my screen", "look at my screen", "what am i looking at", "help me with this error", "what does this say"],
  set_objective: ["help me", "i want to", "track this goal", "keep me accountable", "my goal is"],
  list_objectives: ["what am i tracking", "my goals", "my objectives", "what are my goals"],
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
