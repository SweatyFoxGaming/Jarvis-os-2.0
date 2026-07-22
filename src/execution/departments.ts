import { Type } from "@google/genai";
import Groq from "groq-sdk";
import { toGroqSchema } from "../cognition/groq-client.js";
import { ObservationPlatform } from "../observation/index.js";
import * as github from "../integrations/github.js";
import * as webSearch from "../integrations/websearch.js";
import * as knowledgeGraph from "../cognition/knowledge-graph.js";
import type { DraftedFile } from "../data/build-requests-repo.js";

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
  groq: Groq | null,
  offlineMode: boolean
): Promise<DepartmentStep[]> {
  if (!groq || offlineMode) {
    return [{ step: objective, department: "research" }];
  }

  try {
    const response = await groq.chat.completions.create({
      model: "openai/gpt-oss-20b",
      messages: [{
        role: "user",
        content: `Break this objective down into 1-5 concrete steps, each tagged with the department that owns it: "${objective}"`,
      }],
      response_format: {
        type: "json_schema",
        json_schema: { name: "department_decomposition", schema: toGroqSchema(DEPARTMENT_DECOMPOSITION_SCHEMA), strict: true },
      },
    });

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
  },
  required: ["webQueries", "checkThisRepo", "knowledgeQuery"],
};

// Real research in two Gemini calls: the first plans WHAT to look up
// (specific search queries, whether this repo's context matters, a
// knowledge-graph topic) rather than guessing search terms directly from
// the raw objective; the second synthesizes whatever was actually gathered.
// Each individual lookup degrades independently — one failing read (a
// missing BRAVE_API_KEY, a GitHub hiccup) doesn't abort the whole pass.
export async function runResearch(objective: string, groq: Groq | null): Promise<ResearchResult> {
  if (!groq) {
    return {
      summary:
        "No capable model is available right now, so I couldn't do real research on this — " +
        "I'd need Gemini reachable to plan and synthesize findings.",
    };
  }

  let webQueries: string[] = [];
  let checkThisRepo = false;
  let knowledgeQuery = "";
  try {
    const lookupResponse = await groq.chat.completions.create({
      model: "openai/gpt-oss-20b",
      messages: [{ role: "user", content: `Plan what to research for this objective: "${objective}"` }],
      response_format: {
        type: "json_schema",
        json_schema: { name: "research_lookups", schema: toGroqSchema(RESEARCH_LOOKUPS_SCHEMA), strict: true },
      },
    });
    const parsed = JSON.parse(lookupResponse.choices[0]?.message?.content || "{}");
    webQueries = Array.isArray(parsed.webQueries)
      ? parsed.webQueries.filter((q: any) => typeof q === "string" && q.trim()).slice(0, 3)
      : [];
    checkThisRepo = parsed.checkThisRepo === true;
    knowledgeQuery = typeof parsed.knowledgeQuery === "string" ? parsed.knowledgeQuery.trim() : "";
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
      const known = await knowledgeGraph.queryKnowledge(knowledgeQuery);
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

  if (findings.length === 0) {
    return {
      summary:
        "I wasn't able to find anything concrete — no search results, no relevant repo context, " +
        "and nothing already known. Let's discuss what you have in mind directly.",
    };
  }

  try {
    const synthesis = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{
        role: "user",
        content: `Synthesize these raw research findings into a clear, concise report for the objective "${objective}". Findings:\n\n${findings.join("\n\n")}`,
      }],
    });
    return { summary: synthesis.choices[0]?.message?.content || findings.join("\n\n") };
  } catch (err: any) {
    observation.logTelemetry("warn", "Departments", `Research synthesis failed: ${err.message}. Returning raw findings.`);
    return { summary: findings.join("\n\n") };
  }
}

export type CodeDraftResult = { ok: true; summary: string; files: DraftedFile[] } | { ok: false; error: string };

const CODE_DRAFT_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    summary: { type: Type.STRING, description: "A short, plain-language summary of what this code change does, suitable for a PR description." },
    files: {
      type: Type.ARRAY,
      description: "The complete files to create or overwrite. At least one file is required.",
      items: {
        type: Type.OBJECT,
        properties: {
          path: { type: Type.STRING, description: "Relative path from the repository root, e.g. \"src/foo/bar.ts\"" },
          content: { type: Type.STRING, description: "The complete file content" },
        },
        required: ["path", "content"],
      },
    },
  },
  required: ["summary", "files"],
};

export async function draftCodeChanges(
  objective: string,
  researchSummary: string,
  directionNotes: string,
  groq: Groq | null
): Promise<CodeDraftResult> {
  if (!groq) {
    return { ok: false, error: "No capable model is available right now to draft real code — Groq must be reachable for this." };
  }
  try {
    const response = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{
        role: "user",
        content:
          "Draft real, complete file changes for this repository to accomplish the objective below. Only include files " +
          "that genuinely need to be created or changed. Write complete, working file contents, not snippets or " +
          "placeholders.\n\n" +
          `Objective: ${objective}\n\nResearch findings:\n${researchSummary}\n\nConfirmed direction from the user:\n${directionNotes}`,
      }],
      response_format: {
        type: "json_schema",
        json_schema: { name: "code_draft", schema: toGroqSchema(CODE_DRAFT_SCHEMA), strict: true },
      },
    });
    const parsed = JSON.parse(response.choices[0]?.message?.content || "{}");
    const files: DraftedFile[] = Array.isArray(parsed.files)
      ? parsed.files.filter((f: any) => typeof f.path === "string" && f.path.trim() && typeof f.content === "string")
      : [];
    if (files.length === 0) {
      return { ok: false, error: "The model didn't produce any concrete file changes for this objective." };
    }
    const summary = typeof parsed.summary === "string" && parsed.summary.trim() ? parsed.summary.trim() : `Implements: ${objective}`;
    return { ok: true, summary, files };
  } catch (err: any) {
    observation.logTelemetry("warn", "Departments", `draftCodeChanges failed: ${err.message}`);
    return { ok: false, error: err.message || String(err) };
  }
}

export async function reviewCodeDiff(objective: string, files: DraftedFile[], groq: Groq | null): Promise<string> {
  if (!groq) {
    return "No capable model was available to review this change — please review the diff yourself before merging.";
  }
  try {
    const filesText = files.map((f) => `--- ${f.path} ---\n${f.content}`).join("\n\n");
    const response = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{
        role: "user",
        content:
          "Review this drafted code change against the objective it's meant to accomplish. Flag anything concerning — " +
          "bugs, missing error handling, security issues, or ways it doesn't actually satisfy the objective. Be concise.\n\n" +
          `Objective: ${objective}\n\nFiles:\n${filesText}`,
      }],
    });
    return response.choices[0]?.message?.content || "Review completed with no specific feedback.";
  } catch (err: any) {
    observation.logTelemetry("warn", "Departments", `reviewCodeDiff failed: ${err.message}`);
    return `Automated review failed (${err.message}) — please review the diff yourself before merging.`;
  }
}
