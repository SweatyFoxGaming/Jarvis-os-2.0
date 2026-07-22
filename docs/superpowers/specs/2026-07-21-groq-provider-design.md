# Groq as Primary Cloud LLM Provider — Design Spec

## Context

Jarvis's cloud LLM tier is Gemini, on the free tier — measured live at 20 requests/day
for `gemini-3.5-flash`, exhausted mid-session during ordinary use. Every real
capability (GitHub, calendar, files, commands, MCP servers, standing objectives, the
research/coding departments) is wired exclusively through Gemini's function-calling —
the bundled local model (`llama-cpp`, currently a 2.7B Phi-2 variant) has no tool
support and is measured at 130+ seconds per plain-chat reply on this machine's
CPU-only hardware (no usable GPU). So today, "real capability" and "Gemini
specifically" are the same thing, and Gemini's free tier is the actual ceiling on how
much Jarvis can do in a day.

Groq's free tier is dramatically more generous and faster: 1,000-14,400 requests/day
depending on model (50-720x Gemini's daily limit), served on custom LPU hardware at
roughly 300+ tokens/sec. `gpt-oss-20b`/`gpt-oss-120b` support **strict** JSON-schema
structured output (guaranteed schema compliance) — matching what every
`responseSchema`-based Gemini call in this codebase already relies on.

Gemini is not being removed: it's the only backend here with vision/multimodal
support (the live camera-frame chat feature), so it stays configured, narrowed to
that one role.

## Architecture

**New dependency:** `groq-sdk` (Groq's official OpenAI-compatible client) — matches
how `@google/genai` is already used as a real SDK, not raw `fetch`, for the same
reasons (correct request/response shaping, no reimplementing streaming parsing).

**New module: `src/cognition/groq-client.ts`** — owns:
- `getGroqClient(): Groq | null` — lazily constructs a client from `GROQ_API_KEY`,
  returns `null` if unset (mirrors how `ai: GoogleGenAI | null` already works).
- `toGroqSchema(schema: any): any` — recursively lowercases every `type` field in a
  schema tree. This single function normalizes both of this codebase's existing
  schema shapes: Gemini's `Type` enum values (`"OBJECT"`, `"STRING"`, ...) and MCP
  servers' tool schemas (already lowercase, standard JSON Schema, per the MCP
  capability architecture phase) both become Groq's expected lowercase JSON Schema —
  `"OBJECT".toLowerCase() === "object"` and `"object".toLowerCase() === "object"`,
  so the same function is correct and idempotent for both sources without needing to
  special-case which one it's given.
- `toGroqTools(declarations: FunctionDeclaration[]): any[]` — wraps each declaration
  as `{ type: "function", function: { name, description, parameters: toGroqSchema(...) } }`,
  the shape `getAllToolDeclarations()`'s output needs for Groq's `tools` parameter.
- `generateWithFallback(groq, params, models: string[])` — same multi-model retry
  shape as `server.ts`'s existing `generateContentWithFallback`, generalized for
  Groq's client.

**Two categories of call site:**

1. **Five files with structured-JSON/plain-text generation, no vision, no tools**
   (`identity.ts` ×2 calls, `knowledge-graph.ts`, `reflection.ts`, `briefing.ts`) —
   switch entirely to Groq. Each function's `ai: GoogleGenAI` parameter is renamed to
   `groq: Groq`; the call body changes from
   `ai.models.generateContent({model, contents: [...], config: {responseSchema}})`
   to `groq.chat.completions.create({model, messages: [...], response_format: {type: "json_schema", json_schema: {name, schema: toGroqSchema(...), strict: true}}})`
   (or no `response_format` at all for `briefing.ts`'s plain-text call). Model choice
   is split by task nature, not by which file the call lives in:
   `gpt-oss-20b` for the three genuine classification/extraction calls
   (`identity.ts`'s `extractSelfReflection` judging whether a real opinion/commitment
   was expressed, `knowledge-graph.ts`'s entity extraction, `reflection.ts`'s
   style/mistake judgment) — strict schema compliance matters more than raw
   generation quality here. `llama-3.3-70b-versatile` for the two calls that are
   genuinely generative even though one of them happens to wrap its output in a
   trivial one-field JSON schema: `identity.ts`'s `generateProactiveThought` (the
   schema is just `{thought: string}` — the actual task is crafting a genuine,
   well-voiced reflective thought, a text-quality problem, not a classification one)
   and `briefing.ts`'s prose synthesis.

2. **`departments.ts`'s five calls** — same treatment, same rename
   (`ai: GoogleGenAI | null` → `groq: Groq | null`). Model choice: `gpt-oss-20b` for
   `decomposeObjective` and `runResearch`'s lookup-planning call (structured
   classification tasks); `llama-3.3-70b-versatile` for `runResearch`'s synthesis,
   `draftCodeChanges`, and `reviewCodeDiff` (generation-quality tasks — drafting real
   code and reviewing it benefit from the larger, more capable model, not the
   schema-strict one).

3. **The main `/api/chat` loop (`server.ts`)** — the one place needing real care,
   since it uniquely combines tool-calling, manual word-by-word streaming, and
   vision. Concretely:
   - The execution chain becomes `LocalLLM → Groq → Gemini → Simulated` (was
     `LocalLLM → Gemini → Simulated`).
   - The existing "promote a backend to the front of the chain" logic (currently:
     promote Gemini above LocalLLM when the message `looksToolShaped` or an image is
     attached) splits in two: promote **Groq** to the front for `looksToolShaped`
     (Groq supports tool-calling, so this removes the *reason* Gemini needed
     promoting for text-only tool use); keep promoting **Gemini** to the front only
     when an image is actually attached (the one case only it can serve).
   - A new `else if (step === "Groq")` branch, structurally mirroring the existing
     `Gemini` branch's tool-calling loop (guard-limited to 3 rounds, same shape) but
     using Groq/OpenAI's message format: `tool_calls` on the assistant message
     (`function.arguments` is a JSON **string**, not an object — needs `JSON.parse`),
     answered with `{ role: "tool", tool_call_id, content: JSON.stringify(result) }`
     messages appended before the next call, rather than Gemini's
     `functionResponse`-part shape. Tool declarations come from
     `toGroqTools(getAllToolDeclarations())`. This branch does **not** request
     `response_format: json_schema` (plain chat + tools), so it doesn't hit Groq's
     documented "structured outputs don't work with tools" constraint — this
     codebase's chat loop already fakes streaming by word-splitting a fully-awaited
     response rather than using either provider's native token streaming, so no
     streaming-related constraint applies either.
   - `view_screen`'s `needsClientAction` and `display_content`'s `displayDirective`
     relaying (today handled inline in the Gemini branch) get the identical
     treatment in the Groq branch — same `executeTool` call, same SSE frame writes.

## Error handling

- Every one of the 11 rewritten call sites keeps this codebase's existing
  degrade-safety shape exactly: wrapped in `try/catch`, logs via
  `observation.logTelemetry("warn", ...)`, and falls back to whatever that function
  already falls back to today (raw findings, a plain list, `null`, an honest "no
  capable model" string) — no site's failure behavior changes, only which provider it
  calls.
- `getGroqClient()` returning `null` (no `GROQ_API_KEY` set) is a normal, expected
  state on a fresh install — every caller already null-checks its `ai`/`groq`
  parameter the same way `ai: GoogleGenAI | null` is null-checked today.
- The chat loop's new `Groq` step only runs `if (groq)`, mirroring the existing
  `if (ai)` guard on the `Gemini` step — an unset key simply removes that step from
  the execution chain, falling through to the next one.

## Testing

Same convention as every phase so far: the schema-translation helpers
(`toGroqSchema`, `toGroqTools`) are pure functions with no network dependency — get
real unit tests asserting the exact lowercase conversion on a nested schema (object
containing an array of objects, to exercise recursion) and confirming idempotency on
an already-lowercase MCP-style schema. The 11 rewritten generation call sites keep
their existing no-AI-client degrade-safety tests (already passing, unaffected by the
provider swap) plus a new degrade test each confirming the *Groq*-null case behaves
identically. The chat loop's new `Groq` tool-calling branch is exercised the same way
the existing `Gemini` branch always has been — live-verified manually at deploy time,
not unit-tested (this codebase has never unit-tested either provider's live
round-trip, only its degrade paths).

## Decisions made during brainstorming

- **Groq becomes primary; Gemini is not removed**, narrowed specifically to vision —
  the only capability it has that Groq's hosted text models don't.
- **`groq-sdk` (a real client), not raw `fetch`** — matches the existing precedent
  set by `@google/genai`, the only other LLM-tier dependency in this codebase (every
  *peripheral* integration — GitHub, web search, TTS — uses plain `fetch`, but the
  core reasoning providers get real SDKs).
- **Model choice per call site is deliberate, not uniform**: `gpt-oss-20b` (strict
  schema, cheaper/faster) for classification/extraction tasks;
  `llama-3.3-70b-versatile` for generation-quality tasks (prose synthesis, code
  drafting, code review). Using the biggest model everywhere would waste the
  free-tier's more constrained daily allowance on tasks that don't need it.
- **`toGroqSchema`'s lowercase-everything approach was chosen over two separate
  translators** (one for Gemini's `Type` enum, one treating MCP schemas as
  passthrough) specifically because `.toLowerCase()` is naturally idempotent on
  already-correct input — one function, provably safe for both sources, instead of
  two functions that could silently drift apart from each other over time.
- **The chat loop's tool-calling promotion logic changes what gets promoted, not
  whether promotion happens** — preserves the existing, already-reviewed reasoning
  for *why* certain requests shouldn't run on the local model (no tool support, no
  vision), just retargets the beneficiary of that reasoning from scarce Gemini to
  generous Groq.
