import { GoogleGenAI, Type } from "@google/genai";
import Groq from "groq-sdk";
import { toGroqSchema } from "./groq-client.js";
import { ObservationPlatform } from "../observation/index.js";
import * as identityRepo from "../data/identity-repo.js";
import type { ReflectionCategory } from "../data/identity-repo.js";

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
export async function extractSelfReflection(groq: Groq | null, userMessage: string, replyText: string): Promise<void> {
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
      await identityRepo.addSelfReflection(category, content, replyText.slice(0, 300));
      observation.logTelemetry("info", "Identity", `Recorded self-reflection (${category}): "${content.slice(0, 80)}"`);
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
export async function buildIdentityContext(limit = 5): Promise<string> {
  try {
    const recent = await identityRepo.getRecentSelfReflections(limit);
    if (recent.length === 0) return "";
    const lines = recent.map(r => `- (${r.category}) ${r.content}`);
    return `\n\nThings you've genuinely said/believed/committed to recently, for continuity — reference these naturally if relevant, don't recite them:\n${lines.join("\n")}`;
  } catch (err: any) {
    observation.logTelemetry("warn", "Identity", `Failed to load identity context: ${err.message}`);
    return "";
  }
}

export async function reflectOnSelf(query?: string): Promise<identityRepo.SelfReflection[]> {
  if (query && query.trim()) {
    return identityRepo.searchSelfReflections(query.trim());
  }
  return identityRepo.getRecentSelfReflections(10);
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
export async function generateProactiveThought(ai: GoogleGenAI, minReflections = 3): Promise<ProactiveThoughtResult | null> {
  let recent: identityRepo.SelfReflection[];
  try {
    recent = await identityRepo.getRecentSelfReflections(15);
  } catch (err: any) {
    observation.logTelemetry("warn", "Identity", `Could not load self-reflection history: ${err.message}`);
    return null;
  }
  if (recent.length < minReflections) {
    observation.logTelemetry("info", "Identity", `Skipping proactive thought — only ${recent.length} self-reflection(s) recorded so far (need ${minReflections}).`);
    return null;
  }

  try {
    const response = await ai.models.generateContent({
      model: "gemini-3.1-flash-lite",
      contents: [{
        role: "user",
        parts: [{
          text:
            "You are JARVIS, styled after Tony Stark's AI in the Iron Man films: composed, dryly witty, " +
            "addressing the user as \"sir\" where it reads naturally, not gushing. Below are real things you " +
            "have genuinely said, believed, or committed to across past conversations. " +
            "Generate ONE specific, genuine reflective thought grounded in them — a follow-up on a prior commitment, a " +
            "connection you've noticed between them, or real curiosity that follows from them. Do not invent anything " +
            "beyond what's listed. If there's nothing substantive enough to reflect on, respond with an empty string.\n\n" +
            recent.map(r => `- (${r.category}) ${r.content}`).join("\n"),
        }],
      }],
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            thought: { type: Type.STRING, description: "The genuine reflective thought, or \"\" if there's nothing substantive" },
          },
          required: ["thought"],
        },
      },
    });

    const parsed = JSON.parse(response.text || "{}");
    const thought = typeof parsed.thought === "string" ? parsed.thought.trim() : "";
    if (!thought) return null;
    return { content: thought, basedOnCount: recent.length };
  } catch (err: any) {
    observation.logTelemetry("warn", "Identity", `Proactive thought generation failed: ${err.message}`);
    return null;
  }
}
