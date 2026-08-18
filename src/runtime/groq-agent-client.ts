import type { CognitionRouter } from "./cognition-router.js";
import { toGroqSchema, generateWithFallback } from "./groq-client.js";

/**
 * The coding agent's tool-calling backend — Groq, not NVIDIA NIM. Kept as
 * its own dedicated module (mirroring github.ts/websearch.ts/wikipedia.ts's
 * one-integration-per-file convention, and the nvidia-client.ts module this
 * replaces) rather than folded into groq-client.ts, which serves a
 * different purpose (schema conversion + generateWithFallback for the
 * main chat backend). Reuses the same Groq client instance server.ts
 * already constructs — no separate API key or client to manage.
 */

// Three real, live-verified dead ends before landing here:
// 1. kimi-k2 isn't actually available on this Groq account at all — GET
//    /openai/v1/models doesn't list any moonshotai/* model, and a real
//    coding session attempt failed with a 404 "model_not_found".
// 2. openai/gpt-oss-120b IS available and DOES have real tool-calling
//    support, but its free-tier rate limit is extremely tight — 8,000
//    tokens/minute — a real coding session hit "Rate limit exceeded
//    (8000 TPM)" after only ~34,000 total tokens across the whole run,
//    nowhere near MAX_TOKENS_PER_SESSION.
// 3. openai/gpt-oss-20b avoids the rate limit, but a real multi-turn
//    session against it hit Groq's own "Parsing failed. The model
//    generated output that could not be parsed" (code: output_parse_failed)
//    partway through — the gpt-oss family appears to produce plain-text
//    reasoning output Groq's tool-call parser can't handle once a
//    conversation has grown past a few turns of tool exchanges, even
//    though the identical model handles a single-shot structured-output
//    call fine (see reviewCodeDiff in departments.ts, which still uses it
//    successfully for exactly that reason).
//
// 4th dead end, found 2026-08-18: llama-3.3-70b-versatile/
// llama-3.1-8b-instant — chosen at the time as "already this codebase's
// proven-reliable multi-turn tool-calling workhorse" — were removed from
// Groq's live model catalog entirely sometime after that (live-verified:
// GET /openai/v1/models no longer lists either; every call 404s
// model_not_found). This is what silently broke every Groq-routed call in
// the app, including chat, and is why chat degraded toward the fabricated
// Simulated fallback.
//
// Landed here instead: openai/gpt-oss-120b primary (dead end #2 above is a
// real constraint, not disqualifying — 8,000 TPM is tight but survivable
// for a single coding session if it has a fallback), paired with
// qwen/qwen3.6-27b as fallback — a separate model family on a separate
// quota pool from the gpt-oss models, live-verified 2026-08-18 for
// multi-turn tool-calling with no parsing failures. This does NOT reuse
// gpt-oss-20b as the fallback despite dead-end #3 predating this pairing:
// #3's parsing failure is specific to gpt-oss-20b's own multi-turn
// tool-call output, and pairing it with gpt-oss-120b wouldn't avoid that
// risk the way a genuinely different model family does.
// Overridable via JARVIS_CODING_AGENT_MODEL (a single model, no fallback)
// without a code change if a stronger option proves reliable later — check
// actual availability, rate limits, and real multi-turn tool-calling
// behavior (not just a single test call) before trusting a model's name
// alone. Provider-prefixed ("groq:<model>") since CognitionRouter.generateWithFallback
// requires it — an unprefixed entry is silently skipped as malformed
// (see cognition-router.ts's "expected provider:model" log line), which
// would degrade every coding-agent session straight to the local engine.
// JARVIS_CODING_AGENT_MODEL overrides must include the same prefix.
export const DEFAULT_MODELS = ["groq:openai/gpt-oss-120b", "groq:qwen/qwen3.6-27b"];

export interface AgentToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface AgentMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: AgentToolCall[];
  tool_call_id?: string;
}

export interface AgentTool {
  type: "function";
  function: { name: string; description: string; parameters: any };
}

export interface AgentChatResult {
  content: string | null;
  toolCalls: AgentToolCall[] | null;
  // Groq's OpenAI-compatible `usage.total_tokens` — null if the SDK
  // response omitted it. This is what lets coding-agent.ts enforce a real
  // spend ceiling instead of only bounding a session by turn count.
  totalTokens: number | null;
  // Which model in the fallback chain actually answered — read from the
  // Groq response's own `model` field. Lets a caller record which model
  // did the work without threading its own bookkeeping through every
  // call site. null only if the response itself omitted the field.
  modelUsed: string | null;
}

// Extracts the {content, toolCalls, totalTokens} shape this module's
// callers actually need from a Groq chat-completions response — split out
// from callGroqAgentChat so it's testable without a real network call.
// Operates defensively even though the SDK's own TypeScript types already
// describe this shape: those types are compile-time hints, not a runtime
// guarantee the API actually returned well-formed data.
export function parseGroqAgentResponse(data: any): AgentChatResult {
  const message = data?.choices?.[0]?.message;
  if (!message) {
    throw new Error("Groq response had no message content.");
  }
  // A negative or fractional value would be truthy in coding-agent.ts's
  // `if (response.totalTokens)` check, get added to (in the negative case,
  // subtracted from) the in-memory session token counter, and then get
  // silently dropped by incrementTokenUsage's own `tokens <= 0` guard when
  // persisting — meaning a malformed value could quietly erode the budget
  // counter in memory while never showing up in the persisted total.
  // Treating anything but a genuine non-negative safe integer as "unknown"
  // (null) keeps a malformed response from ever reaching that counter at all.
  const rawTotalTokens = data?.usage?.total_tokens;
  return {
    content: message.content ?? null,
    toolCalls: Array.isArray(message.tool_calls) && message.tool_calls.length > 0 ? message.tool_calls : null,
    totalTokens: typeof rawTotalTokens === "number" && Number.isSafeInteger(rawTotalTokens) && rawTotalTokens >= 0 ? rawTotalTokens : null,
    modelUsed: typeof data?.model === "string" ? data.model : null,
  };
}

export async function callGroqAgentChat(
  router: CognitionRouter,
  username: string,
  messages: AgentMessage[],
  tools: AgentTool[],
  modelOrder?: string[]
): Promise<AgentChatResult> {
  // An explicit override means the operator wants exactly that model, not
  // a fallback chain they didn't ask for.
  const models = process.env.JARVIS_CODING_AGENT_MODEL ? [process.env.JARVIS_CODING_AGENT_MODEL] : (modelOrder && modelOrder.length > 0 ? modelOrder : DEFAULT_MODELS);
  // Groq's strict tool-schema validation requires lowercase JSON-Schema
  // type names and an explicit additionalProperties on every object node
  // (see toGroqSchema's own comment) — this module's tool definitions
  // already satisfy both by construction, but running them through the
  // same converter every other Groq tool-calling call site uses keeps that
  // guarantee structural rather than relying on every tool definition
  // getting it right by hand.
  const groqTools = tools.map((t) => ({
    type: t.type,
    function: { ...t.function, parameters: toGroqSchema(t.function.parameters) },
  }));
  const response = await generateWithFallback(
    router,
    username,
    { messages: messages as any, tools: groqTools as any, tool_choice: "auto" },
    models
  );
  return parseGroqAgentResponse(response);
}
