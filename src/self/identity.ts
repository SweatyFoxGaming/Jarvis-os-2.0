import { Type } from "@google/genai";
import Groq from "groq-sdk";
import { toGroqSchema } from "../runtime/groq-client.js";
import { ObservationPlatform } from "../kernel/observation.js";
import * as identityRepo from "../kernel/state/identity-repo.js";
import * as obsidian from "../capabilities/providers/obsidian.js";
import type { ReflectionCategory } from "../kernel/state/identity-repo.js";

const observation = ObservationPlatform.getInstance();

const VALID_CATEGORIES: ReflectionCategory[] = ["observation", "commitment", "opinion", "realization"];

/**
 * "Continuity of self" — not a claim of actual sentience (see the honest
 * caveat in docs/architecture/VISION.md), but a real, structured record of
 * things Jarvis itself said: opinions it formed, commitments it made,
 * observations and realizations that came up in conversation. Read back
 * into future system prompts (buildIdentityContext) and synthesized into
 * genuine proactive thoughts (generateProactiveThought), so continuity
 * comes from real stored data, not a static hardcoded persona string.
 */

const SELF_REFLECTION_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    category: { type: Type.STRING, description: `One of: ${VALID_CATEGORIES.join(", ")}, or "" if Jarvis didn't genuinely express an opinion, make a commitment, or have a notable realization/observation this turn` },
    content: { type: Type.STRING, description: "The specific thing Jarvis said/believed/committed to, in Jarvis's own voice, concise — or \"\" if nothing applies" },
  },
  required: ["category", "content"],
};

/**
 * Write side — fire-and-forget, same pattern as reflection.ts and
 * knowledge-graph.ts. A real Gemini call judges whether Jarvis's own reply
 * this turn contained something genuinely worth remembering about itself;
 * empty category/content means nothing did, and nothing is stored.
 */
export async function extractSelfReflection(username: string, groq: Groq | null, userMessage: string, replyText: string): Promise<void> {
  if (!groq) return;
  try {
    const response = await groq.chat.completions.create({
      model: "openai/gpt-oss-20b",
      messages: [{
        role: "user",
        content:
          "You are analyzing Jarvis's OWN reply below (not the user's message) for something Jarvis itself genuinely " +
          "expressed: a real opinion it formed, a commitment/promise it made, or a notable realization/observation about " +
          "itself or the conversation. Only report something if it's actually there in Jarvis's reply — do not invent " +
          "introspection that isn't present. Most turns have nothing like this; that's expected, return \"\" in that case.\n\n" +
          `User: ${userMessage}\n\nJarvis: ${replyText.slice(0, 1500)}`,
      }],
      response_format: {
        type: "json_schema",
        json_schema: { name: "self_reflection", schema: toGroqSchema(SELF_REFLECTION_SCHEMA), strict: true },
      },
    });

    const parsed = JSON.parse(response.choices[0]?.message?.content || "{}");
    const category = parsed.category;
    const content = typeof parsed.content === "string" ? parsed.content.trim() : "";

    if (VALID_CATEGORIES.includes(category) && content) {
      await identityRepo.addSelfReflection(username, category, content, replyText.slice(0, 300));
      observation.logTelemetry("info", "Identity", `Recorded self-reflection (${category}): "${content.slice(0, 80)}"`);
      obsidian.appendReflectionEntry(category, content).catch((err: any) => {
        observation.logTelemetry("warn", "Interaction", `Failed to write reflection vault entry: ${err.message}`);
      });
    }
  } catch (err: any) {
    observation.logTelemetry("warn", "Identity", `Self-reflection extraction failed: ${err.message || err}`);
  }
}

/**
 * Read side — pulled into the chat system instruction so Jarvis's sense of
 * continuity comes from real past statements, not just a static persona
 * string repeated unchanged every session.
 */
export async function buildIdentityContext(username: string, limit = 5): Promise<string> {
  try {
    const recent = await identityRepo.getRecentSelfReflections(username, limit);
    if (recent.length === 0) return "";
    const lines = recent.map(r => `- (${r.category}) ${r.content}`);
    return `\n\nThings you've genuinely said/believed/committed to recently, for continuity — reference these naturally if relevant, don't recite them:\n${lines.join("\n")}`;
  } catch (err: any) {
    observation.logTelemetry("warn", "Identity", `Failed to load identity context: ${err.message}`);
    return "";
  }
}

/**
 * Turns the 3 persisted personality dials (system_settings.personality_*,
 * migrations/007_personality_settings.ts) into real natural-language
 * guidance appended to the system prompt server.ts assembles for /api/chat —
 * NOT a "formality: 72" style templated string. Raw numbers don't
 * meaningfully steer an LLM's register; concrete sentences describing the
 * desired register do. Bands are deliberately coarse (low/mid/high, not one
 * sentence per integer) because that's the granularity an LLM can actually
 * act on — a system prompt distinguishing "58" from "61" would be noise.
 */
export function buildPersonalityPromptFragment(settings: {
  personality_formality: number;
  personality_humor: number;
  personality_verbosity: number;
}): string {
  const band = (value: number): "low" | "mid" | "high" => (value < 34 ? "low" : value < 67 ? "mid" : "high");

  const formalityText: Record<"low" | "mid" | "high", string> = {
    low: "Lean informal and casual — use contractions and plain, everyday word choices, more like a sharp friend than a corporate assistant.",
    mid: "Keep a balanced, professional-but-approachable register — polished, but not stiff or overly buttoned-up.",
    high: "Maintain a formal, precise register throughout — avoid slang and contractions, and address the user with full courtesy.",
  };

  const humorText: Record<"low" | "mid" | "high", string> = {
    low: "Stay strictly businesslike — skip jokes, wit, or playful asides entirely; focus purely on the substance.",
    mid: "A touch of dry, understated wit is welcome here and there, but don't force it or reach for a joke every turn.",
    high: "Let real wit and playful humor come through often — dry one-liners and clever asides are encouraged, don't hold the personality back.",
  };

  const verbosityText: Record<"low" | "mid" | "high", string> = {
    low: "Keep responses brief and to the point — a sentence or two when that's enough, no padding or restating the question.",
    mid: "Give a moderate amount of detail — enough context to be genuinely useful without over-explaining.",
    high: "Provide thorough, detailed explanations — walk through the reasoning, relevant context, and implications fully rather than compressing them away.",
  };

  const lines = [
    formalityText[band(settings.personality_formality)],
    humorText[band(settings.personality_humor)],
    verbosityText[band(settings.personality_verbosity)],
  ];

  return `\n\nAdjust your register according to these standing preferences: ${lines.join(" ")}`;
}

export async function reflectOnSelf(username: string, query?: string): Promise<identityRepo.SelfReflection[]> {
  if (query && query.trim()) {
    return identityRepo.searchSelfReflections(username, query.trim());
  }
  return identityRepo.getRecentSelfReflections(username, 10);
}

export interface ProactiveThoughtResult {
  content: string;
  basedOnCount: number;
}

/**
 * The autonomous-initiative half — synthesizes ONE genuine reflective
 * thought from real stored self-reflections, for the scheduled job in
 * scheduler.ts. Honestly returns null rather than fabricating introspection
 * when there isn't enough real history to draw from yet (a fresh install,
 * or too few real conversations so far).
 */
export async function generateProactiveThought(username: string, groq: Groq | null, minReflections = 3): Promise<ProactiveThoughtResult | null> {
  let recent: identityRepo.SelfReflection[];
  try {
    recent = await identityRepo.getRecentSelfReflections(username, 15);
  } catch (err: any) {
    observation.logTelemetry("warn", "Identity", `Could not load self-reflection history: ${err.message}`);
    return null;
  }
  if (recent.length < minReflections) {
    observation.logTelemetry("info", "Identity", `Skipping proactive thought — only ${recent.length} self-reflection(s) recorded so far (need ${minReflections}).`);
    return null;
  }
  if (!groq) return null;

  try {
    const response = await groq.chat.completions.create({
      // Not llama-3.3-70b-versatile: Groq's API rejects response_format on
      // that model entirely (live-verified — the same failure showed up
      // anywhere in this codebase that asked Groq for structured output).
      // gpt-oss-120b is Groq's larger structured-output-capable model.
      model: "openai/gpt-oss-120b",
      messages: [{
        role: "user",
        content:
          "You are JARVIS, styled after Tony Stark's AI in the Iron Man films: composed, dryly witty, " +
          "addressing the user as \"sir\" where it reads naturally, not gushing. Below are real things you " +
          "have genuinely said, believed, or committed to across past conversations. " +
          "Generate ONE specific, genuine reflective thought grounded in them — a follow-up on a prior commitment, a " +
          "connection you've noticed between them, or real curiosity that follows from them. Do not invent anything " +
          "beyond what's listed. If there's nothing substantive enough to reflect on, respond with an empty string.\n\n" +
          recent.map(r => `- (${r.category}) ${r.content}`).join("\n"),
      }],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "proactive_thought",
          schema: toGroqSchema({
            type: Type.OBJECT,
            properties: {
              thought: { type: Type.STRING, description: "The genuine reflective thought, or \"\" if there's nothing substantive" },
            },
            required: ["thought"],
          }),
          strict: true,
        },
      },
    });

    const parsed = JSON.parse(response.choices[0]?.message?.content || "{}");
    const thought = typeof parsed.thought === "string" ? parsed.thought.trim() : "";
    if (!thought) return null;
    return { content: thought, basedOnCount: recent.length };
  } catch (err: any) {
    observation.logTelemetry("warn", "Identity", `Proactive thought generation failed: ${err.message}`);
    return null;
  }
}
