import { ObservationPlatform } from "../kernel/observation.js";

const observation = ObservationPlatform.getInstance();
const NVIDIA_API_URL = "https://integrate.api.nvidia.com/v1/chat/completions";

// meta/llama-3.1-70b-instruct is NVIDIA NIM's most broadly available
// OpenAI-tool-calling-compatible model at the time this was written.
// Overridable via NVIDIA_MODEL without a code change, since the design
// spec explicitly leaves the exact model unverified until live testing.
const DEFAULT_MODEL = "meta/llama-3.1-70b-instruct";

export class NvidiaIntegrationError extends Error {
  constructor(message: string, public status = 500) {
    super(message);
  }
}

export interface NvidiaToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface NvidiaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: NvidiaToolCall[];
  tool_call_id?: string;
}

export interface NvidiaTool {
  type: "function";
  function: { name: string; description: string; parameters: any };
}

export interface NvidiaChatResult {
  content: string | null;
  toolCalls: NvidiaToolCall[] | null;
  // OpenAI-compatible `usage.total_tokens` — null if the endpoint omitted
  // it (some OpenAI-compatible backends don't always include usage). This
  // is what lets coding-agent.ts enforce a real spend ceiling instead of
  // only bounding a session by turn count.
  totalTokens: number | null;
}

// Extracts the {content, toolCalls, totalTokens} shape this module's
// callers actually need from a raw OpenAI-compatible chat-completions
// response body — split out from callNvidiaChat so it's testable without a
// real network call.
export function parseNvidiaChatResponse(data: any): NvidiaChatResult {
  const message = data?.choices?.[0]?.message;
  if (!message) {
    throw new NvidiaIntegrationError("NVIDIA NIM response had no message content.");
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

export async function callNvidiaChat(
  apiKey: string,
  messages: NvidiaMessage[],
  tools: NvidiaTool[]
): Promise<NvidiaChatResult> {
  const model = process.env.NVIDIA_MODEL || DEFAULT_MODEL;
  const res = await fetch(NVIDIA_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ model, messages, tools, tool_choice: "auto" }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    observation.logTelemetry("warn", "Cognition", `NVIDIA NIM request failed: ${res.status} ${body}`);
    throw new NvidiaIntegrationError(`NVIDIA NIM API error (${res.status}): ${body}`, res.status);
  }

  const data = await res.json();
  return parseNvidiaChatResponse(data);
}
