# Trivial-Message Fast Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** For unambiguous conversational filler (greetings, acknowledgments), skip tool-declaration overhead and prefer the fastest Groq model — without ever changing what the LLM is allowed to decide for any other message.

**Architecture:** One new pure function (`looksTrivial`) alongside the existing `looksToolShaped` heuristic in `src/capabilities/tools.ts`, consumed by one conditional branch in `server.ts`'s Groq tool-calling step that omits the `tools` parameter and reorders the model fallback list when a message is trivial-and-not-tool-shaped.

**Tech Stack:** TypeScript, the existing `tests/index.test.ts` hand-rolled test harness.

## Global Constraints

- **`looksToolShaped` always takes precedence over `looksTrivial`.** A message is only eligible for the fast path if `!looksToolShaped(message) && looksTrivial(message)` — this exact conjunction, checked in this order, everywhere it's used.
- **No change to `looksToolShaped` itself, or to any other backend's (Gemini, LocalLLM) behavior.** Only the Groq branch's tool-calling step in `server.ts` changes.
- **`looksTrivial` uses exact/prefix match with a length cap, not `looksToolShaped`'s substring match** — because this heuristic controls tool *availability*, not just backend preference, so it needs to be much less prone to false positives.
- Match existing code style: `TRIVIAL_PHRASES` as a flat `string[]` (not `TOOL_TRIGGER_WORDS`'s per-tool grouping, since there's only one destination behavior here, not per-tool routing), placed directly below `TOOL_TRIGGER_WORDS` in the same file, matching its existing doc-comment style.

---

### Task 1: `looksTrivial` in `tools.ts`

**Files:**
- Modify: `src/capabilities/tools.ts`
- Test: `tests/index.test.ts`

**Interfaces:**
- Produces: `looksTrivial(message: string): boolean`, exported from `src/capabilities/tools.ts`. Task 2 imports it by name alongside the existing `looksToolShaped` import.

- [ ] **Step 1: Write the failing tests**

In `tests/index.test.ts`, find the existing import line:

```ts
import { executeTool, getAllToolDeclarations } from "../src/capabilities/tools.js";
```

Replace with:

```ts
import { executeTool, getAllToolDeclarations, looksTrivial, looksToolShaped } from "../src/capabilities/tools.js";
```

Then add a new test category near the end of the file, right before the `// ---------- Execution Main Block ----------` comment:

```ts
// ---------- Trivial-Message Fast Path Tests ----------

registerTest("ToolRouting", "looksTrivial recognizes a short greeting", () => {
  if (!looksTrivial("good morning")) {
    throw new Error("ToolRouting: expected \"good morning\" to be classified as trivial");
  }
});

registerTest("ToolRouting", "looksTrivial recognizes a short acknowledgment with trailing punctuation", () => {
  if (!looksTrivial("thanks!")) {
    throw new Error("ToolRouting: expected \"thanks!\" to be classified as trivial");
  }
});

registerTest("ToolRouting", "looksTrivial rejects a long message that happens to start with a trivial phrase", () => {
  if (looksTrivial("thanks, can you check my GitHub for open issues?")) {
    throw new Error("ToolRouting: a substantive request starting with \"thanks\" must not be classified as trivial");
  }
});

registerTest("ToolRouting", "looksTrivial rejects a short message that isn't a recognized trivial phrase", () => {
  if (looksTrivial("what time is it")) {
    throw new Error("ToolRouting: a short but substantive question must not be classified as trivial");
  }
});

registerTest("ToolRouting", "looksToolShaped takes precedence over looksTrivial for an ambiguous message", () => {
  const message = "thanks, what's on my calendar today?";
  // This is the precedence contract every call site must honor: check
  // looksToolShaped first, and only treat a message as eligible for the
  // trivial fast path when it is BOTH tool-shaped-negative AND trivial.
  const eligibleForFastPath = !looksToolShaped(message) && looksTrivial(message);
  if (eligibleForFastPath) {
    throw new Error("ToolRouting: a message matching a tool trigger word must never be treated as trivial, even if it also matches a trivial phrase");
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `looksTrivial is not a function` (or a TypeScript compile error, since `looksTrivial` doesn't exist yet).

- [ ] **Step 3: Implement `looksTrivial`**

In `src/capabilities/tools.ts`, find the end of the existing `looksToolShaped` function:

```ts
export function looksToolShaped(message: string): boolean {
  const lower = message.toLowerCase();
  return Object.values(TOOL_TRIGGER_WORDS).some(words => words.some(w => lower.includes(w)));
}
```

Add immediately after it:

```ts

/**
 * Narrower and stricter than looksToolShaped on purpose: that heuristic only
 * ever affects which backend is tried first (the LLM still decides
 * everything for itself), so a substring match anywhere in the message is
 * an acceptable false-positive rate. This one controls whether tools are
 * attached to the request AT ALL for a Groq turn — a false positive here
 * would silently remove real tool capability from a substantive request, so
 * it requires the trivial phrase to be the message's actual content (exact
 * match, or the message's first word(s) followed by a space/comma), not
 * merely present somewhere inside a longer message, and caps message length
 * so a genuine multi-part request can never qualify no matter how it opens.
 */
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

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — all 5 new `ToolRouting` tests, plus all existing tests (94 total: 89 existing + 5 new).

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/capabilities/tools.ts tests/index.test.ts
git commit -m "feat: add looksTrivial heuristic for the trivial-message fast path"
```

---

### Task 2: Wire the fast path into the Groq branch

**Files:**
- Modify: `src/server.ts`

**Interfaces:**
- Consumes: `looksTrivial` from Task 1.
- Produces: no new exports — this is a behavior change inside the existing `else if (step === "Groq")` branch.

- [ ] **Step 1: Import `looksTrivial`**

Find:

```ts
import { getAllToolDeclarations, executeTool, looksToolShaped } from "./capabilities/tools.js";
```

Replace with:

```ts
import { getAllToolDeclarations, executeTool, looksToolShaped, looksTrivial } from "./capabilities/tools.js";
```

- [ ] **Step 2: Make tool-attachment and model order conditional on the fast path**

Find (inside the `else if (step === "Groq")` branch):

```ts
            const groqTools = toGroqTools(getAllToolDeclarations());
            const messages: any[] = [
              { role: "system", content: systemInstruction },
              { role: "user", content: message },
            ];
            const groqModels = ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"];

            let response = await generateGroqWithFallback(groq, { messages, tools: groqTools }, groqModels);
```

Replace with:

```ts
            // Trivial conversational filler ("thanks", "good morning") never
            // needs a tool — skip attaching the tool schema at all (real
            // token savings, and a message with no tools present structurally
            // cannot trigger the tool-hallucination failure mode observed
            // live during Groq verification) and prefer the faster model.
            // looksToolShaped always wins any ambiguous case: a message must
            // be BOTH tool-shaped-negative AND trivial to take this path.
            const isFastPath = !looksToolShaped(message) && looksTrivial(message);
            const groqTools = isFastPath ? null : toGroqTools(getAllToolDeclarations());
            const messages: any[] = [
              { role: "system", content: systemInstruction },
              { role: "user", content: message },
            ];
            const groqModels = isFastPath
              ? ["llama-3.1-8b-instant", "llama-3.3-70b-versatile"]
              : ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"];

            let response = await generateGroqWithFallback(
              groq,
              groqTools ? { messages, tools: groqTools } : { messages },
              groqModels
            );
```

The rest of the branch (the `while (toolCalls.length > 0 ...)` loop, `view_screen`/`display_content` handling, final streaming) is completely unchanged — a response with no `tools` in the request will never come back with `tool_calls`, so the loop body simply never executes for a fast-path message; no other line in this branch needs to change.

- [ ] **Step 3: Run tsc and the test suite**

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npm test`
Expected: `94 / 94 Tests Passed` (unchanged from Task 1 — this task adds no new tests of its own; the live Groq round-trip behavior is verified manually at deploy time, consistent with how this exact branch's tool-calling behavior has been handled since it was first built).

- [ ] **Step 4: Commit**

```bash
git add src/server.ts
git commit -m "feat: skip tool schema and prefer the fast model for trivial Groq messages"
```
