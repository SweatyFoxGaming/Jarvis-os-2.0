import { Type } from "@google/genai";
import Groq from "groq-sdk";
import { toGroqSchema } from "../cognition/groq-client.js";
import { ObservationPlatform } from "../kernel/observation.js";
import { LongTermLearningEngine, ICodingStylePreference } from "./long_term_learning.js";

const observation = ObservationPlatform.getInstance();
const learningEngine = LongTermLearningEngine.getInstance();

const VALID_NAMING = ["camelCase", "snake_case", "PascalCase", "kebab-case"];
const VALID_ARCHITECTURE = ["MVC", "Hexagonal", "Microservices", "Decoupled-Contexts"];

const REFLECTION_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    styleNamingConvention: { type: Type.STRING, description: `One of ${VALID_NAMING.join(", ")}, or "" if no coding style preference was expressed or implied this turn` },
    styleTabSize: { type: Type.NUMBER, description: "Preferred indentation width in spaces, or 0 if not discussed" },
    styleFramework: { type: Type.STRING, description: "A framework/stack preference mentioned, or \"\" if none" },
    styleArchitecture: { type: Type.STRING, description: `One of ${VALID_ARCHITECTURE.join(", ")}, or "" if no architectural preference was expressed` },
    mistakeErrorSignature: { type: Type.STRING, description: "A concise description of a real mistake/bug that came up this turn (Jarvis's or the user's own, being corrected), or \"\" if none" },
    mistakeFile: { type: Type.STRING, description: "The file or component the mistake concerned, or \"\" if none/unclear" },
    mistakeRootCause: { type: Type.STRING, description: "Why the mistake happened, or \"\" if none" },
    mistakeFix: { type: Type.STRING, description: "The correction that was found/applied, or \"\" if none" },
  },
  required: [
    "styleNamingConvention", "styleTabSize", "styleFramework", "styleArchitecture",
    "mistakeErrorSignature", "mistakeFile", "mistakeRootCause", "mistakeFix",
  ],
};

/**
 * Closes the "write" half of the continuous-learning loop for style
 * preferences and mistakes the same way memory-store.ts already does for
 * recall: a real Gemini call analyzes what just happened and decides, on
 * its own judgment, whether anything is worth remembering — instead of
 * requiring an explicit /api/learning/* call by hand. Deliberately not
 * attempted against the local model: this needs reliable structured JSON
 * output, and reflection quality is not the bottleneck the local-first
 * chat latency work was solving for.
 *
 * Fire-and-forget by design — must never block or slow down the reply the
 * user is waiting on. Every failure is caught and logged, never thrown.
 */
export async function reflectAndLearn(
  groq: Groq | null,
  userMessage: string,
  replyText: string
): Promise<void> {
  if (!groq) return;
  try {
    const response = await groq.chat.completions.create({
      model: "openai/gpt-oss-20b",
      messages: [{
        role: "user",
        content:
          "Analyze this exchange between a user and Jarvis, an AI assistant. " +
          "Only report a coding style preference if the user actually stated or clearly implied one. " +
          "Only report a mistake if a real error/bug and its fix were actually discussed — not a hypothetical. " +
          "Leave any field empty (\"\" or 0) if it doesn't apply; do not invent content to fill the schema.\n\n" +
          `User: ${userMessage}\n\nJarvis: ${replyText.slice(0, 1500)}`,
      }],
      response_format: {
        type: "json_schema",
        json_schema: { name: "style_and_mistake_reflection", schema: toGroqSchema(REFLECTION_SCHEMA), strict: true },
      },
    });

    const parsed = JSON.parse(response.choices[0]?.message?.content || "{}");

    const styleUpdate: Partial<ICodingStylePreference> = {};
    if (VALID_NAMING.includes(parsed.styleNamingConvention)) {
      styleUpdate.namingConvention = parsed.styleNamingConvention;
    }
    if (typeof parsed.styleTabSize === "number" && parsed.styleTabSize > 0) {
      styleUpdate.tabSize = parsed.styleTabSize;
    }
    if (typeof parsed.styleFramework === "string" && parsed.styleFramework.trim()) {
      styleUpdate.frameworkPreference = parsed.styleFramework.trim();
    }
    if (VALID_ARCHITECTURE.includes(parsed.styleArchitecture)) {
      styleUpdate.architecturePattern = parsed.styleArchitecture;
    }
    if (Object.keys(styleUpdate).length > 0) {
      learningEngine.updateStylePreference(styleUpdate);
    }

    if (
      typeof parsed.mistakeErrorSignature === "string" && parsed.mistakeErrorSignature.trim() &&
      typeof parsed.mistakeRootCause === "string" && parsed.mistakeRootCause.trim() &&
      typeof parsed.mistakeFix === "string" && parsed.mistakeFix.trim()
    ) {
      learningEngine.logMistake(
        parsed.mistakeErrorSignature.trim(),
        (typeof parsed.mistakeFile === "string" && parsed.mistakeFile.trim()) || "unspecified",
        parsed.mistakeRootCause.trim(),
        parsed.mistakeFix.trim()
      );
    }
  } catch (err: any) {
    observation.logTelemetry("warn", "Learning", `Automatic reflection failed: ${err.message || err}`);
  }
}
