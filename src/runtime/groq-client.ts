import Groq from "groq-sdk";
import { ObservationPlatform } from "../kernel/observation.js";

const observation = ObservationPlatform.getInstance();

/**
 * Normalizes a schema tree into the lowercase JSON Schema shape Groq's
 * structured-output/tool-calling APIs expect. This one function correctly
 * handles both of this codebase's existing schema sources: Gemini's `Type`
 * enum values ("OBJECT", "STRING", ...) and MCP servers' tool schemas
 * (already lowercase, standard JSON Schema, per the MCP capability
 * architecture phase) — `.toLowerCase()` on an already-lowercase value is a
 * no-op, so the same recursive walk is correct and idempotent for both
 * without needing to special-case which source produced it. See
 * docs/superpowers/specs/2026-07-21-groq-provider-design.md's "Decisions"
 * section for why this was chosen over two separate translators.
 */
export function toGroqSchema(schema: any): any {
  if (Array.isArray(schema)) {
    return schema.map(toGroqSchema);
  }
  if (schema && typeof schema === "object") {
    const result: any = {};
    for (const [key, value] of Object.entries(schema)) {
      result[key] = key === "type" && typeof value === "string" ? value.toLowerCase() : toGroqSchema(value);
    }
    // Groq's strict JSON-schema mode rejects any object-typed node that
    // doesn't explicitly declare additionalProperties — live-verified:
    // every response_format:{strict:true} call failed 400 across the board
    // until this was added. Gemini's Type-based schemas never set this (it
    // isn't required there), so it has to be injected here at translation
    // time. An explicit value already present (e.g. from an MCP-sourced
    // schema) is left alone rather than overwritten.
    if (result.type === "object" && !("additionalProperties" in result)) {
      result.additionalProperties = false;
    }
    return result;
  }
  return schema;
}

/**
 * Wraps this codebase's existing tool-declaration shape (the same objects
 * getAllToolDeclarations() already produces for Gemini) into Groq's
 * {type: "function", function: {...}} tool shape.
 */
export function toGroqTools(declarations: Array<{ name?: string; description?: string; parameters?: any }>): any[] {
  return declarations.map((decl) => ({
    type: "function" as const,
    function: {
      name: decl.name,
      description: decl.description,
      parameters: toGroqSchema(decl.parameters),
    },
  }));
}

/**
 * Same multi-model retry shape as server.ts's existing
 * generateContentWithFallback, generalized for Groq's client — mitigates a
 * transient 5xx/high-demand error on one model by trying the next.
 */
export async function generateWithFallback(groq: Groq, params: any, models: string[]): Promise<Groq.Chat.Completions.ChatCompletion> {
  let lastError: any = null;
  for (const model of models) {
    try {
      observation.logTelemetry("info", "Cognition", `Attempting Groq content generation with model: ${model}`);
      const response = await groq.chat.completions.create({ ...params, model });
      observation.logTelemetry("info", "Cognition", `Successfully generated content with Groq model: ${model}`);
      return response as Groq.Chat.Completions.ChatCompletion;
    } catch (error: any) {
      lastError = error;
      observation.logTelemetry("warn", "Cognition", `Groq model ${model} failed: ${error.message || error}`);
    }
  }
  throw lastError || new Error("All fallback models failed content generation");
}
