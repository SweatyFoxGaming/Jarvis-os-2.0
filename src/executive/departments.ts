import { Type } from "@google/genai";
import { toGroqSchema } from "../runtime/groq-client.js";
import type { CognitionRouter } from "../runtime/cognition-router.js";
import { ObservationPlatform } from "../kernel/observation.js";
import * as github from "../capabilities/providers/github.js";
import * as webSearch from "../capabilities/providers/websearch.js";
import * as wikipedia from "../capabilities/providers/wikipedia.js";
import * as knowledgeGraph from "../cognition/knowledge-graph.js";
import type { DraftedFile } from "../kernel/state/build-requests-repo.js";

const observation = ObservationPlatform.getInstance();

/**
 * The three real "specialist swarm" routines dispatched from
 * autonomous_executive.ts. Kept in their own module so that file stays the
 * orchestrator, not a growing monolith holding both coordination logic and
 * the actual department work. See docs/superpowers/specs/
 * 2026-07-21-agent-departments-design.md for the full design.
 */

export interface DepartmentStep {
  step: string;
  department: "research" | "coding" | "qa";
}

const DEPARTMENT_DECOMPOSITION_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    steps: {
      type: Type.ARRAY,
      description: "1 to 5 concrete steps needed to accomplish the objective, each tagged with the department that owns it.",
      items: {
        type: Type.OBJECT,
        properties: {
          step: { type: Type.STRING, description: "A concrete, specific description of this step" },
          department: {
            type: Type.STRING,
            description:
              "One of: research, coding, qa. Use 'coding' ONLY if the objective genuinely requires writing/changing " +
              "code in this repository. Use 'qa' ONLY as a step that reviews code from a 'coding' step in the same " +
              "list — never include 'qa' without a 'coding' step also present. Use 'research' for anything else " +
              "(planning, gathering information, answering a question).",
          },
        },
        required: ["step", "department"],
      },
    },
  },
  required: ["steps"],
};

// No AI client, or offline mode: there's no safe heuristic fallback for
// detecting a real coding intent from free text the way there was for the
// old fixed 4-step decomposition — defaulting to a single research-tagged
// step is the conservative, honest choice (never triggers a coding proposal
// without a real model actually reasoning about it).
export async function decomposeObjective(
  objective: string,
  router: CognitionRouter | null,
  offlineMode: boolean,
  username: string
): Promise<DepartmentStep[]> {
  if (!router || offlineMode) {
    return [{ step: objective, department: "research" }];
  }

  try {
    const response = await router.generateWithFallback(
      username,
      {
        messages: [{
          role: "user",
          content: `Break this objective down into 1-5 concrete steps, each tagged with the department that owns it: "${objective}"`,
        }],
        response_format: {
          type: "json_schema",
          json_schema: { name: "department_decomposition", schema: toGroqSchema(DEPARTMENT_DECOMPOSITION_SCHEMA), strict: true },
        },
      },
      ["groq:openai/gpt-oss-20b"]
    );

    const parsed = JSON.parse(response.choices[0]?.message?.content || "{}");
    const rawSteps = Array.isArray(parsed.steps) ? parsed.steps : [];
    const valid: DepartmentStep[] = rawSteps.filter(
      (s: any) =>
        typeof s.step === "string" &&
        s.step.trim().length > 0 &&
        ["research", "coding", "qa"].includes(s.department)
    );

    if (valid.length === 0) {
      return [{ step: objective, department: "research" }];
    }

    // A "qa" step with no accompanying "coding" step has nothing to
    // review — fall back to research for it rather than dispatching a
    // no-op QA pass.
    const hasCoding = valid.some((s) => s.department === "coding");
    return hasCoding
      ? valid
      : valid.map((s) => (s.department === "qa" ? { ...s, department: "research" as const } : s));
  } catch (err: any) {
    observation.logTelemetry("warn", "Departments", `decomposeObjective failed: ${err.message}. Falling back to a single research step.`);
    return [{ step: objective, department: "research" }];
  }
}

export interface ResearchResult {
  summary: string;
}

const RESEARCH_LOOKUPS_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    webQueries: {
      type: Type.ARRAY,
      description: "0-3 specific web search queries that would genuinely help research this objective. Empty array if web search wouldn't help.",
      items: { type: Type.STRING },
    },
    checkThisRepo: {
      type: Type.BOOLEAN,
      description: "True only if understanding this repository's current purpose/structure would genuinely help (e.g. the objective is about building or changing something in this codebase).",
    },
    knowledgeQuery: {
      type: Type.STRING,
      description: "A specific name/topic to check Jarvis's own stored knowledge for, or \"\" if not applicable.",
    },
    wikipediaQuery: {
      type: Type.STRING,
      description: "A specific topic/subject name to look up on Wikipedia for background/encyclopedic context, or \"\" if not applicable.",
    },
  },
  required: ["webQueries", "checkThisRepo", "knowledgeQuery", "wikipediaQuery"],
};

// Real research in two Gemini calls: the first plans WHAT to look up
// (specific search queries, whether this repo's context matters, a
// knowledge-graph topic) rather than guessing search terms directly from
// the raw objective; the second synthesizes whatever was actually gathered.
// Each individual lookup degrades independently — one failing read (a
// missing BRAVE_API_KEY, a GitHub hiccup) doesn't abort the whole pass.
export async function runResearch(objective: string, router: CognitionRouter | null, username: string): Promise<ResearchResult> {
  if (!router) {
    return {
      summary:
        "No capable model is available right now, so I couldn't do real research on this — " +
        "I'd need the cognition router reachable to plan and synthesize findings.",
    };
  }

  let webQueries: string[] = [];
  let checkThisRepo = false;
  let knowledgeQuery = "";
  let wikipediaQuery = "";
  try {
    const lookupResponse = await router.generateWithFallback(
      username,
      {
        messages: [{ role: "user", content: `Plan what to research for this objective: "${objective}"` }],
        response_format: {
          type: "json_schema",
          json_schema: { name: "research_lookups", schema: toGroqSchema(RESEARCH_LOOKUPS_SCHEMA), strict: true },
        },
      },
      ["groq:openai/gpt-oss-20b"]
    );
    const parsed = JSON.parse(lookupResponse.choices[0]?.message?.content || "{}");
    webQueries = Array.isArray(parsed.webQueries)
      ? parsed.webQueries.filter((q: any) => typeof q === "string" && q.trim()).slice(0, 3)
      : [];
    checkThisRepo = parsed.checkThisRepo === true;
    knowledgeQuery = typeof parsed.knowledgeQuery === "string" ? parsed.knowledgeQuery.trim() : "";
    wikipediaQuery = typeof parsed.wikipediaQuery === "string" ? parsed.wikipediaQuery.trim() : "";
  } catch (err: any) {
    observation.logTelemetry("warn", "Departments", `Research lookup planning failed: ${err.message}. Falling back to a single direct web search.`);
    webQueries = [objective];
  }

  const findings: string[] = [];

  for (const query of webQueries) {
    try {
      const results = await webSearch.webSearch(query);
      if (results.length > 0) {
        findings.push(
          `Web search "${query}":\n` +
            results.map((r) => `- ${r.title} (${r.url})${r.description ? `: ${r.description}` : ""}`).join("\n")
        );
      }
    } catch (err: any) {
      findings.push(`Web search "${query}" failed: ${err.message}`);
    }
  }

  if (checkThisRepo) {
    const owner = process.env.SELF_REPO_OWNER;
    const repoName = process.env.SELF_REPO_NAME;
    if (owner && repoName) {
      try {
        const repo = await github.getRepo(owner, repoName);
        findings.push(`This repository: ${repo.full_name} — ${repo.description || "(no description)"}. Default branch: ${repo.default_branch}.`);
      } catch (err: any) {
        findings.push(`Could not read this repository's metadata: ${err.message}`);
      }
      try {
        const readme: any = await github.getFileContent(owner, repoName, "README.md");
        if (readme?.decodedContent) {
          findings.push(`README excerpt:\n${readme.decodedContent.slice(0, 1500)}`);
        }
      } catch {
        // README missing or unreadable on this branch — not fatal, just skip it.
      }
    }
  }

  if (knowledgeQuery) {
    try {
      const known = await knowledgeGraph.queryKnowledge(username, knowledgeQuery);
      if (known.length > 0) {
        findings.push(
          `Already known about "${knowledgeQuery}": ` +
            known.map((k) => `${k.entityName} — ${k.facts.join("; ")}`).join(" | ")
        );
      }
    } catch (err: any) {
      findings.push(`Knowledge graph lookup for "${knowledgeQuery}" failed: ${err.message}`);
    }
  }

  if (wikipediaQuery) {
    try {
      const results = await wikipedia.wikipediaSearch(wikipediaQuery);
      if (results.length > 0) {
        findings.push(
          `Wikipedia "${wikipediaQuery}":\n` +
            results.map((r) => `- ${r.title} (${r.url})${r.description ? `: ${r.description}` : ""}`).join("\n")
        );
      }
    } catch (err: any) {
      findings.push(`Wikipedia lookup for "${wikipediaQuery}" failed: ${err.message}`);
    }
  }

  if (findings.length === 0) {
    return {
      summary:
        "I wasn't able to find anything concrete — no search results, no relevant repo context, " +
        "and nothing already known. Let's discuss what you have in mind directly.",
    };
  }

  try {
    const synthesis = await router.generateWithFallback(
      username,
      {
        messages: [{
          role: "user",
          content: `Synthesize these raw research findings into a clear, concise report for the objective "${objective}". Findings:\n\n${findings.join("\n\n")}`,
        }],
      },
      ["groq:llama-3.3-70b-versatile"]
    );
    return { summary: synthesis.choices[0]?.message?.content || findings.join("\n\n") };
  } catch (err: any) {
    observation.logTelemetry("warn", "Departments", `Research synthesis failed: ${err.message}. Returning raw findings.`);
    return { summary: findings.join("\n\n") };
  }
}

export async function reviewCodeDiff(objective: string, files: DraftedFile[], router: CognitionRouter | null, username: string): Promise<string> {
  if (!router) {
    return "No capable model was available to review this change — please review the diff yourself before merging.";
  }
  try {
    const filesText = files.map((f) => `--- ${f.path} ---\n${f.content}`).join("\n\n");
    const response = await router.generateWithFallback(
      username,
      {
        messages: [{
          role: "user",
          content:
            "Review this drafted code change against the objective it's meant to accomplish. Flag anything concerning — " +
            "bugs, missing error handling, security issues, or ways it doesn't actually satisfy the objective. Be concise.\n\n" +
            `Objective: ${objective}\n\nFiles:\n${filesText}`,
        }],
      },
      ["groq:llama-3.3-70b-versatile"]
    );
    return response.choices[0]?.message?.content || "Review completed with no specific feedback.";
  } catch (err: any) {
    observation.logTelemetry("warn", "Departments", `reviewCodeDiff failed: ${err.message}`);
    return `Automated review failed (${err.message}) — please review the diff yourself before merging.`;
  }
}

const TASK_REVIEW_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    approved: { type: Type.BOOLEAN },
    findings: { type: Type.STRING },
  },
  required: ["approved", "findings"],
};

// A task-scoped gate, not a merge review — judges one task's diff against
// that task's own title/description, not the whole build request's
// objective. Returns a structured verdict (not prose, unlike reviewCodeDiff)
// because this drives a programmatic retry/continue decision inside
// coding-agent.ts's fix loop. Fails CLOSED (approved: false) both when no
// CognitionRouter is available and when the review call itself throws —
// this used to fail open, which meant an outage silently rubber-stamped
// every task with no code ever actually reviewed, identical in the approval
// queue to a normally-reviewed one. Failing closed doesn't loop forever: a
// blocked task still only gets MAX_TASK_FIX_ATTEMPTS retries in
// coding-agent.ts before the whole build request fails cleanly with this
// message as the reason, surfaced to the human — a clear "review
// unavailable" failure, not a silent bypass.
export async function reviewTaskDiff(
  taskTitle: string,
  taskDescription: string,
  files: DraftedFile[],
  router: CognitionRouter | null,
  username: string
): Promise<{ approved: boolean; findings: string }> {
  if (!router) {
    return { approved: false, findings: "No capable model was available to review this task — holding rather than shipping it unreviewed. Configure GROQ_API_KEYS or GEMINI_API_KEYS to enable the coding agent's review gate." };
  }
  try {
    const filesText = files.map((f) => `--- ${f.path} ---\n${f.content}`).join("\n\n");
    const response = await router.generateWithFallback(
      username,
      {
        messages: [{
          role: "user",
          content:
            "Review this task's drafted code change against what the task was supposed to accomplish. Approve only if it " +
            "genuinely satisfies the task with no real bugs, missing error handling, or security issues. Be concise in findings.\n\n" +
            `Task: ${taskTitle} — ${taskDescription}\n\nFiles:\n${filesText}`,
        }],
        response_format: {
          type: "json_schema",
          json_schema: { name: "task_review", schema: toGroqSchema(TASK_REVIEW_SCHEMA), strict: true },
        },
      },
      // llama-3.3-70b-versatile (used elsewhere in this file for plain-text
      // reviews with no response_format) doesn't support Groq's structured-
      // output mode — live-verified: a real task review against it failed
      // outright with "This model does not support response format
      // json_schema." The larger openai/gpt-oss-120b sibling does support
      // it, but its free-tier rate limit is extremely tight (8,000
      // tokens/minute — a real coding-agent session hit that ceiling after
      // only ~34,000 total tokens) — live-verified against this same
      // account. openai/gpt-oss-20b already proves reliable for structured
      // output elsewhere in this file (decomposeObjective, the
      // research-lookups call) with no rate-limit issues throughout this
      // session's live testing, so this call uses it too.
      ["groq:openai/gpt-oss-20b"]
    );
    const parsed = JSON.parse(response.choices[0]?.message?.content || "{}");
    return {
      approved: parsed.approved === true,
      findings: typeof parsed.findings === "string" ? parsed.findings : "",
    };
  } catch (err: any) {
    observation.logTelemetry("warn", "Departments", `reviewTaskDiff failed: ${err.message}`);
    return { approved: false, findings: `Automated review failed (${err.message}) — holding rather than shipping it unreviewed.` };
  }
}
