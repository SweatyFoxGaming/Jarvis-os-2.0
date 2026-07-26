import Groq from "groq-sdk";
import { toGroqSchema } from "./groq-client.js";

/**
 * The coding agent's tool-calling backend — Groq, not NVIDIA NIM. Kept as
 * its own dedicated module (mirroring github.ts/websearch.ts/wikipedia.ts's
 * one-integration-per-file convention, and the nvidia-client.ts module this
 * replaces) rather than folded into groq-client.ts, which serves a
 * different purpose (schema conversion + generateWithFallback for the
 * main chat backend). Reuses the same Groq client instance server.ts
 * already constructs — no separate API key or client to manage.
 */

// moonshotai/kimi-k2-instruct: chosen for strong agentic tool-calling and
// coding performance on Groq's free tier — see the live-verification
// findings in this session that led to switching off NVIDIA NIM (its
// default model unreliably wrote empty files and intermittently rejected
// well-formed tool-calling requests outright). Overridable via
// JARVIS_CODING_AGENT_MODEL without a code change, same precedent as
// NVIDIA_MODEL before it.
const DEFAULT_MODEL = "moonshotai/kimi-k2-instruct";

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
  };
}

export async function callGroqAgentChat(
  groq: Groq,
  messages: AgentMessage[],
  tools: AgentTool[]
): Promise<AgentChatResult> {
  const model = process.env.JARVIS_CODING_AGENT_MODEL || DEFAULT_MODEL;
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
  const response = await groq.chat.completions.create({
    model,
    messages: messages as any,
    tools: groqTools as any,
    tool_choice: "auto",
  });
  return parseGroqAgentResponse(response);
}
