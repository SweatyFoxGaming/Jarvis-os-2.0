# Groq as Primary Cloud LLM Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Groq (free tier: 1,000-14,400 requests/day depending on model, vs. Gemini's 20/day) the primary cloud LLM across every text-only call site in this codebase. Gemini stays configured, narrowed to the one thing only it does — vision/multimodal chat.

**Architecture:** A new `src/cognition/groq-client.ts` holds schema/tool-declaration translation (Gemini's `Type`-enum schemas and MCP's already-lowercase schemas both normalize to Groq's expected JSON Schema via one recursive lowercasing function) and a Groq-flavored version of the existing multi-model retry helper. Eleven existing Gemini call sites across 5 files switch to Groq, model choice split by task nature (classification/extraction → `gpt-oss-20b`, generation-quality → `llama-3.3-70b-versatile`). The main `/api/chat` loop gains a fourth execution-chain step (`LocalLLM → Groq → Gemini → Simulated`) with its own tool-calling loop mirroring the existing Gemini branch's shape but using Groq's OpenAI-compatible message/tool-call format.

**Tech Stack:** TypeScript, `groq-sdk` (new dependency, verified against its real `.d.ts` — Groq's official OpenAI-compatible client), the existing `@google/genai` (unchanged, narrowed role), the existing hand-rolled `tests/index.test.ts` harness.

## Global Constraints

- **No behavior change to any call site's degrade-safety shape** — every rewritten function keeps its exact existing try/catch structure and fallback value; only the provider underneath changes.
- **Gemini is not removed anywhere.** `ai: GoogleGenAI | null` stays exactly as it is today everywhere it's still used (the main chat loop's vision case, `AutonomousExecutive`'s constructor for future needs, `executeTool`'s embedding-provider parameter). This plan only *adds* Groq alongside it, narrowing Gemini's role in the places the design spec identifies — never deleting Gemini's own code path.
- **Model choice is deliberate per task, not uniform**: `gpt-oss-20b` for classification/extraction (strict JSON-schema compliance matters more than prose quality); `llama-3.3-70b-versatile` for generation-quality tasks (prose synthesis, code drafting/review, and the main chat loop). Verified via Groq's own docs: `gpt-oss-20b`/`gpt-oss-120b` support `strict: true` JSON-schema compliance; `llama-3.3-70b-versatile` and `llama-3.1-8b-instant` are the two models this plan uses for the main chat loop's fallback list.
- **`groq-sdk`'s real API (verified directly against its shipped `.d.ts` files, not assumed):** `new Groq({apiKey})` (also auto-reads `process.env.GROQ_API_KEY` if omitted); `groq.chat.completions.create({model, messages, tools?, response_format?})` returns a `ChatCompletion` whose `.choices[0].message` is `{content: string | null, role: "assistant", tool_calls?: Array<{id, type: "function", function: {name, arguments: string}}>}` — `arguments` is a **JSON string**, not an object, and must be `JSON.parse`d. A tool's answer is a message shaped `{role: "tool", tool_call_id, content: string}`. `response_format` for structured output is `{type: "json_schema", json_schema: {name, schema, strict}}`. Tool declarations are `{type: "function", function: {name, description, parameters}}`.
- Match existing code style exactly: `src/cognition/identity.ts`'s degrade-safety try/catch shape for the rewritten generation functions; `src/server.ts`'s existing Gemini client construction block and `generateContentWithFallback` helper as the templates for their Groq equivalents.

---

### Task 1: `groq-client.ts` — schema translation and retry helper

**Files:**
- Create: `src/cognition/groq-client.ts`
- Modify: `package.json` (new dependency)
- Test: `tests/index.test.ts`

**Interfaces:**
- Produces: `toGroqSchema(schema: any): any`, `toGroqTools(declarations: any[]): any[]`, `generateWithFallback(groq: Groq, params: any, models: string[]): Promise<any>` — all exported from `src/cognition/groq-client.ts`. Tasks 2-5 import these by name.

- [ ] **Step 1: Add the dependency**

In `package.json`'s `"dependencies"` block, add (alphabetically, between `"express-rate-limit"` and `"helmet"`):

```json
    "groq-sdk": "^1.3.0",
```

Run: `npm install`
Expected: `groq-sdk` appears in `package-lock.json`, install succeeds with no peer-dependency errors.

**Before running `npm install`, re-check that `^1.3.0` is still the current stable release** (`npm view groq-sdk version`) — this plan was written against that exact version; if a newer version is out, use it, matching the same re-check discipline used for this codebase's other SDK dependency.

- [ ] **Step 2: Create the schema/tool translation functions**

Create `src/cognition/groq-client.ts`:

```ts
import Groq from "groq-sdk";
import { ObservationPlatform } from "../observation/index.js";

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
    return result;
  }
  return schema;
}

/**
 * Wraps this codebase's existing tool-declaration shape (the same objects
 * getAllToolDeclarations() already produces for Gemini) into Groq's
 * {type: "function", function: {...}} tool shape.
 */
export function toGroqTools(declarations: Array<{ name: string; description?: string; parameters?: any }>): any[] {
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
  throw lastError;
}
```

- [ ] **Step 3: Write the unit tests**

In `tests/index.test.ts`, add near the other module imports at the top of the file:

```ts
import { toGroqSchema, toGroqTools } from "../src/cognition/groq-client.js";
```

Then add a new test category at the end of the file:

```ts
// ---------- Groq Client Tests (pure functions, no network) ----------

registerTest("GroqClient", "toGroqSchema lowercases a simple type field", () => {
  const result = toGroqSchema({ type: "STRING", description: "x" });
  if (result.type !== "string") {
    throw new Error(`GroqClient: expected lowercase "string", got: ${JSON.stringify(result)}`);
  }
});

registerTest("GroqClient", "toGroqSchema recursively lowercases a nested object/array schema", () => {
  const geminiShaped = {
    type: "OBJECT",
    properties: {
      steps: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            step: { type: "STRING" },
            department: { type: "STRING" },
          },
          required: ["step", "department"],
        },
      },
    },
    required: ["steps"],
  };
  const result = toGroqSchema(geminiShaped);
  if (
    result.type !== "object" ||
    result.properties.steps.type !== "array" ||
    result.properties.steps.items.type !== "object" ||
    result.properties.steps.items.properties.step.type !== "string"
  ) {
    throw new Error(`GroqClient: expected fully recursive lowercasing, got: ${JSON.stringify(result)}`);
  }
  // Non-type fields must survive untouched.
  if (result.properties.steps.items.required?.[0] !== "step") {
    throw new Error("GroqClient: expected the 'required' array to survive untouched");
  }
});

registerTest("GroqClient", "toGroqSchema is idempotent on an already-lowercase (MCP-style) schema", () => {
  const alreadyLowercase = { type: "object", properties: { name: { type: "string" } }, required: ["name"] };
  const result = toGroqSchema(alreadyLowercase);
  if (result.type !== "object" || result.properties.name.type !== "string") {
    throw new Error(`GroqClient: expected an already-lowercase schema to pass through unchanged, got: ${JSON.stringify(result)}`);
  }
});

registerTest("GroqClient", "toGroqTools wraps a declaration in Groq's function-tool shape", () => {
  const declarations = [{ name: "search_web", description: "Search the web", parameters: { type: "OBJECT", properties: { query: { type: "STRING" } }, required: ["query"] } }];
  const result = toGroqTools(declarations);
  if (result.length !== 1 || result[0].type !== "function" || result[0].function.name !== "search_web") {
    throw new Error(`GroqClient: expected one function-shaped tool, got: ${JSON.stringify(result)}`);
  }
  if (result[0].function.parameters.type !== "object") {
    throw new Error("GroqClient: expected the wrapped parameters schema to be lowercased too");
  }
});
```

- [ ] **Step 4: Run the full suite and typecheck**

Run: `npm test`
Expected: all existing tests plus the 4 new `GroqClient` tests pass.

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src/cognition/groq-client.ts tests/index.test.ts
git commit -m "feat: add Groq client schema/tool translation and retry helper"
```

---

### Task 2: Classification/extraction functions to Groq

**Files:**
- Modify: `src/cognition/identity.ts` (`extractSelfReflection` only — `generateProactiveThought` is Task 3)
- Modify: `src/cognition/knowledge-graph.ts`
- Modify: `src/cognition/reflection.ts`
- Modify: `src/server.ts` (Groq client construction; the post-reply learning block)
- Modify: `src/cognition/live-voice.ts` (`bridgeVoiceSession`'s signature and its own learning block)
- Test: `tests/index.test.ts` (Groq-null degrade tests for the three rewritten functions)

**Interfaces:**
- Consumes: `toGroqSchema` from Task 1.
- Produces: `extractSelfReflection`, `extractAndStore`, `reflectAndLearn` all take `groq: Groq | null` instead of `ai: GoogleGenAI`. `bridgeVoiceSession` gains a new `groq: Groq | null` parameter (second position, after `ai`).

- [ ] **Step 1: Construct the Groq client in `server.ts`**

In `src/server.ts`, add near the top with the other SDK imports:

```ts
import Groq from "groq-sdk";
```

Find (around line 168-183):

```ts
// ---------- Gemini Client Initialization ----------
let ai: GoogleGenAI | null = null;
if (process.env.GEMINI_API_KEY) {
  ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      }
    }
  });
  observation.logTelemetry("info", "Cognition", "Gemini AI client successfully configured with API Key.");
} else {
  observation.logTelemetry("warn", "Cognition", "No GEMINI_API_KEY detected. Running AI features in simulated mode.");
}
briefing.configureAi(ai);
```

Replace with:

```ts
// ---------- Gemini Client Initialization (vision/multimodal only — see
// docs/superpowers/specs/2026-07-21-groq-provider-design.md) ----------
let ai: GoogleGenAI | null = null;
if (process.env.GEMINI_API_KEY) {
  ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      }
    }
  });
  observation.logTelemetry("info", "Cognition", "Gemini AI client successfully configured with API Key.");
} else {
  observation.logTelemetry("warn", "Cognition", "No GEMINI_API_KEY detected. Running AI features in simulated mode.");
}

// ---------- Groq Client Initialization (primary cloud tier) ----------
let groq: Groq | null = null;
if (process.env.GROQ_API_KEY) {
  groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  observation.logTelemetry("info", "Cognition", "Groq client successfully configured with API Key.");
} else {
  observation.logTelemetry("warn", "Cognition", "No GROQ_API_KEY detected. Groq features unavailable.");
}
```

(Task 3 adds `briefing.configureGroq(groq);` back in — it's intentionally left out here since `briefing.ts`'s `configureAi`/`getConfiguredAi` don't get renamed until that task; leaving the old `briefing.configureAi(ai);` line in place for now would still work but is redundant busywork since Task 3 replaces it outright — remove the old `briefing.configureAi(ai);` line entirely in this step, matching the diff shown above.)

- [ ] **Step 2: Rewrite `identity.ts`'s `extractSelfReflection`**

In `src/cognition/identity.ts`, find the import line:

```ts
import { GoogleGenAI, Type } from "@google/genai";
```

Replace with:

```ts
import { GoogleGenAI, Type } from "@google/genai";
import Groq from "groq-sdk";
import { toGroqSchema } from "./groq-client.js";
```

Find the full `extractSelfReflection` function:

```ts
export async function extractSelfReflection(ai: GoogleGenAI, userMessage: string, replyText: string): Promise<void> {
  try {
    const response = await ai.models.generateContent({
      model: "gemini-3.1-flash-lite",
      contents: [{
        role: "user",
        parts: [{
          text:
            "You are analyzing Jarvis's OWN reply below (not the user's message) for something Jarvis itself genuinely " +
            "expressed: a real opinion it formed, a commitment/promise it made, or a notable realization/observation about " +
            "itself or the conversation. Only report something if it's actually there in Jarvis's reply — do not invent " +
            "introspection that isn't present. Most turns have nothing like this; that's expected, return \"\" in that case.\n\n" +
            `User: ${userMessage}\n\nJarvis: ${replyText.slice(0, 1500)}`,
        }],
      }],
      config: {
        responseMimeType: "application/json",
        responseSchema: SELF_REFLECTION_SCHEMA,
      },
    });

    const parsed = JSON.parse(response.text || "{}");
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
```

Replace with:

```ts
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
```

Note: `SELF_REFLECTION_SCHEMA` itself (the `const` defined earlier in the file, using `Type.OBJECT`/`Type.STRING`) does **not** need to change — `toGroqSchema` converts it at the call site. Leave the schema constant exactly as it is (it's still used nowhere else, but keeping it in its original Gemini-typed form means no other code needs updating if it's ever reused).

- [ ] **Step 3: Rewrite `knowledge-graph.ts`'s `extractAndStore`**

In `src/cognition/knowledge-graph.ts`, find the import line:

```ts
import { GoogleGenAI, Type } from "@google/genai";
```

Replace with (`GoogleGenAI` is dropped — `extractAndStore` below is this file's only use of it, and it's being rewritten to `Groq` in this same step, so keeping the import would leave it dead; `Type` stays because `EXTRACTION_SCHEMA` still builds on `Type.OBJECT`/`Type.STRING`, converted to Groq's shape only at the call site via `toGroqSchema`):

```ts
import { Type } from "@google/genai";
import Groq from "groq-sdk";
import { toGroqSchema } from "./groq-client.js";
```

Find the full `extractAndStore` function:

```ts
export async function extractAndStore(ai: GoogleGenAI, userMessage: string, replyText: string): Promise<void> {
  try {
    const response = await ai.models.generateContent({
      model: "gemini-3.1-flash-lite",
      contents: [{
        role: "user",
        parts: [{
          text:
            "Extract any concrete, new facts and relationships about specific named entities (people, projects, tools, preferences, decisions, organizations) " +
            "from this exchange. Only include something if it was actually stated — never invent or infer beyond what's written. " +
            "If nothing concrete was said, return empty arrays.\n\n" +
            `User: ${userMessage}\n\nJarvis: ${replyText.slice(0, 1500)}`,
        }],
      }],
      config: {
        responseMimeType: "application/json",
        responseSchema: EXTRACTION_SCHEMA,
      },
    });

    const parsed = JSON.parse(response.text || "{}");
    const entities: { name: string; entityType: string; fact: string }[] = Array.isArray(parsed.entities) ? parsed.entities : [];
```

Replace with:

```ts
export async function extractAndStore(groq: Groq | null, userMessage: string, replyText: string): Promise<void> {
  if (!groq) return;
  try {
    const response = await groq.chat.completions.create({
      model: "openai/gpt-oss-20b",
      messages: [{
        role: "user",
        content:
          "Extract any concrete, new facts and relationships about specific named entities (people, projects, tools, preferences, decisions, organizations) " +
          "from this exchange. Only include something if it was actually stated — never invent or infer beyond what's written. " +
          "If nothing concrete was said, return empty arrays.\n\n" +
          `User: ${userMessage}\n\nJarvis: ${replyText.slice(0, 1500)}`,
      }],
      response_format: {
        type: "json_schema",
        json_schema: { name: "entity_extraction", schema: toGroqSchema(EXTRACTION_SCHEMA), strict: true },
      },
    });

    const parsed = JSON.parse(response.choices[0]?.message?.content || "{}");
    const entities: { name: string; entityType: string; fact: string }[] = Array.isArray(parsed.entities) ? parsed.entities : [];
```

(The rest of the function body — `relationships` parsing, the `entityIdByName` loop, `kgRepo` calls, the telemetry log, and the catch block — is unchanged. `EXTRACTION_SCHEMA` itself, still `Type`-based, is left exactly as-is — `toGroqSchema` converts it at the call site.)

- [ ] **Step 4: Rewrite `reflection.ts`'s `reflectAndLearn`**

In `src/cognition/reflection.ts`, find the import line:

```ts
import { GoogleGenAI, Type } from "@google/genai";
```

Replace with (`GoogleGenAI` is dropped — `reflectAndLearn` below is this file's only use of it, and it's being rewritten to `Groq` in this same step, so keeping the import would leave it dead; `Type` stays because `REFLECTION_SCHEMA` still builds on `Type.OBJECT`/`Type.STRING`, converted to Groq's shape only at the call site via `toGroqSchema`):

```ts
import { Type } from "@google/genai";
import Groq from "groq-sdk";
import { toGroqSchema } from "./groq-client.js";
```

Find the start of `reflectAndLearn` through its `generateContent` call:

```ts
export async function reflectAndLearn(
  ai: GoogleGenAI,
  userMessage: string,
  replyText: string
): Promise<void> {
  try {
    const response = await ai.models.generateContent({
      model: "gemini-3.1-flash-lite",
      contents: [{
        role: "user",
        parts: [{
          text:
            "Analyze this exchange between a user and Jarvis, an AI assistant. " +
            "Only report a coding style preference if the user actually stated or clearly implied one. " +
            "Only report a mistake if a real error/bug and its fix were actually discussed — not a hypothetical. " +
            "Leave any field empty (\"\" or 0) if it doesn't apply; do not invent content to fill the schema.\n\n" +
            `User: ${userMessage}\n\nJarvis: ${replyText.slice(0, 1500)}`,
        }],
      }],
      config: {
        responseMimeType: "application/json",
        responseSchema: REFLECTION_SCHEMA,
      },
    });

    const parsed = JSON.parse(response.text || "{}");
```

Replace with:

```ts
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
```

(The rest of the function body — `styleUpdate` construction, `learningEngine.updateStylePreference`/`logMistake` calls, and the catch block — is unchanged. `REFLECTION_SCHEMA` itself is left exactly as-is.)

- [ ] **Step 5: Update `server.ts`'s post-reply learning block**

In `src/server.ts`, find (around line 1062-1068, inside the main `/api/chat` handler, after a successful reply):

```ts
        reflectAndLearn(ai, message, fullReply).catch(() => {});
```
```ts
        knowledgeGraph.extractAndStore(ai, message, fullReply).catch(() => {});
```
```ts
        identity.extractSelfReflection(ai, message, fullReply).catch(() => {});
```

Replace each `ai` argument with `groq` (three separate one-word changes, in place — the surrounding lines and structure are unchanged):

```ts
        reflectAndLearn(groq, message, fullReply).catch(() => {});
        knowledgeGraph.extractAndStore(groq, message, fullReply).catch(() => {});
        identity.extractSelfReflection(groq, message, fullReply).catch(() => {});
```

- [ ] **Step 6: Update `live-voice.ts`'s `bridgeVoiceSession`**

In `src/cognition/live-voice.ts`, find the import line:

```ts
import { GoogleGenAI, Modality } from "@google/genai";
```

Replace with:

```ts
import { GoogleGenAI, Modality } from "@google/genai";
import Groq from "groq-sdk";
```

Find:

```ts
export async function bridgeVoiceSession(ai: GoogleGenAI, clientSocket: WebSocket, username: string): Promise<void> {
```

Replace with:

```ts
export async function bridgeVoiceSession(ai: GoogleGenAI, groq: Groq | null, clientSocket: WebSocket, username: string): Promise<void> {
```

(`ai` stays — it's still needed here for the actual Gemini Live voice API session and for `memoryStore.remember`, both out of this plan's scope; `groq` is added alongside it.)

Find:

```ts
        reflectAndLearn(ai, userText, replyText).catch(() => {});
        knowledgeGraph.extractAndStore(ai, userText, replyText).catch(() => {});
        identity.extractSelfReflection(ai, userText, replyText).catch(() => {});
```

Replace with:

```ts
        reflectAndLearn(groq, userText, replyText).catch(() => {});
        knowledgeGraph.extractAndStore(groq, userText, replyText).catch(() => {});
        identity.extractSelfReflection(groq, userText, replyText).catch(() => {});
```

- [ ] **Step 7: Update `bridgeVoiceSession`'s call site**

In `src/server.ts`, find:

```ts
    await liveVoice.bridgeVoiceSession(ai, ws, username);
```

Replace with:

```ts
    await liveVoice.bridgeVoiceSession(ai, groq, ws, username);
```

- [ ] **Step 8: Add Groq-null degrade tests for the three rewritten functions**

None of `extractSelfReflection`/`extractAndStore`/`reflectAndLearn` have a direct unit test today (confirmed via `grep -n "extractSelfReflection(\|extractAndStore(\|reflectAndLearn(" tests/index.test.ts` returning only the new tests added below). The design spec's Testing section calls for a degrade test on every rewritten call site confirming the Groq-null case — add one each.

In `tests/index.test.ts`, find the import line:

```ts
import { buildIdentityContext, generateProactiveThought } from "../src/cognition/identity.js";
```

Replace with:

```ts
import { buildIdentityContext, generateProactiveThought, extractSelfReflection } from "../src/cognition/identity.js";
import { extractAndStore } from "../src/cognition/knowledge-graph.js";
import { reflectAndLearn } from "../src/cognition/reflection.js";
```

Then add, near the existing `"Identity", "generateProactiveThought never fabricates..."` test:

```ts
registerTest("Identity", "extractSelfReflection no-ops with no Groq client", async () => {
  // Must return (not throw) immediately on the `if (!groq) return;` guard,
  // without ever touching the database or a Groq client.
  await extractSelfReflection(null, "hello", "some reply");
});

registerTest("KnowledgeGraph", "extractAndStore no-ops with no Groq client", async () => {
  await extractAndStore(null, "hello", "some reply");
});

registerTest("Learning", "reflectAndLearn no-ops with no Groq client", async () => {
  await reflectAndLearn(null, "hello", "some reply");
});
```

- [ ] **Step 9: Run the full suite and typecheck**

Run: `npm test`
Expected: all existing tests pass (no new tests added in this task beyond Task 1's).

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git add src/cognition/identity.ts src/cognition/knowledge-graph.ts src/cognition/reflection.ts src/cognition/live-voice.ts src/server.ts tests/index.test.ts
git commit -m "feat: switch classification/extraction LLM calls to Groq"
```

---

### Task 3: Generative functions to Groq

**Files:**
- Modify: `src/cognition/identity.ts` (`generateProactiveThought`)
- Modify: `src/execution/briefing.ts` (`synthesizeBriefing`, `generateBriefing`, `configureAi`/`getConfiguredAi` rename)
- Modify: `src/execution/scheduler.ts` (`startBriefingJob`, `startSelfReflectionJob`)
- Modify: `src/execution/tools.ts` (`get_briefing` case)
- Modify: `src/server.ts` (client wiring, job registration, remaining call sites)
- Test: `tests/index.test.ts` (Groq-null degrade test for `synthesizeBriefing`)

**Interfaces:**
- Consumes: nothing new from Task 1/2 beyond what's already imported.
- Produces: `generateProactiveThought` takes `groq: Groq | null` (was `ai: GoogleGenAI`, required). `briefing.ts` exports `configureGroq`/`getConfiguredGroq` (replacing `configureAi`/`getConfiguredAi`); `synthesizeBriefing`/`generateBriefing` take `groq: Groq | null`. `scheduler.ts`'s `startBriefingJob`/`startSelfReflectionJob` take `groq: Groq | null`.

- [ ] **Step 1: Rewrite `identity.ts`'s `generateProactiveThought`**

In `src/cognition/identity.ts` (already has the `Groq`/`toGroqSchema` imports added in Task 2), find the import line:

```ts
import { GoogleGenAI, Type } from "@google/genai";
```

Replace with (this rewrite is `generateProactiveThought`'s last use of `GoogleGenAI` in this file — `extractSelfReflection` was already switched to `Groq` in Task 2 — so drop it now rather than leave a dead import; `Type` stays for this function's inline schema literal below):

```ts
import { Type } from "@google/genai";
```

Then find:

```ts
export async function generateProactiveThought(ai: GoogleGenAI, minReflections = 3): Promise<ProactiveThoughtResult | null> {
```

Replace the signature with:

```ts
export async function generateProactiveThought(groq: Groq | null, minReflections = 3): Promise<ProactiveThoughtResult | null> {
```

Inside the function, find the `generateContent` call:

```ts
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
```

Replace with (this call needs prose-generation quality, not schema-strictness, so it uses the larger model — `if (!groq) return null;` also needs adding right after the existing `if (recent.length < minReflections) { ...; return null; }` check, before this try block, matching the function's existing early-return style):

```ts
    const response = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
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
```

Add the `if (!groq) return null;` guard: find

```ts
  if (recent.length < minReflections) {
    observation.logTelemetry("info", "Identity", `Skipping proactive thought — only ${recent.length} self-reflection(s) recorded so far (need ${minReflections}).`);
    return null;
  }

  try {
```

and replace with:

```ts
  if (recent.length < minReflections) {
    observation.logTelemetry("info", "Identity", `Skipping proactive thought — only ${recent.length} self-reflection(s) recorded so far (need ${minReflections}).`);
    return null;
  }
  if (!groq) return null;

  try {
```

- [ ] **Step 2: Rewrite `briefing.ts`'s configured-client singleton and both generation functions**

In `src/execution/briefing.ts`, find:

```ts
import { GoogleGenAI } from "@google/genai";
import { ObservationPlatform } from "../observation/index.js";
import * as emailIntegration from "../integrations/email.js";
import * as github from "../integrations/github.js";
import * as objectivesRepo from "../data/objectives-repo.js";

const observation = ObservationPlatform.getInstance();

// Set once from server.ts at startup so the get_briefing chat tool
// (tools.ts) can generate a real briefing without server.ts needing to
// export its module-scoped `ai` variable directly.
let configuredAi: GoogleGenAI | null = null;
export function configureAi(client: GoogleGenAI | null): void {
  configuredAi = client;
}
export function getConfiguredAi(): GoogleGenAI | null {
  return configuredAi;
}
```

Replace with:

```ts
import { ObservationPlatform } from "../observation/index.js";
import * as emailIntegration from "../integrations/email.js";
import * as github from "../integrations/github.js";
import * as objectivesRepo from "../data/objectives-repo.js";
import Groq from "groq-sdk";

const observation = ObservationPlatform.getInstance();

// Set once from server.ts at startup so the get_briefing chat tool
// (tools.ts) can generate a real briefing without server.ts needing to
// export its module-scoped `groq` variable directly.
let configuredGroq: Groq | null = null;
export function configureGroq(client: Groq | null): void {
  configuredGroq = client;
}
export function getConfiguredGroq(): Groq | null {
  return configuredGroq;
}
```

Find `synthesizeBriefing`:

```ts
export async function synthesizeBriefing(ai: GoogleGenAI | null, items: PrioritizedItem[], errors: string[]): Promise<string> {
  if (items.length === 0) {
    return errors.length > 0
      ? `Nothing new to report, though some sources couldn't be checked: ${errors.join("; ")}.`
      : "Nothing new since the last check — inbox and GitHub notifications are both clear.";
  }

  if (!ai) {
    const lines = items.map(i => `- [${i.urgency}] ${i.summary}`);
    return `Briefing (${items.length} item(s)):\n${lines.join("\n")}${errors.length ? `\n\nCouldn't check: ${errors.join("; ")}` : ""}`;
  }

  try {
    const response = await ai.models.generateContent({
      model: "gemini-3.1-flash-lite",
      contents: [{
        role: "user",
        parts: [{
          text:
            "You are JARVIS, styled after Tony Stark's AI in the Iron Man films: composed, dryly witty, " +
            "addressing the user as \"sir\" where it reads naturally. Write a short briefing paragraph " +
            "(3-5 sentences) summarizing these prioritized items, in that voice — concise and matter-of-fact, " +
            "not gushing. Lead with the highest-urgency items. Do not invent details not present below. " +
            "If nothing is urgent, say so plainly rather than manufacturing urgency.\n\n" +
            items.map(i => `[${i.urgency}] (${i.source}) ${i.summary}`).join("\n"),
        }],
      }],
    });
    return response.text || `Briefing (${items.length} item(s)) — synthesis returned empty, raw items: ${items.map(i => i.summary).join("; ")}`;
  } catch (err: any) {
    observation.logTelemetry("warn", "Briefing", `Gemini synthesis failed, falling back to plain list: ${err.message}`);
    const lines = items.map(i => `- [${i.urgency}] ${i.summary}`);
    return `Briefing (${items.length} item(s)):\n${lines.join("\n")}`;
  }
}

export async function generateBriefing(ai: GoogleGenAI | null, username: string): Promise<{ text: string; itemCount: number; items: PrioritizedItem[] }> {
  const signals = await collectSignals(username);
  const items = prioritizeSignals(signals);
  const errors = [signals.emailError, signals.githubError, signals.objectivesError].filter(Boolean) as string[];
  const text = await synthesizeBriefing(ai, items, errors);
  return { text, itemCount: items.length, items };
}
```

Replace with:

```ts
export async function synthesizeBriefing(groq: Groq | null, items: PrioritizedItem[], errors: string[]): Promise<string> {
  if (items.length === 0) {
    return errors.length > 0
      ? `Nothing new to report, though some sources couldn't be checked: ${errors.join("; ")}.`
      : "Nothing new since the last check — inbox and GitHub notifications are both clear.";
  }

  if (!groq) {
    const lines = items.map(i => `- [${i.urgency}] ${i.summary}`);
    return `Briefing (${items.length} item(s)):\n${lines.join("\n")}${errors.length ? `\n\nCouldn't check: ${errors.join("; ")}` : ""}`;
  }

  try {
    const response = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{
        role: "user",
        content:
          "You are JARVIS, styled after Tony Stark's AI in the Iron Man films: composed, dryly witty, " +
          "addressing the user as \"sir\" where it reads naturally. Write a short briefing paragraph " +
          "(3-5 sentences) summarizing these prioritized items, in that voice — concise and matter-of-fact, " +
          "not gushing. Lead with the highest-urgency items. Do not invent details not present below. " +
          "If nothing is urgent, say so plainly rather than manufacturing urgency.\n\n" +
          items.map(i => `[${i.urgency}] (${i.source}) ${i.summary}`).join("\n"),
      }],
    });
    return response.choices[0]?.message?.content || `Briefing (${items.length} item(s)) — synthesis returned empty, raw items: ${items.map(i => i.summary).join("; ")}`;
  } catch (err: any) {
    observation.logTelemetry("warn", "Briefing", `Groq synthesis failed, falling back to plain list: ${err.message}`);
    const lines = items.map(i => `- [${i.urgency}] ${i.summary}`);
    return `Briefing (${items.length} item(s)):\n${lines.join("\n")}`;
  }
}

export async function generateBriefing(groq: Groq | null, username: string): Promise<{ text: string; itemCount: number; items: PrioritizedItem[] }> {
  const signals = await collectSignals(username);
  const items = prioritizeSignals(signals);
  const errors = [signals.emailError, signals.githubError, signals.objectivesError].filter(Boolean) as string[];
  const text = await synthesizeBriefing(groq, items, errors);
  return { text, itemCount: items.length, items };
}
```

- [ ] **Step 3: Update `scheduler.ts`'s job functions**

In `src/execution/scheduler.ts`, find:

```ts
import type { GoogleGenAI } from "@google/genai";
```

Replace with:

```ts
import type Groq from "groq-sdk";
```

Find:

```ts
export function startBriefingJob(ai: GoogleGenAI | null, intervalMs = 60 * 60 * 1000): NodeJS.Timeout {
  return registerJob("proactive-briefing", intervalMs, async () => {
    const result = await briefing.generateBriefing(ai, "admin");
```

Replace with:

```ts
export function startBriefingJob(groq: Groq | null, intervalMs = 60 * 60 * 1000): NodeJS.Timeout {
  return registerJob("proactive-briefing", intervalMs, async () => {
    const result = await briefing.generateBriefing(groq, "admin");
```

Find (further down in the same function):

```ts
    if (freshItems.length > 0) {
      const freshText = await briefing.synthesizeBriefing(ai, freshItems, []);
```

Replace with:

```ts
    if (freshItems.length > 0) {
      const freshText = await briefing.synthesizeBriefing(groq, freshItems, []);
```

Find:

```ts
export function startSelfReflectionJob(ai: GoogleGenAI | null, intervalMs = 6 * 60 * 60 * 1000): NodeJS.Timeout {
  return registerJob("proactive-self-reflection", intervalMs, async () => {
    if (!ai) return;
    const result = await identity.generateProactiveThought(ai);
```

Replace with:

```ts
export function startSelfReflectionJob(groq: Groq | null, intervalMs = 6 * 60 * 60 * 1000): NodeJS.Timeout {
  return registerJob("proactive-self-reflection", intervalMs, async () => {
    if (!groq) return;
    const result = await identity.generateProactiveThought(groq);
```

- [ ] **Step 4: Update `tools.ts`'s `get_briefing` case**

In `src/execution/tools.ts`, find:

```ts
      case "get_briefing": {
        const result = await briefing.generateBriefing(briefing.getConfiguredAi(), username);
```

Replace with:

```ts
      case "get_briefing": {
        const result = await briefing.generateBriefing(briefing.getConfiguredGroq(), username);
```

- [ ] **Step 5: Update `server.ts`'s remaining call sites**

Find (added back in Task 2's Step 1, right after the Groq client construction block):

```ts
// ---------- Groq Client Initialization (primary cloud tier) ----------
let groq: Groq | null = null;
if (process.env.GROQ_API_KEY) {
  groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  observation.logTelemetry("info", "Cognition", "Groq client successfully configured with API Key.");
} else {
  observation.logTelemetry("warn", "Cognition", "No GROQ_API_KEY detected. Groq features unavailable.");
}
```

Add immediately after it:

```ts
briefing.configureGroq(groq);
```

Find:

```ts
    const result = await identity.generateProactiveThought(ai);
```

Replace with:

```ts
    const result = await identity.generateProactiveThought(groq);
```

Find:

```ts
    const result = await briefing.generateBriefing(ai, req.username);
```

Replace with:

```ts
    const result = await briefing.generateBriefing(groq, req.username);
```

Find (the boot-time job registration):

```ts
  scheduler.startBriefingJob(ai);
  scheduler.startSelfReflectionJob(ai);
```

Replace with:

```ts
  scheduler.startBriefingJob(groq);
  scheduler.startSelfReflectionJob(groq);
```

- [ ] **Step 6: Search for any other reference to the renamed `briefing.ts` functions**

Run: `grep -rn "briefing\.configureAi\|briefing\.getConfiguredAi" src/` and confirm zero results — every call site was covered by Steps 4-5 above. This is the same kind of verification step used to catch unanticipated call sites in earlier phases.

- [ ] **Step 7: Add a Groq-null degrade test for `synthesizeBriefing`**

`synthesizeBriefing` has no direct unit test today — only its sibling `prioritizeSignals` is tested (confirmed via `grep -n "synthesizeBriefing\|generateBriefing" tests/index.test.ts` returning only the new test added below). The design spec's Testing section calls for a degrade test on every rewritten call site confirming the Groq-null case.

In `tests/index.test.ts`, find:

```ts
import { prioritizeSignals } from "../src/execution/briefing.js";
```

Replace with:

```ts
import { prioritizeSignals, synthesizeBriefing } from "../src/execution/briefing.js";
```

Then add, near the existing `"Briefing"`-category tests:

```ts
registerTest("Briefing", "synthesizeBriefing falls back to a plain list with no Groq client", async () => {
  const items = [{ id: "email:1", source: "email" as const, urgency: "high" as const, summary: "test item" }];
  const text = await synthesizeBriefing(null, items, []);
  if (!text.includes("test item")) {
    throw new Error(`Briefing: expected the plain-list fallback to include the raw item summary, got: "${text}"`);
  }
});
```

- [ ] **Step 8: Run the full suite and typecheck**

Run: `npm test`
Expected: all existing tests pass, plus the new `synthesizeBriefing` degrade test.

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add src/cognition/identity.ts src/execution/briefing.ts src/execution/scheduler.ts src/execution/tools.ts src/server.ts tests/index.test.ts
git commit -m "feat: switch generative LLM calls (proactive thought, briefing synthesis) to Groq"
```

---

### Task 4: `departments.ts` and `AutonomousExecutive` to Groq

**Files:**
- Modify: `src/execution/departments.ts` (all 5 `generateContent` calls)
- Modify: `src/execution/autonomous_executive.ts` (add a `groq` field/constructor param/getInstance param)
- Modify: `src/server.ts` (the `AutonomousExecutive.getInstance` call site)

**Interfaces:**
- Consumes: `toGroqSchema` from Task 1.
- Produces: every exported function in `departments.ts` (`decomposeObjective`, `runResearch`, `draftCodeChanges`, `reviewCodeDiff`) takes `groq: Groq | null` instead of `ai: GoogleGenAI | null`. `AutonomousExecutive.getInstance(observation?, ai?, groq?)` gains a third parameter; the class gains a `private groq: Groq | null` field used everywhere it previously used `this.ai` when calling into `departments.ts`.

- [ ] **Step 1: Update `departments.ts`'s imports**

In `src/execution/departments.ts`, find:

```ts
import { GoogleGenAI, Type } from "@google/genai";
```

Replace with (`GoogleGenAI` is dropped, not kept alongside `Type` — every function in this file switches its client parameter from `ai: GoogleGenAI | null` to `groq: Groq | null` in the steps below, so `GoogleGenAI` would otherwise be left as a dead import; `Type` stays because the existing schema constants like `DEPARTMENT_DECOMPOSITION_SCHEMA` still build on `Type.OBJECT`/`Type.STRING` and are only converted to Groq's shape at the call site via `toGroqSchema`):

```ts
import { Type } from "@google/genai";
import Groq from "groq-sdk";
import { toGroqSchema } from "../cognition/groq-client.js";
```

- [ ] **Step 2: Rewrite `decomposeObjective`**

Find:

```ts
export async function decomposeObjective(
  objective: string,
  ai: GoogleGenAI | null,
  offlineMode: boolean
): Promise<DepartmentStep[]> {
  if (!ai || offlineMode) {
    return [{ step: objective, department: "research" }];
  }

  try {
    const response = await ai.models.generateContent({
      model: "gemini-3.1-flash-lite",
      contents: `Break this objective down into 1-5 concrete steps, each tagged with the department that owns it: "${objective}"`,
      config: {
        responseMimeType: "application/json",
        responseSchema: DEPARTMENT_DECOMPOSITION_SCHEMA,
      },
    });

    const parsed = JSON.parse(response.text || "{}");
```

Replace with:

```ts
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
```

(The rest of the function body — `rawSteps`/`valid`/the qa-without-coding safety net/the catch block — is unchanged.)

- [ ] **Step 3: Rewrite `runResearch`**

Find the function signature:

```ts
export async function runResearch(objective: string, ai: GoogleGenAI | null): Promise<ResearchResult> {
  if (!ai) {
```

Replace with:

```ts
export async function runResearch(objective: string, groq: Groq | null): Promise<ResearchResult> {
  if (!groq) {
```

Find the lookup-planning call:

```ts
    const lookupResponse = await ai.models.generateContent({
      model: "gemini-3.1-flash-lite",
      contents: `Plan what to research for this objective: "${objective}"`,
      config: {
        responseMimeType: "application/json",
        responseSchema: RESEARCH_LOOKUPS_SCHEMA,
      },
    });
    const parsed = JSON.parse(lookupResponse.text || "{}");
```

Replace with:

```ts
    const lookupResponse = await groq.chat.completions.create({
      model: "openai/gpt-oss-20b",
      messages: [{ role: "user", content: `Plan what to research for this objective: "${objective}"` }],
      response_format: {
        type: "json_schema",
        json_schema: { name: "research_lookups", schema: toGroqSchema(RESEARCH_LOOKUPS_SCHEMA), strict: true },
      },
    });
    const parsed = JSON.parse(lookupResponse.choices[0]?.message?.content || "{}");
```

Find the synthesis call (later in the same function):

```ts
    const synthesis = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: `Synthesize these raw research findings into a clear, concise report for the objective "${objective}". Findings:\n\n${findings.join("\n\n")}`,
    });
    return { summary: synthesis.text || findings.join("\n\n") };
```

Replace with:

```ts
    const synthesis = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{
        role: "user",
        content: `Synthesize these raw research findings into a clear, concise report for the objective "${objective}". Findings:\n\n${findings.join("\n\n")}`,
      }],
    });
    return { summary: synthesis.choices[0]?.message?.content || findings.join("\n\n") };
```

- [ ] **Step 4: Rewrite `draftCodeChanges`**

Find:

```ts
export async function draftCodeChanges(
  objective: string,
  researchSummary: string,
  directionNotes: string,
  ai: GoogleGenAI | null
): Promise<CodeDraftResult> {
  if (!ai) {
    return { ok: false, error: "No capable model is available right now to draft real code — Gemini must be reachable for this." };
  }
  try {
    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents:
        "Draft real, complete file changes for this repository to accomplish the objective below. Only include files " +
        "that genuinely need to be created or changed. Write complete, working file contents, not snippets or " +
        "placeholders.\n\n" +
        `Objective: ${objective}\n\nResearch findings:\n${researchSummary}\n\nConfirmed direction from the user:\n${directionNotes}`,
      config: {
        responseMimeType: "application/json",
        responseSchema: CODE_DRAFT_SCHEMA,
      },
    });
    const parsed = JSON.parse(response.text || "{}");
```

Replace with:

```ts
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
```

(The rest of the function — file filtering, summary fallback, catch block — is unchanged.)

- [ ] **Step 5: Rewrite `reviewCodeDiff`**

Find:

```ts
export async function reviewCodeDiff(objective: string, files: DraftedFile[], ai: GoogleGenAI | null): Promise<string> {
  if (!ai) {
    return "No capable model was available to review this change — please review the diff yourself before merging.";
  }
  try {
    const filesText = files.map((f) => `--- ${f.path} ---\n${f.content}`).join("\n\n");
    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents:
        "Review this drafted code change against the objective it's meant to accomplish. Flag anything concerning — " +
        "bugs, missing error handling, security issues, or ways it doesn't actually satisfy the objective. Be concise.\n\n" +
        `Objective: ${objective}\n\nFiles:\n${filesText}`,
    });
    return response.text || "Review completed with no specific feedback.";
```

Replace with:

```ts
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
```

- [ ] **Step 6: Add a `groq` field to `AutonomousExecutive`**

In `src/execution/autonomous_executive.ts`, find:

```ts
import { ObservationPlatform } from "../observation/index.js";
import { GoogleGenAI } from "@google/genai";
import { MindKernel } from "../cognition/kernel/kernel.js";
```

Replace with:

```ts
import { ObservationPlatform } from "../observation/index.js";
import { GoogleGenAI } from "@google/genai";
import Groq from "groq-sdk";
import { MindKernel } from "../cognition/kernel/kernel.js";
```

Find:

```ts
export class AutonomousExecutive {
  private static instance: AutonomousExecutive | null = null;
  private observation: ObservationPlatform;
  private ai: GoogleGenAI | null;

  private constructor(observation: ObservationPlatform, ai: GoogleGenAI | null) {
    this.observation = observation;
    this.ai = ai;
  }

  // A singleton (like the other cognition engines) rather than a plain
  // constructor so tools.ts's decompose_plan tool can reach the same
  // instance server.ts already created at startup with the real ai client,
  // instead of needing a circular import back into server.ts.
  public static getInstance(observation?: ObservationPlatform, ai?: GoogleGenAI | null): AutonomousExecutive {
    if (!this.instance) {
      if (!observation) {
        throw new Error("AutonomousExecutive.getInstance() called before server.ts initialized it");
      }
      this.instance = new AutonomousExecutive(observation, ai ?? null);
    }
    return this.instance;
  }
```

Replace with:

```ts
export class AutonomousExecutive {
  private static instance: AutonomousExecutive | null = null;
  private observation: ObservationPlatform;
  private ai: GoogleGenAI | null;
  private groq: Groq | null;

  private constructor(observation: ObservationPlatform, ai: GoogleGenAI | null, groq: Groq | null) {
    this.observation = observation;
    this.ai = ai;
    this.groq = groq;
  }

  // A singleton (like the other cognition engines) rather than a plain
  // constructor so tools.ts's decompose_plan/confirm_build_direction tools
  // can reach the same instance server.ts already created at startup with
  // the real ai/groq clients, instead of needing a circular import back
  // into server.ts.
  public static getInstance(observation?: ObservationPlatform, ai?: GoogleGenAI | null, groq?: Groq | null): AutonomousExecutive {
    if (!this.instance) {
      if (!observation) {
        throw new Error("AutonomousExecutive.getInstance() called before server.ts initialized it");
      }
      this.instance = new AutonomousExecutive(observation, ai ?? null, groq ?? null);
    }
    return this.instance;
  }
```

- [ ] **Step 7: Update every internal `departments.*` call inside `AutonomousExecutive` to pass `this.groq`**

Within `executeObjective`, find each of these three call sites and change their AI-client argument from `this.ai` to `this.groq`:

```ts
    const steps = await departments.decomposeObjective(objective, this.ai, kernel.offlineMode);
```
becomes
```ts
    const steps = await departments.decomposeObjective(objective, this.groq, kernel.offlineMode);
```

```ts
      const research = await departments.runResearch(objective, this.ai);
```
(the one inside the `if (hasCodingStep)` branch) becomes
```ts
      const research = await departments.runResearch(objective, this.groq);
```

```ts
    const research = await departments.runResearch(step, this.ai);
```
(the one inside the no-coding-step loop) becomes
```ts
    const research = await departments.runResearch(step, this.groq);
```

Within `confirmDirection`, find:

```ts
    const draft = await departments.draftCodeChanges(
      confirmed.objective,
      confirmed.research_summary || "",
      directionNotes,
      this.ai
    );
```

Replace with:

```ts
    const draft = await departments.draftCodeChanges(
      confirmed.objective,
      confirmed.research_summary || "",
      directionNotes,
      this.groq
    );
```

- [ ] **Step 8: Update `server.ts`'s `AutonomousExecutive.getInstance` call site**

Find:

```ts
const executive = AutonomousExecutive.getInstance(observation, ai);
```

Replace with:

```ts
const executive = AutonomousExecutive.getInstance(observation, ai, groq);
```

This line must appear **after** both `ai` and `groq` are constructed (Task 2 already placed `groq`'s construction before this line in file order — confirm with `grep -n "^let ai\|^let groq\|AutonomousExecutive.getInstance(observation" src/server.ts` that the client constructions come first).

- [ ] **Step 9: Update `departments.ts`'s existing degrade-safety tests for the renamed parameter**

In `tests/index.test.ts`, find the 5 `"Departments"` category tests added in an earlier phase (`decomposeObjective falls back...`, `runResearch degrades cleanly...`, `draftCodeChanges degrades cleanly...`, `reviewCodeDiff degrades cleanly...`). Their calls already pass `null` (or `{} as any` for the offline-mode-with-a-client test) as the AI-client argument — these tests require **no code changes**, since passing `null` for a parameter renamed from `ai` to `groq` is still valid and still exercises the same "no client" degrade path. Run `npm test` (next step) to confirm they still pass as-is; this step is verification, not a code change.

- [ ] **Step 10: Run the full suite and typecheck**

Run: `npm test`
Expected: all existing tests pass, including the unchanged `Departments` and `Executive 2.0` categories.

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 11: Commit**

```bash
git add src/execution/departments.ts src/execution/autonomous_executive.ts src/server.ts
git commit -m "feat: switch departments.ts and AutonomousExecutive to Groq"
```

---

### Task 5: Main chat loop — execution chain and Groq tool-calling branch

**Files:**
- Modify: `src/server.ts`
- Modify: `src/observation/index.ts` (new `groqApiCalls` metric)

**Interfaces:**
- Consumes: `toGroqTools`, `generateWithFallback` from Task 1.
- Produces: the `/api/chat` handler's execution chain becomes `LocalLLM → Groq → Gemini → Simulated` (was `LocalLLM → Gemini → Simulated`); a new `else if (step === "Groq")` branch mirrors the existing `Gemini` branch's tool-calling loop using Groq's message/tool-call format.

- [ ] **Step 1: Extend the execution-chain construction**

Find:

```ts
    if (kernel.offlineMode) {
      if (kernel.llmMode === "strictly-online") {
        executionChain.push("Gemini");
      } else if (kernel.llmMode === "strictly-local") {
        executionChain.push("LocalLLM");
      } else if (kernel.llmMode === "online-first") {
        executionChain.push("LocalLLM");
      } else {
        // default local-first
        executionChain.push("LocalLLM");
      }
    } else {
      if (kernel.llmMode === "strictly-online") {
        executionChain.push("Gemini");
      } else if (kernel.llmMode === "strictly-local") {
        executionChain.push("LocalLLM");
      } else if (kernel.llmMode === "online-first") {
        executionChain.push("Gemini", "LocalLLM");
      } else {
        // local-first (default)
        executionChain.push("LocalLLM", "Gemini");
      }
    }
```

Replace with (only the non-offline branches change — `kernel.offlineMode` means no internet at all, so Groq, like Gemini, has no place in any of those branches, matching existing behavior exactly):

```ts
    if (kernel.offlineMode) {
      if (kernel.llmMode === "strictly-online") {
        executionChain.push("Gemini");
      } else if (kernel.llmMode === "strictly-local") {
        executionChain.push("LocalLLM");
      } else if (kernel.llmMode === "online-first") {
        executionChain.push("LocalLLM");
      } else {
        // default local-first
        executionChain.push("LocalLLM");
      }
    } else {
      if (kernel.llmMode === "strictly-online") {
        executionChain.push("Groq", "Gemini");
      } else if (kernel.llmMode === "strictly-local") {
        executionChain.push("LocalLLM");
      } else if (kernel.llmMode === "online-first") {
        executionChain.push("Groq", "Gemini", "LocalLLM");
      } else {
        // local-first (default)
        executionChain.push("LocalLLM", "Groq", "Gemini");
      }
    }
```

- [ ] **Step 2: Fix the two backend-promotion blocks so an image always wins the front slot**

Find:

```ts
    // A tool-shaped request ("check that GitHub repo", "send an email...")
    // sent to the local model is exactly the fabrication risk the honest
    // local prompt above is a safety net for — but the better outcome is to
    // not need that net at all. When Gemini is actually available and the
    // user hasn't explicitly forced strictly-local, prefer it first so the
    // request gets real capability instead of an honest decline.
    if (
      ai &&
      kernel.llmMode !== "strictly-local" &&
      looksToolShaped(message) &&
      executionChain[0] === "LocalLLM" &&
      executionChain.includes("Gemini")
    ) {
      const idx = executionChain.indexOf("Gemini");
      executionChain.splice(idx, 1);
      executionChain.unshift("Gemini");
    }

    // A live camera frame is only genuinely usable by Gemini's multimodal
    // input — the local llama-cpp path has no vision support here. Same
    // "don't let a backend fake capability it doesn't have" rule as above.
    if (
      ai &&
      image &&
      kernel.llmMode !== "strictly-local" &&
      executionChain[0] === "LocalLLM" &&
      executionChain.includes("Gemini")
    ) {
      const idx = executionChain.indexOf("Gemini");
      executionChain.splice(idx, 1);
      executionChain.unshift("Gemini");
    }
```

Replace with:

```ts
    // A tool-shaped request ("check that GitHub repo", "send an email...")
    // sent to the local model is exactly the fabrication risk the honest
    // local prompt above is a safety net for — but the better outcome is to
    // not need that net at all. Groq can call tools (unlike local), so
    // prefer it first so the request gets real capability instead of an
    // honest decline. Guarded on `executionChain[0] !== "Groq"` rather than
    // `=== "LocalLLM"` specifically so this is a no-op (not a crash) if
    // Groq's already at the front for some other reason.
    if (
      groq &&
      kernel.llmMode !== "strictly-local" &&
      looksToolShaped(message) &&
      executionChain[0] !== "Groq" &&
      executionChain.includes("Groq")
    ) {
      const idx = executionChain.indexOf("Groq");
      executionChain.splice(idx, 1);
      executionChain.unshift("Groq");
    }

    // A live camera frame is only genuinely usable by Gemini's multimodal
    // input — neither the local llama-cpp path nor Groq's hosted text
    // models have vision support. Checked AFTER the tool-shaped promotion
    // above (not instead of it) and guarded on `!== "Gemini"` (not
    // `executionChain[0] === "LocalLLM"`) so an image always wins the front
    // slot even when the same message also looks tool-shaped and Groq was
    // just promoted there a moment ago.
    if (
      ai &&
      image &&
      kernel.llmMode !== "strictly-local" &&
      executionChain[0] !== "Gemini" &&
      executionChain.includes("Gemini")
    ) {
      const idx = executionChain.indexOf("Gemini");
      executionChain.splice(idx, 1);
      executionChain.unshift("Gemini");
    }
```

- [ ] **Step 3: Add a `groqApiCalls` metric counter**

`incrementMetric`'s parameter type is `keyof typeof metrics`, so calling it with a key that doesn't exist on the `metrics` object is a compile error, not a silent no-op — the new `Groq` branch (Step 4 below) needs a real counter to increment, matching how the existing `Gemini` branch calls `observation.incrementMetric("geminiApiCalls")`.

In `src/observation/index.ts`, find:

```ts
  public metrics = {
    totalRequests: 0,
    geminiApiCalls: 0,
    geminiSuccessRate: 1.0,
    averageLatencyMs: 0,
    knowledgeRetrievals: 0,
    graphUpdates: 0,
    errorsLogged: 0,
  };
```

Replace with:

```ts
  public metrics = {
    totalRequests: 0,
    geminiApiCalls: 0,
    groqApiCalls: 0,
    geminiSuccessRate: 1.0,
    averageLatencyMs: 0,
    knowledgeRetrievals: 0,
    graphUpdates: 0,
    errorsLogged: 0,
  };
```

- [ ] **Step 4: Add imports for the Groq helpers**

Find:

```ts
import { GoogleGenAI, Content, FunctionCall } from "@google/genai";
```

Replace with:

```ts
import { GoogleGenAI, Content, FunctionCall } from "@google/genai";
import { toGroqTools, generateWithFallback as generateGroqWithFallback } from "./cognition/groq-client.js";
```

(Aliased to `generateGroqWithFallback` to keep it visually distinct from the existing Gemini-specific `generateContentWithFallback` at its many call sites in this same file.)

- [ ] **Step 5: Add the `Groq` execution-chain branch**

Find the start of the existing `Gemini` branch:

```ts
      else if (step === "Gemini") {
```

Add a new branch immediately **before** it (so it reads `if (step === "LocalLLM") {...} else if (step === "Groq") {...} else if (step === "Gemini") {...}`):

```ts
      else if (step === "Groq") {
        if (groq) {
          try {
            observation.incrementMetric("groqApiCalls");
            session.updateState({
              currentThought: "Querying Groq",
              executiveStatus: "Executing",
              activeCapability: "Groq LLM Generation"
            }, observation);

            const groqTools = toGroqTools(getAllToolDeclarations());
            const messages: any[] = [
              { role: "system", content: systemInstruction },
              { role: "user", content: message },
            ];
            const groqModels = ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"];

            let response = await generateGroqWithFallback(groq, { messages, tools: groqTools }, groqModels);
            let toolCalls = response.choices[0]?.message?.tool_calls || [];
            let guard = 0;

            while (toolCalls.length > 0 && guard < 3) {
              guard++;
              const assistantMessage = response.choices[0].message;
              messages.push({
                role: "assistant",
                content: assistantMessage.content,
                tool_calls: assistantMessage.tool_calls,
              });

              const toolResponseMessages: any[] = [];
              for (const call of toolCalls) {
                let args: Record<string, any> = {};
                try {
                  args = JSON.parse(call.function.arguments || "{}");
                } catch {
                  // Malformed arguments from the model — executeTool below
                  // fails cleanly on whatever this leaves args as, same as
                  // a genuinely empty-args call would.
                }

                const result = await executeTool(
                  call.function.name || "",
                  args,
                  req.username,
                  ai,
                  kernel.localLlmEndpoint,
                  { alreadyAttached: false, supportsRoundTrip: true }
                );

                // Mirrors the Gemini branch's identical handling below.
                if (result.needsClientAction === "capture_screen") {
                  res.write("data: request_screen\n\n");
                  res.write("data: [DONE]\n\n");
                  res.end();
                  success = true;
                  succeededStep = "Groq";
                  return;
                }

                if (result.displayDirective) {
                  res.write(`data: display: ${JSON.stringify(result.displayDirective)}\n\n`);
                }

                toolCallsExecuted.push({ name: result.name, ok: result.ok });
                toolResponseMessages.push({
                  role: "tool",
                  tool_call_id: call.id,
                  content: JSON.stringify(result.ok ? { output: result.output } : { error: result.error }),
                });
              }
              messages.push(...toolResponseMessages);

              response = await generateGroqWithFallback(groq, { messages, tools: groqTools }, groqModels);
              toolCalls = response.choices[0]?.message?.tool_calls || [];
            }

            const finalText = response.choices[0]?.message?.content || "";
            if (finalText) {
              for (const word of finalText.split(" ")) {
                fullReply += word + " ";
                res.write(`data: ${word} \n\n`);
              }
              success = true;
              succeededStep = "Groq";
            }
          } catch (err: any) {
            observation.logTelemetry("warn", "Cognition", `Groq generation failed: ${err.message || err}`);
          }
        }
      }
```

- [ ] **Step 6: Search for any other reference to the old two-backend-only execution chain assumption**

Run: `grep -n '"LocalLLM"\|"Gemini"\|"Groq"' src/server.ts` and read every match. Confirm: (a) the `executionChain.push(...)` sites match Step 1's new shape exactly; (b) both promotion blocks from Step 2 are present and in the stated order (tool-shaped check first, image check second); (c) the new `else if (step === "Groq")` branch from Step 5 sits between the `"LocalLLM"` branch and the `"Gemini"` branch in the execution loop; (d) nothing elsewhere in the file assumes the execution chain only ever contains `"LocalLLM"`/`"Gemini"`/`"Simulated"` (e.g. a `switch` or hardcoded length check) — this codebase has no such assumption today (the loop is a plain `for (const step of executionChain)`), but this step is the explicit verification that adding a fourth value didn't break one.

- [ ] **Step 7: Run the full suite and typecheck**

Run: `npm test`
Expected: all existing tests pass — this task adds no new tests of its own (the main chat loop's live tool-calling round trip has never been unit-tested for either existing backend, consistent with this codebase's convention; live verification at deploy time covers it, same as every prior phase's Gemini/MCP/GitHub live round-trip).

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/server.ts src/observation/index.ts
git commit -m "feat: add Groq to the main chat loop's execution chain and tool-calling"
```
