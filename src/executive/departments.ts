import { Type } from "@google/genai";
import { MindKernel } from "../self/kernel.js";
import { toGroqSchema } from "../runtime/groq-client.js";
import type { CognitionRouter } from "../runtime/cognition-router.js";
import { ObservationPlatform } from "../kernel/observation.js";
import * as github from "../capabilities/providers/github.js";
import * as webBrowser from "../capabilities/providers/web-browser.js";
import * as knowledgeGraph from "../cognition/knowledge-graph.js";
import type { DraftedFile } from "../kernel/state/build-requests-repo.js";

const observation = ObservationPlatform.getInstance();

/**
 * The three department routines dispatched by the executive.
 *
 * Jarvis remains the only intelligence exposed to the user.
 * Departments are internal execution responsibilities, not separate agents.
 */

export interface DepartmentStep {
  step: string;
  department: "research" | "coding" | "qa";
}

export interface ResearchResult {
  summary: string;
}

const DEPARTMENT_DECOMPOSITION_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    steps: {
      type: Type.ARRAY,
      description:
        "1 to 5 concrete steps needed to accomplish the objective, each tagged with the department that owns it.",
      items: {
        type: Type.OBJECT,
        properties: {
          step: {
            type: Type.STRING,
            description: "A concrete, specific description of this step",
          },
          department: {
            type: Type.STRING,
            description:
              "One of: research, coding, qa. Use 'coding' only when the objective genuinely requires changing repository code. " +
              "Use 'qa' only for reviewing a coding step in the same list. Use 'research' for research, planning, investigation, or other non-code work.",
          },
        },
        required: ["step", "department"],
      },
    },
  },
  required: ["steps"],
};

/**
 * Jarvis is local-first.
 *
 * In offline mode, only the local model is allowed.
 * When online, the local model is still tried first.
 *
 * We intentionally do not hard-code Groq as the primary department model.
 * The router is responsible for provider execution.
 */
function getLocalModelTarget(): string | null {
  const modelName = MindKernel.getInstance().localModelName?.trim();

  if (!modelName) {
    return null;
  }

  return `local:${modelName}`;
}

function getModelTargets(): string[] {
  const localTarget = getLocalModelTarget();

  if (!localTarget) {
    return [];
  }

  return [localTarget];
}

/**
 * Decompose a high-level objective into concrete department-owned steps.
 */
export async function decomposeObjective(
  objective: string,
  router: CognitionRouter | null,
  _offlineMode: boolean,
  username: string,
): Promise<DepartmentStep[]> {
  const cleanedObjective = objective.trim();

  if (!cleanedObjective) {
    return [];
  }

  if (!router) {
    return [
      {
        step: cleanedObjective,
        department: "research",
      },
    ];
  }

  const modelTargets = getModelTargets();

  if (modelTargets.length === 0) {
    observation.logTelemetry(
      "warn",
      "Departments",
      "No local cognition model is configured. Falling back to one research step.",
    );

    return [
      {
        step: cleanedObjective,
        department: "research",
      },
    ];
  }

  try {
    const response = await router.generateWithFallback(
      username,
      {
        messages: [
          {
            role: "user",
           content:
            "Break this objective down into 1-5 concrete steps. " +
            "Each step must be assigned to exactly one department: " +
            "\"research\", \"coding\", or \"qa\".\n\n" +
            "Rules:\n" +
            "- Use coding only when repository code genuinely needs to be created or changed.\n" +
            "- Use qa only when there is a coding step in this same decomposition.\n" +
            "- Use research for investigation, planning, information gathering, or non-code work.\n\n" +
            `Objective: "${cleanedObjective}"`, 
          },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "department_decomposition",
            schema: toGroqSchema(DEPARTMENT_DECOMPOSITION_SCHEMA),
            strict: true,
          },
        },
      },
      modelTargets,
    );

    const parsed = JSON.parse(
      response.choices[0]?.message?.content || "{}",
    );

    const rawSteps = Array.isArray(parsed.steps) ? parsed.steps : [];

    const valid: DepartmentStep[] = rawSteps
      .filter(
        (step: any) =>
          typeof step?.step === "string" &&
          step.step.trim().length > 0 &&
          ["research", "coding", "qa"].includes(step.department),
      )
      .slice(0, 5)
      .map((step: any) => ({
        step: step.step.trim(),
        department: step.department,
      }));

    if (valid.length === 0) {
      return [
        {
          step: cleanedObjective,
          department: "research",
        },
      ];
    }

    const hasCoding = valid.some(
      (step) => step.department === "coding",
    );

    /**
     * QA without a coding step is meaningless.
     * Convert orphaned QA work into research instead of dispatching
     * a no-op QA department.
     */
    if (!hasCoding) {
      return valid.map((step) =>
        step.department === "qa"
          ? {
              ...step,
              department: "research" as const,
            }
          : step,
      );
    }

    return valid;
  } catch (err: any) {
    observation.logTelemetry(
      "warn",
      "Departments",
      `decomposeObjective failed: ${err?.message || String(err)}. ` +
        "Falling back to a single research step.",
    );

    return [
      {
        step: cleanedObjective,
        department: "research",
      },
    ];
  }
}

/**
 * Schema used by the research planner.
 *
 * The planner decides what Jarvis should investigate.
 * It does not directly browse the internet.
 */
const RESEARCH_LOOKUPS_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    webQueries: {
      type: Type.ARRAY,
      description:
        "0-3 precise web searches that would materially help answer the objective. " +
        "Use an empty array when live web research would not add value.",
      items: {
        type: Type.STRING,
      },
    },

    checkThisRepo: {
      type: Type.BOOLEAN,
      description:
        "True only when understanding this repository's current purpose or structure is relevant to the objective.",
    },

    knowledgeQuery: {
      type: Type.STRING,
      description:
        'A specific topic to check Jarvis\'s stored knowledge for, or "" when not applicable.',
    },
  },

  required: [
    "webQueries",
    "checkThisRepo",
    "knowledgeQuery",
  ],
};

/**
 * Run research using:
 *
 * 1. Local cognition model to decide what to investigate.
 * 2. Browser-based web research for live internet sources.
 * 3. Repository inspection when relevant.
 * 4. Jarvis's own knowledge graph.
 * 5. Local cognition model to synthesize the findings.
 *
 * The browser is deliberately separated from the cognition model.
 * The model reasons about sources; the browser actually accesses them.
 */
export async function runResearch(
  objective: string,
  router: CognitionRouter | null,
  username: string,
): Promise<ResearchResult> {
  const cleanedObjective = objective.trim();

  if (!cleanedObjective) {
    return {
      summary: "There was no research objective to investigate.",
    };
  }

  if (!router) {
    return {
      summary:
        "No cognition router is available, so Jarvis could not plan or synthesize this research pass.",
    };
  }

  const modelTargets = getModelTargets();

  if (modelTargets.length === 0) {
    return {
      summary:
        "No local cognition model is configured, so Jarvis could not perform a model-driven research pass.",
    };
  }

  let webQueries: string[] = [];
  let checkThisRepo = false;
  let knowledgeQuery = "";

  /**
   * First pass:
   * ask the local model what evidence is actually needed.
   */
  try {
    const lookupResponse = await router.generateWithFallback(
      username,
      {
        messages: [
          {
            role: "user",
            content:
              `Plan what Jarvis should research for this objective.\n\n` +
              `Objective: "${cleanedObjective}"`,
          },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "research_lookups",
            schema: toGroqSchema(RESEARCH_LOOKUPS_SCHEMA),
            strict: true,
          },
        },
      },
      modelTargets,
    );

    const parsed = JSON.parse(
      lookupResponse.choices[0]?.message?.content || "{}",
    );

    webQueries = Array.isArray(parsed.webQueries)
      ? parsed.webQueries
          .filter(
            (query: any) =>
              typeof query === "string" &&
              query.trim().length > 0,
          )
          .map((query: string) => query.trim())
          .slice(0, 3)
      : [];

    checkThisRepo = parsed.checkThisRepo === true;

    knowledgeQuery =
      typeof parsed.knowledgeQuery === "string"
        ? parsed.knowledgeQuery.trim()
        : "";
  } catch (err: any) {
    observation.logTelemetry(
      "warn",
      "Departments",
      `Research planning failed: ${err?.message || String(err)}. ` +
        "Falling back to a direct browser search.",
    );

    webQueries = [cleanedObjective];
  }

  const findings: string[] = [];

  const offlineMode =
    MindKernel.getInstance().offlineMode === true;

  /**
   * Offline means no internet.
   *
   * Local cognition still works.
   * Browser research does not.
   */
  if (offlineMode) {
    observation.logTelemetry(
      "info",
      "Departments",
      "Offline mode is active. Live browser research and remote repository lookups are disabled.",
    );

    webQueries = [];
    checkThisRepo = false;
  }

  /**
   * Optional network gate.
   *
   * Online mode enables browser research by default.
   * Setting JARVIS_WEB_RESEARCH_ENABLED=false provides an additional
   * explicit kill switch without disabling the rest of Jarvis.
   */
  const webResearchEnabled =
    !offlineMode &&
    process.env.JARVIS_WEB_RESEARCH_ENABLED !== "false";

  /**
   * Live browser research.
   *
   * No Brave API key or search API is required.
   * The browser provider performs the search and captures useful
   * source material plus screenshots.
   */
  if (webResearchEnabled) {
    for (const query of webQueries) {
      try {
        const browserResult =
          await webBrowser.searchAndCapture(query, {
            maxResults: 5,
            pagesToCapture: 3,
          });

        if (browserResult.results.length === 0) {
          findings.push(
            `Web research "${query}": no usable results were found.`,
          );
          continue;
        }

        const resultText = browserResult.results
          .map((result) => {
            const sourceText = result.text
              ? `\n${result.text.slice(0, 3500)}`
              : "";

            const screenshotText = result.screenshotPath
              ? `\nScreenshot: ${result.screenshotPath}`
              : "";

            return (
              `- ${result.title}\n` +
              `  URL: ${result.url}\n` +
              `  Description: ${result.description || "(none)"}` +
              sourceText +
              screenshotText
            );
          })
          .join("\n\n");

        findings.push(
          `Browser research for "${query}":\n${resultText}`,
        );
      } catch (err: any) {
        findings.push(
          `Browser research "${query}" failed: ${
            err?.message || String(err)
          }`,
        );

        observation.logTelemetry(
          "warn",
          "Departments",
          `Browser research failed for "${query}": ${
            err?.message || String(err)
          }`,
        );
      }
    }
  } else if (webQueries.length > 0) {
    findings.push(
      "Live browser research was requested but is currently disabled.",
    );
  }

  /**
   * Repository context.
   *
   * This remains separate from general web research.
   */
  if (checkThisRepo && !offlineMode) {
    const owner = process.env.SELF_REPO_OWNER;
    const repoName = process.env.SELF_REPO_NAME;

    if (owner && repoName) {
      try {
        const repo = await github.getRepo(
          owner,
          repoName,
        );

        findings.push(
          `This repository:\n` +
            `- Full name: ${repo.full_name}\n` +
            `- Description: ${
              repo.description || "(no description)"
            }\n` +
            `- Default branch: ${repo.default_branch}`,
        );
      } catch (err: any) {
        findings.push(
          `Repository metadata lookup failed: ${
            err?.message || String(err)
          }`,
        );
      }

      try {
        const readme: any =
          await github.getFileContent(
            owner,
            repoName,
            "README.md",
          );

        if (readme?.decodedContent) {
          findings.push(
            `Repository README excerpt:\n${readme.decodedContent.slice(
              0,
              3000,
            )}`,
          );
        }
      } catch (err: any) {
        observation.logTelemetry(
          "debug",
          "Departments",
          `README lookup skipped: ${
            err?.message || String(err)
          }`,
        );
      }
    }
  }

  /**
   * Jarvis's own stored knowledge remains available even offline.
   */
  if (knowledgeQuery) {
    try {
      const known =
        await knowledgeGraph.queryKnowledge(
          username,
          knowledgeQuery,
        );

      if (known.length > 0) {
        findings.push(
          `Jarvis's existing knowledge about "${knowledgeQuery}":\n` +
            known
              .map(
                (entry) =>
                  `- ${entry.entityName}: ${entry.facts.join("; ")}`,
              )
              .join("\n"),
        );
      } else {
        findings.push(
          `Jarvis's existing knowledge contains no matching records for "${knowledgeQuery}".`,
        );
      }
    } catch (err: any) {
      findings.push(
        `Knowledge graph lookup for "${knowledgeQuery}" failed: ${
          err?.message || String(err)
        }`,
      );
    }
  }

  if (findings.length === 0) {
    return {
      summary:
        "No concrete evidence was gathered for this research objective.",
    };
  }

  /**
   * Final cognition pass:
   * the local model turns the collected evidence into a report.
   */
  try {
    const synthesis = await router.generateWithFallback(
      username,
      {
        messages: [
          {
            role: "user",
            content:
              `Synthesize the following research evidence into a clear, concise report.\n\n` +
              `Objective:\n${cleanedObjective}\n\n` +
              `Evidence:\n${findings.join("\n\n")}\n\n` +
              `Requirements:\n` +
              `- Separate verified facts from uncertainty.\n` +
              `- Preserve source URLs when useful.\n` +
              `- Do not invent missing information.\n` +
              `- Prefer concise findings over repetition.\n`,
          },
        ],
      },
      modelTargets,
    );

    return {
      summary:
        synthesis.choices[0]?.message?.content?.trim() ||
        findings.join("\n\n"),
    };
  } catch (err: any) {
    observation.logTelemetry(
      "warn",
      "Departments",
      `Research synthesis failed: ${
        err?.message || String(err)
      }. Returning raw findings.`,
    );

    return {
      summary: findings.join("\n\n"),
    };
  }
}

/**
 * Human-readable code review.
 *
 * Used for broader review of drafted files.
 */
export async function reviewCodeDiff(
  objective: string,
  files: DraftedFile[],
  router: CognitionRouter | null,
  username: string,
): Promise<string> {
  if (!router) {
    return (
      "No capable local model was available to review this change. " +
      "The change should remain unmerged until it has been reviewed."
    );
  }

  const modelTargets = getModelTargets();

  if (modelTargets.length === 0) {
    return (
      "No local cognition model is configured for automated code review. " +
      "The change should remain unmerged until it has been reviewed."
    );
  }

  try {
    const filesText = files
      .map(
        (file) =>
          `--- ${file.path} ---\n${file.content}`,
      )
      .join("\n\n");

    const response =
      await router.generateWithFallback(
        username,
        {
          messages: [
            {
              role: "user",
              content:
                `Review this drafted code change against the objective it is intended to accomplish.\n\n` +
                `Flag real problems such as bugs, missing error handling, security issues, architectural violations, or incomplete implementation.\n\n` +
                `Objective:\n${objective}\n\n` +
                `Files:\n${filesText}\n`,
            },
          ],
        },
        modelTargets,
      );

    return (
      response.choices[0]?.message?.content?.trim() ||
      "Review completed with no specific feedback."
    );
  } catch (err: any) {
    observation.logTelemetry(
      "warn",
      "Departments",
      `reviewCodeDiff failed: ${
        err?.message || String(err)
      }`,
    );

    return (
      `Automated review failed (${
        err?.message || String(err)
      }) — the change should remain unmerged until it has been reviewed.`
    );
  }
}

const TASK_REVIEW_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    approved: {
      type: Type.BOOLEAN,
    },
    findings: {
      type: Type.STRING,
    },
  },
  required: ["approved", "findings"],
};

/**
 * Task-scoped approval gate.
 *
 * This is intentionally fail-closed.
 * If review is unavailable, the task is not approved.
 */
export async function reviewTaskDiff(
  taskTitle: string,
  taskDescription: string,
  files: DraftedFile[],
  router: CognitionRouter | null,
  username: string,
): Promise<{
  approved: boolean;
  findings: string;
}> {
  if (!router) {
    return {
      approved: false,
      findings:
        "No capable local model was available to review this task. " +
        "The task is being held rather than shipped unreviewed.",
    };
  }

  const modelTargets = getModelTargets();

  if (modelTargets.length === 0) {
    return {
      approved: false,
      findings:
        "No local cognition model is configured for the task review gate. " +
        "The task is being held rather than shipped unreviewed.",
    };
  }

  try {
    const filesText = files
      .map(
        (file) =>
          `--- ${file.path} ---\n${file.content}`,
      )
      .join("\n\n");

    const response =
      await router.generateWithFallback(
        username,
        {
          messages: [
            {
              role: "user",
              content:
                `Review this task's drafted code change against what the task was supposed to accomplish.\n\n` +
                `Approve only when the task is genuinely satisfied and there are no material bugs, missing error handling, security problems, or obvious implementation gaps.\n\n` +
                `Task:\n${taskTitle}\n\n` +
                `Description:\n${taskDescription}\n\n` +
                `Files:\n${filesText}\n`,
            },
          ],
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "task_review",
              schema: toGroqSchema(
                TASK_REVIEW_SCHEMA,
              ),
              strict: true,
            },
          },
        },
        modelTargets,
      );

    const parsed = JSON.parse(
      response.choices[0]?.message?.content ||
        "{}",
    );

    return {
      approved: parsed.approved === true,
      findings:
        typeof parsed.findings === "string"
          ? parsed.findings
          : "",
    };
  } catch (err: any) {
    observation.logTelemetry(
      "warn",
      "Departments",
      `reviewTaskDiff failed: ${
        err?.message || String(err)
      }`,
    );

    return {
      approved: false,
      findings:
        `Automated review failed (${
          err?.message || String(err)
        }) — holding rather than shipping the task unreviewed.`,
    };
  }
}