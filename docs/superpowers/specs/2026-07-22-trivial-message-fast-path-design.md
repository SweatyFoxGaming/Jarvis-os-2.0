# Trivial-Message Fast Path — Design Spec

## Context

This is the deliberately-scoped-down remainder of a larger "operationalize the attention
economy" ask. The full ask (a numeric Attention Score driving a routing tree that could bypass
the LLM's own judgment for "trivial"/"moderate" requests) was rejected during brainstorming: this
codebase's one existing message-classification heuristic, `looksToolShaped` in
`src/capabilities/tools.ts`, is deliberately used *only* for routing (which backend to try first)
and never to decide whether to execute a tool — its own doc comment is explicit that real
execution always goes through the LLM's native function-calling judgment. A keyword-driven bypass
of that judgment risks exactly the fabrication/misfire problem this codebase has been careful to
avoid everywhere else (a keyword match doesn't reliably distinguish "what's on my calendar" from
"I read an interesting calendar app review today," and can't extract real parameters like a date
or event title).

What survives is a narrower, safe, real optimization: for messages that are unambiguously
conversational filler (greetings, acknowledgments — "thanks", "good morning", "sounds good"), skip
the tool-declaration overhead and prefer the fastest model, without ever touching what the LLM is
allowed to decide for any other message.

## Architecture

**New: `looksTrivial(message: string): boolean`**, in `src/capabilities/tools.ts` alongside
`looksToolShaped` (same file, same "message-classification heuristic informing routing" purpose).

```ts
const TRIVIAL_PHRASES = [
  "hi", "hello", "hey", "good morning", "good afternoon", "good evening",
  "thanks", "thank you", "ok", "okay", "sounds good", "got it", "cool",
  "nice", "great", "perfect", "awesome", "yes", "no", "yep", "nope", "sure",
];
const TRIVIAL_MAX_LENGTH = 50;

export function looksTrivial(message: string): boolean {
  const trimmed = message.trim();
  if (trimmed.length > TRIVIAL_MAX_LENGTH) return false;
  const lower = trimmed.toLowerCase();
  return TRIVIAL_PHRASES.some(p => lower === p || lower.startsWith(p + " ") || lower.startsWith(p + ","));
}
```

The length cap plus exact/prefix match (not `.includes()`, unlike `looksToolShaped`) is
deliberate: `looksToolShaped` tolerates substring matches anywhere in a long message because a
false positive there only affects which backend is *tried first* — the LLM still decides for
itself. `looksTrivial` controls whether tools are *available at all* for that turn, so it needs a
tighter match: "thanks, can you check my GitHub for open issues?" must not qualify (it's long and
the meaningful content follows the greeting), while "thanks!" and "good morning" should.

**Precedence: `looksToolShaped` is checked first, always.** A message must be tool-shaped-negative
*and* trivial-positive to take the fast path — this guarantees a message like "thanks, what's on
my calendar today?" (which matches both a trivial phrase and a tool trigger word) is never
misclassified as trivial, since tool-shaped is the stricter, capability-preserving signal and
always wins.

**Server-side change, Groq branch only** (`src/server.ts`'s `else if (step === "Groq")` branch;
Gemini's branch is untouched — same "prove it narrow, expand later" approach the Groq migration
itself used):

- When `!looksToolShaped(message) && looksTrivial(message)`: omit the `tools` key from the
  `groq.chat.completions.create(...)` call entirely (not an empty array — omitting the key is how
  the API is told no tools are available for this turn), and reorder the fallback model list to
  `["llama-3.1-8b-instant", "llama-3.3-70b-versatile"]` (fast model first, larger one as fallback)
  instead of today's `["llama-3.3-70b-versatile", "llama-3.1-8b-instant"]`.
- Everything else about the branch (the tool-calling loop's shape, `view_screen`/`display_content`
  handling, streaming) is unchanged — those code paths simply never execute for a trivial message
  since there are no tools to call, but the code doesn't need to change to know that; an LLM
  response with no `tools` present will just never return `tool_calls`.

A real, measurable side benefit beyond token/latency savings: during live Groq verification
earlier, `llama-3.3-70b-versatile` was observed to occasionally invent a malformed tool call for a
plain message (a real, reproduced bug, not hypothetical) — a trivial message with no tools
attached at all structurally cannot trigger that failure mode, since there's nothing to
hallucinate calling.

## Explicitly out of scope

- Any bypass of the LLM's own decision-making for non-trivial messages. `looksToolShaped`'s
  behavior and meaning are completely unchanged.
- Gemini's branch, and the local-LLM branch. Only Groq's tool-calling branch is touched.
- The other four items from the original broader ask (a sandboxed micro-kernel, parallel
  Self/World state stores outside Postgres, a numeric Attention Score, an autonomous
  adaptation-loop that merges to main without review) — explicitly declined or deferred
  separately, not part of this spec.
- The capability-manifest schema (Zod validation for capability packages) — a separate, unrelated
  follow-up the user also approved, tracked as its own spec+plan cycle, not bundled here.

## Testing

Unit tests (matching the existing `GroqClient`/`Departments`-style hand-rolled test convention in
`tests/index.test.ts`):
- `looksTrivial` returns `true` for each of a handful of representative trivial phrases ("thanks",
  "good morning", "ok").
- `looksTrivial` returns `false` for a long message that happens to start with a trivial phrase
  ("thanks, can you check my GitHub for open issues?").
- `looksTrivial` returns `false` for a short message that isn't in the trivial list ("what time is
  it").
- A combined precedence test: a message matching both `looksToolShaped` and `looksTrivial` (e.g.
  "thanks, what's on my calendar today?") — confirm the call site's actual precedence logic (not
  just `looksTrivial` in isolation) treats it as tool-shaped, not trivial to fast-path.
- The `server.ts` Groq branch's fast-path behavior itself (whether `tools` is included, model
  order) is exercised the same way this codebase already handles the main chat loop's live
  round-trip: verified manually at deploy time, not unit-tested — consistent with how the
  Gemini/Groq branches have never had a unit test for their live tool-calling behavior, only their
  degrade paths.

## Decisions made during brainstorming

- **Cost-optimization only, never a capability bypass** — chosen explicitly over "real bypass for
  the clearest cases" after naming the concrete misfire risk (ambiguous phrasing, unextractable
  parameters) that keyword-only dispatch would reintroduce into a codebase that has otherwise been
  careful to keep the LLM as the actual decision-maker for anything consequential.
- **Exact/prefix match with a length cap, not substring match** — deliberately stricter than
  `looksToolShaped`'s substring match, because this heuristic controls tool *availability*, not
  just backend *preference*.
- **`looksToolShaped` always takes precedence over `looksTrivial`** — capability preservation wins
  any ambiguous case.
- **Groq branch only, Gemini/local untouched** — same narrow-first, expand-later discipline as the
  Groq provider migration itself.
