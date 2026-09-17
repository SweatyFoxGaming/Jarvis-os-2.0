import { Type } from "@google/genai";
import type { CognitionRouter } from "../runtime/cognition-router.js";
import { toGroqSchema } from "../runtime/groq-client.js";
import { ObservationPlatform } from "../kernel/observation.js";
import * as rapportRepo from "../kernel/state/rapport-repo.js";

const observation = ObservationPlatform.getInstance();

const RAPPORT_SIGNAL_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    toneDescriptor: { type: Type.STRING, description: "A short, honest description (5-12 words) of the tone/mood of the USER's message below — e.g. \"terse, focused, all-business\" or \"playful, exploratory, casual\". Base this only on what's actually in the message; do not invent emotional content that isn't there." },
    formalityObserved: { type: Type.INTEGER, description: "0-100 estimate of how formal the user's message reads, 0 = very casual/informal, 100 = very formal/professional" },
  },
  required: ["toneDescriptor", "formalityObserved"],
};

/**
 * Write side — fire-and-forget, same trigger point and pattern as
 * identity.ts's extractSelfReflection, applied to the USER's message
 * instead of Jarvis's own reply. A real CognitionRouter call reads what
 * the user actually wrote; nothing is stored if the call fails or
 * returns nothing usable — never a fabricated/guessed signal.
 */
export async function extractRapportSignal(username: string, router: CognitionRouter | null, userMessage: string): Promise<void> {
  if (!router) return;
  try {
    const response = await router.generateWithFallback(
      username,
      {
        messages: [{
          role: "user",
          content:
            "Analyze the tone of the following USER message (not any assistant reply) and describe it honestly and " +
            "briefly. This is a real, ordinary message from a person talking to their AI assistant — most messages are " +
            "simply neutral and task-focused, and that's a completely valid, common answer; only describe something " +
            "more specific (frustrated, excited, playful, terse) if it's genuinely present in the wording.\n\n" +
            `User message: ${userMessage.slice(0, 1000)}`,
        }],
        response_format: {
          type: "json_schema",
          json_schema: { name: "rapport_signal", schema: toGroqSchema(RAPPORT_SIGNAL_SCHEMA), strict: true },
        },
      },
      ["groq:openai/gpt-oss-20b"]
    );

    const parsed = JSON.parse(response.choices[0]?.message?.content || "{}");
    const toneDescriptor = typeof parsed.toneDescriptor === "string" ? parsed.toneDescriptor.trim() : "";
    const formalityObserved = typeof parsed.formalityObserved === "number" ? Math.max(0, Math.min(100, Math.round(parsed.formalityObserved))) : null;

    if (toneDescriptor) {
      await rapportRepo.recordRapportSignal(username, toneDescriptor, formalityObserved);
      observation.logTelemetry("info", "Rapport", `Recorded rapport signal for "${username}": "${toneDescriptor}"`);
    }
  } catch (err: any) {
    observation.logTelemetry("warn", "Rapport", `Rapport signal extraction failed: ${err.message || err}`);
  }
}

/**
 * Read side — pulled into the chat system instruction alongside the
 * personality dials. Synthesizes real recent tone observations into a
 * short natural-language fragment. Explicitly adjusts WITHIN the user's
 * own dial settings, never against them — this is a framing instruction
 * baked into the returned text itself, not a runtime-enforced rule, so
 * keep this framing intact if this function is ever edited.
 */
export async function buildRapportContext(username: string, limit = 8): Promise<string> {
  const recent = await rapportRepo.getRecentRapportSignals(username, limit);
  if (recent.length === 0) return "";
  const descriptors = recent.map(s => s.toneDescriptor).join("; ");
  return `\n\nHow this user has been coming across in your recent conversations: ${descriptors}. Let this inform your tone naturally, within your existing formality/humor/verbosity settings — this is context for calibration, not an instruction to change register entirely.`;
}
