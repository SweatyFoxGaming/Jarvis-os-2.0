import { Type } from "@google/genai";
import { MindKernel } from "../self/kernel.js";
import { toGroqSchema } from "../runtime/groq-client.js";
import type { CognitionRouter } from "../runtime/cognition-router.js";
import { ObservationPlatform } from "../kernel/observation.js";
import * as github from "../capabilities/providers/github.js";
import * as webBrowser from "../capabilities/providers/web-browser.js";
import * as knowledgeGraph from "../cognition/knowledge-graph.js";
import type { DraftedFile } from "../kernel/state/build-requests-repo.js";
import { AutonomousExecutive } from "./autonomous_executive.js";

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
              '"research", "coding", or "qa".\n\n' +
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
 * Run research using the deep iterative research pipeline in AutonomousExecutive.
 */
export async function runResearch(
  objective: string,
  router: CognitionRouter | null,
  _username: string,
): Promise<ResearchResult> {
  const cleanedObjective = objective.trim();

  if (!cleanedObjective) {
    return {
      summary: "There was no research objective to investigate.",
    };
  }

  if (!router || getModelTargets().length === 0) {
    return {
      summary: "No capable model is available right now, so I couldn't do real research on this — I'd need the cognition router reachable to plan and synthesize findings.",
    };
  }

  try {
    const executive = AutonomousExecutive.getInstance();
    const result = await executive.runResearchPipeline(cleanedObjective, 3);

    const formattedSummary = [
      `### Research Findings for: "${cleanedObjective}"`,
      ...result.findings.map((f) => `- ${f}`),
      result.knowledge_gaps.length > 0
        ? `\n**Remaining Gaps:**\n` +
          result.knowledge_gaps.map((g) => `- ${g}`).join("\n")
        : "",
    ]
      .filter(Boolean)
      .join("\n");

    return {
      summary: formattedSummary,
    };
  } catch (err: any) {
    observation.logTelemetry(
      "warn",
      "Departments",
      `Research pipeline execution failed: ${err?.message || String(err)}`,
    );

    return {
      summary: "No capable model is available right now, so I couldn't do real research on this — I'd need the cognition router reachable to plan and synthesize findings.",
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
  if (!router || getModelTargets().length === 0) {
    return "No capable model was available to review this change — please review the diff yourself before merging.";
  }

  const modelTargets = getModelTargets();

  try {
    const filesText = files
      .map(
        (file) =>
          `--- ${file.path} ---\n${file.content}`,
      )
      .join("\n\n");

    const response = await router.generateWithFallback(
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
      `reviewCodeDiff failed: ${err?.message || String(err)}`,
    );

    return "No capable model was available to review this change — please review the diff yourself before merging.";
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
  if (!router || getModelTargets().length === 0) {
    return {
      approved: false,
      findings: "No capable model was available to review this task — holding rather than shipping it unreviewed. Configure GROQ_API_KEYS or GEMINI_API_KEYS to enable the coding agent's review gate.",
    };
  }

  const modelTargets = getModelTargets();

  try {
    const filesText = files
      .map(
        (file) =>
          `--- ${file.path} ---\n${file.content}`,
      )
      .join("\n\n");

    const response = await router.generateWithFallback(
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
            schema: toGroqSchema(TASK_REVIEW_SCHEMA),
            strict: true,
          },
        },
      },
      modelTargets,
    );

    const parsed = JSON.parse(
      response.choices[0]?.message?.content || "{}",
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
      `reviewTaskDiff failed: ${err?.message || String(err)}`,
    );

    return {
      approved: false,
      findings: "No capable model was available to review this task — holding rather than shipping it unreviewed. Configure GROQ_API_KEYS or GEMINI_API_KEYS to enable the coding agent's review gate.",
    };
  }
}