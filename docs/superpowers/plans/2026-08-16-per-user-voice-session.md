# Per-User Voice Session Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the local-voice turn-processing pipeline (`voice-session.ts` + its daemon bridge `audio-client.ts`) genuinely multi-user — any number of concurrent sessions, each isolated to its own daemon connection and its own transcript/reply/audio events, correctly scoped to the real username who spoke — with zero producer/UI required yet (that's a separate, later sub-project).

**Architecture:** Every voice-pipeline bus event (`voice:transcript`, `voice:reply`, `voice:audio-chunk`, `voice:error`, `voice:queued`) gains a required `sessionId` + `username` field. `voice-session.ts`'s single shared `voice:transcript` subscription reads identity off each event instead of a fixed `DEFAULT_USERNAME`/deps override. `audio-client.ts`'s `startAudioClient` becomes per-session (takes `sessionId`/`username`, stamps them on every publish, filters its `voice:reply` subscription to its own session) instead of one global singleton — correctness for the daemon connection itself comes for free, since the daemon already isolates each socket connection's utterance buffer. A new `voice-session-manager.ts` owns session lifecycle (`createVoiceSession`/`destroyVoiceSession`), replacing the old boot-time singleton wiring in `server.ts`.

**Tech Stack:** TypeScript, Node's built-in `net`/`crypto` modules, the existing in-process `EventBus`, this codebase's own `registerTest`-based test runner (`tests/index.test.ts`).

**Spec:** `docs/superpowers/specs/2026-08-16-per-user-voice-session-design.md`

## Global Constraints

- Every voice-pipeline bus event payload must carry `sessionId: string` and (where applicable) `username: string` — no event may omit either.
- No daemon-side (`daemon/voice_engine.py`) changes — the daemon's existing per-connection isolation is sufficient; this plan only removes the assumption in the Node layer that there's one connection for the whole process.
- No producer (mic capture, wake-word) or consumer (browser playback) work — this ships as tested, dormant infrastructure. Nothing calls `createVoiceSession` in production by the end of this plan.
- `npx tsc --noEmit` and the full `npm test` suite must stay clean after every task (307/323 baseline in this sandbox is acceptable — the 16 pre-existing failures are live-server tests needing infra this dev worktree doesn't have; do not introduce new failures beyond that baseline).

---

### Task 1: Session-scope `voice-session.ts`

**Files:**
- Modify: `src/interaction/voice-session.ts`
- Modify: `tests/index.test.ts:5514-5764` (all 7 existing `VoiceSession`-category tests)
- Test (new): `tests/index.test.ts` (append after the existing `VoiceSession` tests, before the next category)

**Interfaces:**
- Consumes: nothing new from other tasks.
- Produces: `voice:transcript` payload shape `{ text: string, sessionId: string, username: string }` (consumed by Task 2's `audio-client.ts` publishers and Task 3's manager). `voice:reply` payload shape `{ text: string, sessionId: string }` (consumed by Task 2's session-filtered `voice:reply` subscription).

- [ ] **Step 1: Update `VoiceSessionDeps` and the subscription/dispatch logic**

Edit `src/interaction/voice-session.ts`. Remove the `username?: string;` field from `VoiceSessionDeps` (it's no longer an override point — identity now comes from the event payload on every turn), and update `startVoiceSession`'s subscription and `handleTranscript`'s signature to receive `sessionId`/`username` explicitly instead of reading `deps.username ?? DEFAULT_USERNAME`.

Replace:
```typescript
export interface VoiceSessionDeps {
  // Left undefined (as opposed to explicitly null) means "read the live
  // shared instance fresh on every turn" — see resolveRouter/resolveAi
  // below. clients.ts's getCognitionRouter()/getAi() are getters
  // specifically so a router constructed after this module loaded (e.g.
  // server.ts's setSharedRouter() call at boot) is still seen; capturing
  // them once at startVoiceSession() call time would defeat that.
  router?: CognitionRouter | null;
  username?: string;
  ai?: GoogleGenAI | null;
```
with:
```typescript
export interface VoiceSessionDeps {
  // Left undefined (as opposed to explicitly null) means "read the live
  // shared instance fresh on every turn" — see resolveRouter/resolveAi
  // below. clients.ts's getCognitionRouter()/getAi() are getters
  // specifically so a router constructed after this module loaded (e.g.
  // server.ts's setSharedRouter() call at boot) is still seen; capturing
  // them once at startVoiceSession() call time would defeat that.
  router?: CognitionRouter | null;
  ai?: GoogleGenAI | null;
```

Replace the whole `startVoiceSession` function body:
```typescript
export function startVoiceSession(overrides: Partial<VoiceSessionDeps> = {}): { stop: () => void } {
  const deps: VoiceSessionDeps = { ...defaultInjectableDeps, ...overrides };
  const bus = EventBus.getInstance();

  // Per-call, not module-level: startVoiceSession() returns an independent
  // { stop } handle, so each call (e.g. a fresh instance in tests, or a
  // future multi-session scenario) must get its own turn queue rather than
  // sharing one across every call this process ever makes.
  let activeTurnPromise: Promise<void> = Promise.resolve();

  const unsubscribe = bus.subscribe<{ text?: string }>("voice:transcript", (payload) => {
    const text = typeof payload?.text === "string" ? payload.text.trim() : "";
    if (!text) return; // empty/no-op transcript: do nothing, never publish

    // Queue turns sequentially so tool loops never race.
    activeTurnPromise = activeTurnPromise
      .then(() => handleTranscript(text, deps, bus))
      .catch((err: any) => {
        // handleTranscript already catches every failure internally and
        // always publishes an honest reply rather than throwing — this is
        // only a last-resort net so a truly unexpected bug in this handler
        // itself can never silently leave the user with no reply at all.
        observation.logTelemetry(
          "error",
          "VoiceSession",
          `Unexpected voice-session failure outside the normal error handling, publishing an honest error reply: ${err?.message || err}`
        );
        // Matches publishReply's own append-then-publish pattern (below,
        // inside handleTranscript) so this truly-last-resort path doesn't
        // leave conversation history missing the reply the user actually
        // heard/saw -- every other reply path already does this.
        deps.appendMessage(deps.username ?? DEFAULT_USERNAME, "assistant", HONEST_PIPELINE_ERROR_REPLY).catch(() => {});
        bus.publish("voice:reply", { text: HONEST_PIPELINE_ERROR_REPLY });
      });
  });

  return {
    stop: () => {
      unsubscribe();
    },
  };
}
```
with:
```typescript
export function startVoiceSession(overrides: Partial<VoiceSessionDeps> = {}): { stop: () => void } {
  const deps: VoiceSessionDeps = { ...defaultInjectableDeps, ...overrides };
  const bus = EventBus.getInstance();

  // Per-call, not module-level: startVoiceSession() returns an independent
  // { stop } handle, so each call (e.g. a fresh instance in tests) must get
  // its own turn queue rather than sharing one across every call this
  // process ever makes. Turns from DIFFERENT sessions still share this one
  // queue (this is the one shared subscription every session's transcripts
  // flow through) -- that's fine, it just means concurrent sessions' turns
  // are processed one at a time rather than in parallel, same tradeoff the
  // single-session version already had for tool-call loops within one turn.
  let activeTurnPromise: Promise<void> = Promise.resolve();

  const unsubscribe = bus.subscribe<{ text?: string; sessionId?: string; username?: string }>("voice:transcript", (payload) => {
    const text = typeof payload?.text === "string" ? payload.text.trim() : "";
    if (!text) return; // empty/no-op transcript: do nothing, never publish

    const sessionId = typeof payload?.sessionId === "string" ? payload.sessionId : "";
    const username = typeof payload?.username === "string" ? payload.username : "";
    if (!sessionId || !username) {
      // A real producer (Task 3's voice-session-manager and beyond) always
      // stamps both -- this only fires for a malformed/legacy publisher,
      // and must fail loudly rather than silently misattributing a turn to
      // a fixed identity the way the old DEFAULT_USERNAME fallback did.
      observation.logTelemetry(
        "warn",
        "VoiceSession",
        `Dropping a voice:transcript event missing sessionId/username (sessionId=${sessionId || "<empty>"}, username=${username || "<empty>"}) -- refusing to guess who this turn belongs to.`
      );
      return;
    }

    // Queue turns sequentially so tool loops never race.
    activeTurnPromise = activeTurnPromise
      .then(() => handleTranscript(text, sessionId, username, deps, bus))
      .catch((err: any) => {
        // handleTranscript already catches every failure internally and
        // always publishes an honest reply rather than throwing — this is
        // only a last-resort net so a truly unexpected bug in this handler
        // itself can never silently leave the user with no reply at all.
        observation.logTelemetry(
          "error",
          "VoiceSession",
          `Unexpected voice-session failure outside the normal error handling, publishing an honest error reply: ${err?.message || err}`
        );
        // Matches publishReply's own append-then-publish pattern (below,
        // inside handleTranscript) so this truly-last-resort path doesn't
        // leave conversation history missing the reply the user actually
        // heard/saw -- every other reply path already does this.
        deps.appendMessage(username, "assistant", HONEST_PIPELINE_ERROR_REPLY).catch(() => {});
        bus.publish("voice:reply", { text: HONEST_PIPELINE_ERROR_REPLY, sessionId });
      });
  });

  return {
    stop: () => {
      unsubscribe();
    },
  };
}
```

Replace the `handleTranscript` signature and its `username` resolution line:
```typescript
async function handleTranscript(text: string, deps: VoiceSessionDeps, bus: EventBus): Promise<void> {
  const router = deps.router !== undefined ? deps.router : getCognitionRouter();
  const username = deps.username ?? DEFAULT_USERNAME;
```
with:
```typescript
async function handleTranscript(text: string, sessionId: string, username: string, deps: VoiceSessionDeps, bus: EventBus): Promise<void> {
  const router = deps.router !== undefined ? deps.router : getCognitionRouter();
```

Replace the `publishReply` closure (still inside `handleTranscript`) to stamp `sessionId`:
```typescript
  const publishReply = (replyText: string) => {
    bus.publish("voice:reply", { text: replyText });
    deps.appendMessage(username, "assistant", replyText).catch(() => {});
  };
```
with:
```typescript
  const publishReply = (replyText: string) => {
    bus.publish("voice:reply", { text: replyText, sessionId });
    deps.appendMessage(username, "assistant", replyText).catch(() => {});
  };
```

Finally, since `DEFAULT_USERNAME` is no longer referenced anywhere in this file, delete its declaration and the doc-comment paragraph above it that justified it:
```typescript
 * A single fixed username is used because this is a single local device
 * with one primary user, the same "admin" fallback daily-adaptation.ts and
 * other background-triggered callers already use when there's no real
 * per-request identity to thread through.
 */
const DEFAULT_USERNAME = "admin";
```
with:
```typescript
 */
```

- [ ] **Step 2: Update all 7 existing `VoiceSession` tests for the new event shape**

Every one of these tests currently passes `username: "voice_test_user"` into `startVoiceSession(...)`'s overrides (no longer a valid field) and publishes `voice:transcript` without `sessionId`/`username` (now required, or the event is silently dropped per Step 1). Apply this same two-part transform at each location below: remove the `username: "voice_test_user",` line from the `startVoiceSession({...})` call, and add `sessionId: "test-session-1", username: "voice_test_user"` to every `bus.publish("voice:transcript", {...})` call in that test. Where the test also asserts on the `voice:reply` payload, no assertion changes are needed (the tests below only check `reply.text`, not `reply.sessionId`) except where noted.

In `tests/index.test.ts`, test **"a real transcript produces a real voice:reply"** (~line 5514):

Replace:
```typescript
  const handle = voiceSessionModule.startVoiceSession({ router: fakeRouter, username: "voice_test_user" });
  try {
    bus.publish("voice:transcript", { text: "what's the weather like" });
```
with:
```typescript
  const handle = voiceSessionModule.startVoiceSession({ router: fakeRouter });
  try {
    bus.publish("voice:transcript", { text: "what's the weather like", sessionId: "test-session-1", username: "voice_test_user" });
```

Test **"an empty transcript produces no reply"** (~line 5541):

Replace:
```typescript
  const handle = voiceSessionModule.startVoiceSession({ router: null, username: "voice_test_user" });
  try {
    bus.publish("voice:transcript", { text: "" });
    bus.publish("voice:transcript", { text: "   " });
```
with:
```typescript
  const handle = voiceSessionModule.startVoiceSession({ router: null });
  try {
    bus.publish("voice:transcript", { text: "", sessionId: "test-session-1", username: "voice_test_user" });
    bus.publish("voice:transcript", { text: "   ", sessionId: "test-session-1", username: "voice_test_user" });
```

Test **"a pipeline failure produces an honest spoken error, never a fabricated answer"** (~line 5561):

Replace:
```typescript
  const throwingRouter = { generateWithFallback: async () => { throw new Error("simulated failure"); } } as any;
  const handle = voiceSessionModule.startVoiceSession({ router: throwingRouter, username: "voice_test_user" });
  try {
    bus.publish("voice:transcript", { text: "do something" });
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (!reply || !reply.text) throw new Error("VoiceSession: expected an honest error reply, got none");
    if (reply.text.toLowerCase().includes("spoken answer")) {
      throw new Error(`VoiceSession: error reply must never look like a fabricated real answer, got: ${JSON.stringify(reply)}`);
    }
  } finally {
    unsubscribe();
    handle.stop();
  }
});

registerTest("VoiceSession", "no cognition router configured produces an honest decline, not a crash", async () => {
```
with:
```typescript
  const throwingRouter = { generateWithFallback: async () => { throw new Error("simulated failure"); } } as any;
  const handle = voiceSessionModule.startVoiceSession({ router: throwingRouter });
  try {
    bus.publish("voice:transcript", { text: "do something", sessionId: "test-session-1", username: "voice_test_user" });
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (!reply || !reply.text) throw new Error("VoiceSession: expected an honest error reply, got none");
    if (reply.text.toLowerCase().includes("spoken answer")) {
      throw new Error(`VoiceSession: error reply must never look like a fabricated real answer, got: ${JSON.stringify(reply)}`);
    }
  } finally {
    unsubscribe();
    handle.stop();
  }
});

registerTest("VoiceSession", "no cognition router configured produces an honest decline, not a crash", async () => {
```

Test **"no cognition router configured produces an honest decline, not a crash"** (~line 5584):

Replace:
```typescript
  const handle = voiceSessionModule.startVoiceSession({ router: null, username: "voice_test_user" });
  try {
    bus.publish("voice:transcript", { text: "do something real" });
```
with:
```typescript
  const handle = voiceSessionModule.startVoiceSession({ router: null });
  try {
    bus.publish("voice:transcript", { text: "do something real", sessionId: "test-session-1", username: "voice_test_user" });
```

Test **"executes a tool call via executeTool before producing the final voice:reply"** (~line 5603):

Replace:
```typescript
  const handle = voiceSessionModule.startVoiceSession({
    router: fakeRouter,
    username: "voice_test_user",
    executeTool: fakeExecuteTool as any,
  });
  try {
    bus.publish("voice:transcript", { text: "what time is it" });
```
with:
```typescript
  const handle = voiceSessionModule.startVoiceSession({
    router: fakeRouter,
    executeTool: fakeExecuteTool as any,
  });
  try {
    bus.publish("voice:transcript", { text: "what time is it", sessionId: "test-session-1", username: "voice_test_user" });
```

Test **"a successful voice turn writes to session history, memory, and learning (I4)"** (~line 5655):

Replace:
```typescript
  const handle = voiceSessionModule.startVoiceSession({
    router: fakeRouter,
    username: "voice_test_user",
    appendMessage: (async (username: string, role: string, content: string) => {
      appendCalls.push({ username, role, content });
    }) as any,
    recall: (async () => { recallCalled = true; return []; }) as any,
    remember: (async () => { rememberCalled = true; return true; }) as any,
    reflectAndLearn: (async () => { reflectAndLearnCalled = true; }) as any,
    extractAndStore: (async () => { extractAndStoreCalled = true; }) as any,
    extractSelfReflection: (async () => { extractSelfReflectionCalled = true; }) as any,
    extractRapportSignal: (async () => { extractRapportSignalCalled = true; }) as any,
  });
  try {
    bus.publish("voice:transcript", { text: "what's the weather like" });
```
with:
```typescript
  const handle = voiceSessionModule.startVoiceSession({
    router: fakeRouter,
    appendMessage: (async (username: string, role: string, content: string) => {
      appendCalls.push({ username, role, content });
    }) as any,
    recall: (async () => { recallCalled = true; return []; }) as any,
    remember: (async () => { rememberCalled = true; return true; }) as any,
    reflectAndLearn: (async () => { reflectAndLearnCalled = true; }) as any,
    extractAndStore: (async () => { extractAndStoreCalled = true; }) as any,
    extractSelfReflection: (async () => { extractSelfReflectionCalled = true; }) as any,
    extractRapportSignal: (async () => { extractRapportSignalCalled = true; }) as any,
  });
  try {
    bus.publish("voice:transcript", { text: "what's the weather like", sessionId: "test-session-1", username: "voice_test_user" });
```

Test **"a pipeline failure still logs the user's message but skips the learning writes (I4)"** (~line 5719):

Replace:
```typescript
  const handle = voiceSessionModule.startVoiceSession({
    router: throwingRouter,
    username: "voice_test_user",
    appendMessage: (async (username: string, role: string, content: string) => {
      appendCalls.push({ username, role, content });
    }) as any,
    recall: (async () => []) as any,
    remember: (async () => { learningWriteCalled = true; return true; }) as any,
    reflectAndLearn: (async () => { learningWriteCalled = true; }) as any,
    extractAndStore: (async () => { learningWriteCalled = true; }) as any,
    extractSelfReflection: (async () => { learningWriteCalled = true; }) as any,
    extractRapportSignal: (async () => { learningWriteCalled = true; }) as any,
  });
  try {
    bus.publish("voice:transcript", { text: "do something" });
```
with:
```typescript
  const handle = voiceSessionModule.startVoiceSession({
    router: throwingRouter,
    appendMessage: (async (username: string, role: string, content: string) => {
      appendCalls.push({ username, role, content });
    }) as any,
    recall: (async () => []) as any,
    remember: (async () => { learningWriteCalled = true; return true; }) as any,
    reflectAndLearn: (async () => { learningWriteCalled = true; }) as any,
    extractAndStore: (async () => { learningWriteCalled = true; }) as any,
    extractSelfReflection: (async () => { learningWriteCalled = true; }) as any,
    extractRapportSignal: (async () => { learningWriteCalled = true; }) as any,
  });
  try {
    bus.publish("voice:transcript", { text: "do something", sessionId: "test-session-1", username: "voice_test_user" });
```

- [ ] **Step 3: Run the existing VoiceSession tests to confirm they still pass**

Run: `npx tsx tests/index.test.ts 2>&1 | grep -A1 "Category: VoiceSession"`
Expected: all 7 lines show `✅ [PASSED]`, zero `❌ [FAILED]`.

- [ ] **Step 4: Write the new cross-session isolation test**

Append this new test immediately after the last existing `VoiceSession` test (after the closing `});` of "a pipeline failure still logs the user's message but skips the learning writes (I4)", before the next `registerTest(...)` category begins):

```typescript
registerTest("VoiceSession", "two concurrent sessions never cross-contaminate identity or replies", async () => {
  // The real bug this guards against: before sessionId/username were
  // required on every event, a single shared voice-session subscription
  // had no way to tell two overlapping conversations apart -- everything
  // silently fell back to one fixed identity. This publishes two
  // interleaved transcripts under two different sessionId/username pairs
  // and asserts each one's memory/reply is correctly attributed to ITS
  // OWN session, never the other's.
  const { EventBus } = await import("../src/core/event-bus.js");
  const voiceSessionModule = await import("../src/interaction/voice-session.js");

  const bus = EventBus.getInstance();
  const repliesBySession: Record<string, string[]> = {};
  const unsubscribe = bus.subscribe<{ text: string; sessionId: string }>("voice:reply", (payload) => {
    (repliesBySession[payload.sessionId] ||= []).push(payload.text);
  });

  const recallCallsByUsername: string[] = [];
  const fakeRouter = {
    generateWithFallback: async (username: string) => ({
      choices: [{ message: { content: `Reply for ${username}`, tool_calls: undefined } }],
    }),
  } as any;

  const handle = voiceSessionModule.startVoiceSession({
    router: fakeRouter,
    recall: (async (username: string) => { recallCallsByUsername.push(username); return []; }) as any,
  });
  try {
    bus.publish("voice:transcript", { text: "question from alice", sessionId: "session-alice", username: "alice" });
    bus.publish("voice:transcript", { text: "question from bob", sessionId: "session-bob", username: "bob" });
    await new Promise((resolve) => setTimeout(resolve, 400));

    if (!recallCallsByUsername.includes("alice") || !recallCallsByUsername.includes("bob")) {
      throw new Error(`VoiceSession: expected recall() called with both real usernames, got: ${JSON.stringify(recallCallsByUsername)}`);
    }
    const aliceReplies = repliesBySession["session-alice"] || [];
    const bobReplies = repliesBySession["session-bob"] || [];
    if (aliceReplies.length !== 1 || !aliceReplies[0].includes("alice")) {
      throw new Error(`VoiceSession: expected session-alice's own reply, got: ${JSON.stringify(repliesBySession)}`);
    }
    if (bobReplies.length !== 1 || !bobReplies[0].includes("bob")) {
      throw new Error(`VoiceSession: expected session-bob's own reply, got: ${JSON.stringify(repliesBySession)}`);
    }
  } finally {
    unsubscribe();
    handle.stop();
  }
});

registerTest("VoiceSession", "a voice:transcript event missing sessionId or username is dropped, not misattributed", async () => {
  const { EventBus } = await import("../src/core/event-bus.js");
  const voiceSessionModule = await import("../src/interaction/voice-session.js");

  const bus = EventBus.getInstance();
  let replyCount = 0;
  const unsubscribe = bus.subscribe("voice:reply", () => { replyCount++; });

  const fakeRouter = {
    generateWithFallback: async () => ({ choices: [{ message: { content: "should never be spoken", tool_calls: undefined } }] }),
  } as any;

  const handle = voiceSessionModule.startVoiceSession({ router: fakeRouter });
  try {
    bus.publish("voice:transcript", { text: "no sessionId here", username: "voice_test_user" });
    bus.publish("voice:transcript", { text: "no username here", sessionId: "test-session-1" });
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (replyCount !== 0) {
      throw new Error(`VoiceSession: expected events missing sessionId/username to be dropped silently, got ${replyCount} replies`);
    }
  } finally {
    unsubscribe();
    handle.stop();
  }
});
```

- [ ] **Step 5: Run the full test suite and typecheck**

Run: `npx tsc --noEmit`
Expected: no output (clean).

Run: `npm test 2>&1 | tail -5`
Expected: `TOTALS: 309 / 325 Tests Passed.` (baseline 307/323 plus these 2 new tests, same 16 pre-existing environment-only failures).

- [ ] **Step 6: Commit**

```bash
git add src/interaction/voice-session.ts tests/index.test.ts
git commit -m "feat: session-scope voice-session.ts's transcript handling

Every voice:transcript/voice:reply event now carries a required
sessionId + username instead of falling back to a fixed
DEFAULT_USERNAME identity. A single shared subscription still handles
every turn (matches how one Express route handler already serves many
concurrent requests) -- it just reads identity off the event now
instead of assuming there's only ever one conversation happening.

Part of the per-user voice session pipeline (sub-project A) -- see
docs/superpowers/specs/2026-08-16-per-user-voice-session-design.md."
```

---

### Task 2: Session-scope `audio-client.ts`'s daemon bridge

**Files:**
- Modify: `src/core/audio-client.ts`
- Modify: `tests/index.test.ts:5277-5476` (6 existing `AudioClient`-category tests that call `startAudioClient`)

**Interfaces:**
- Consumes: `voice:reply` payload shape `{ text: string, sessionId: string }` from Task 1.
- Produces: `startAudioClient(socketPath: string, sessionId: string, username: string): { stop: () => void }` (Task 3 calls this from `voice-session-manager.ts`). Publishes `voice:transcript`/`voice:audio-chunk`/`voice:queued`/`voice:error` all carrying `sessionId` (and `voice:transcript` also carrying `username`, since that's the one event `voice-session.ts` needs identity from).

- [ ] **Step 1: Add `sessionId`/`username` parameters and stamp them on every publish**

Edit `src/core/audio-client.ts`. Replace the function signature and the `voice:reply` subscription's filter:

Replace:
```typescript
export function startAudioClient(socketPath: string): { stop: () => void } {
  const bus = EventBus.getInstance();
  let stopped = false;
  let socket: net.Socket | null = null;
  let rl: readline.Interface | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let backoffMs = INITIAL_RECONNECT_DELAY_MS;

  const unsubscribeReply = bus.subscribe("voice:reply", (payload: any) => {
    if (stopped || !socket || !socket.writable) return;
    socket.write(JSON.stringify({ type: "speak", text: payload.text }) + "\n");
  });
```
with:
```typescript
export function startAudioClient(socketPath: string, sessionId: string, username: string): { stop: () => void } {
  const bus = EventBus.getInstance();
  let stopped = false;
  let socket: net.Socket | null = null;
  let rl: readline.Interface | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let backoffMs = INITIAL_RECONNECT_DELAY_MS;

  const unsubscribeReply = bus.subscribe("voice:reply", (payload: any) => {
    // A reply for a DIFFERENT session must never be spoken over THIS
    // connection's daemon socket -- with multiple concurrent sessions now
    // possible, voice:reply is no longer implicitly "the one reply
    // everyone's waiting on".
    if (stopped || !socket || !socket.writable || payload.sessionId !== sessionId) return;
    socket.write(JSON.stringify({ type: "speak", text: payload.text }) + "\n");
  });
```

Replace the daemon-message publish block:
```typescript
      if (msg.type === "transcript") {
        bus.publish("voice:transcript", { text: msg.text });
      } else if (msg.type === "audio_chunk") {
        bus.publish("voice:audio-chunk", { data: msg.data });
      } else if (msg.type === "queued") {
        bus.publish("voice:queued", { position: msg.position });
      }
```
with:
```typescript
      if (msg.type === "transcript") {
        bus.publish("voice:transcript", { text: msg.text, sessionId, username });
      } else if (msg.type === "audio_chunk") {
        bus.publish("voice:audio-chunk", { data: msg.data, sessionId });
      } else if (msg.type === "queued") {
        bus.publish("voice:queued", { position: msg.position, sessionId });
      }
```

Replace the two `voice:error` publish call sites:
```typescript
    newSocket.on("error", (err: any) => {
      if (stopped || errorReported) return;
      errorReported = true;
      observation.logTelemetry("warn", "AudioClient", `Voice daemon socket error: ${err.message || err}`);
      bus.publish("voice:error", { message: err.message || String(err) });
    });

    newSocket.on("close", () => {
      newRl.close();
      if (stopped) return;
      if (!errorReported) {
        errorReported = true;
        bus.publish("voice:error", { message: "Voice daemon connection closed unexpectedly" });
      }
      scheduleReconnect();
    });
```
with:
```typescript
    newSocket.on("error", (err: any) => {
      if (stopped || errorReported) return;
      errorReported = true;
      observation.logTelemetry("warn", "AudioClient", `Voice daemon socket error: ${err.message || err}`);
      bus.publish("voice:error", { message: err.message || String(err), sessionId });
    });

    newSocket.on("close", () => {
      newRl.close();
      if (stopped) return;
      if (!errorReported) {
        errorReported = true;
        bus.publish("voice:error", { message: "Voice daemon connection closed unexpectedly", sessionId });
      }
      scheduleReconnect();
    });
```

- [ ] **Step 2: Update the 6 existing `AudioClient` tests that call `startAudioClient`**

Every call site of `startAudioClient(socketPath)` becomes `startAudioClient(socketPath, "test-session-1", "voice_test_user")` (or the nonexistent-path literal for the connection-failure test). Apply at each location:

In `tests/index.test.ts`, test **"publishes voice:transcript when the daemon sends a transcript message"** (~line 5277):

Replace:
```typescript
  const client = startAudioClient(socketPath);
  try {
    await new Promise((resolve) => setTimeout(resolve, 200));
    if (!received || received.text !== "hello from the daemon") {
      throw new Error(`AudioClient: expected a real voice:transcript publish, got: ${JSON.stringify(received)}`);
    }
  } finally {
    unsubscribe();
    client.stop();
    fakeServer.close();
  }
});

registerTest("AudioClient", "publishes voice:error exactly once when the socket connection fails", async () => {
```
with:
```typescript
  const client = startAudioClient(socketPath, "test-session-1", "voice_test_user");
  try {
    await new Promise((resolve) => setTimeout(resolve, 200));
    if (!received || received.text !== "hello from the daemon" || received.sessionId !== "test-session-1" || received.username !== "voice_test_user") {
      throw new Error(`AudioClient: expected a real voice:transcript publish with sessionId/username, got: ${JSON.stringify(received)}`);
    }
  } finally {
    unsubscribe();
    client.stop();
    fakeServer.close();
  }
});

registerTest("AudioClient", "publishes voice:error exactly once when the socket connection fails", async () => {
```

Test **"publishes voice:error exactly once when the socket connection fails"** (~line 5307):

Replace:
```typescript
  const client = startAudioClient("/nonexistent/path/that/cannot/possibly/exist.sock");
```
with:
```typescript
  const client = startAudioClient("/nonexistent/path/that/cannot/possibly/exist.sock", "test-session-1", "voice_test_user");
```

Test **"forwards a voice:reply bus event to the daemon as a speak message"** (~line 5335):

Replace:
```typescript
  const client = startAudioClient(socketPath);
  try {
    await new Promise((resolve) => setTimeout(resolve, 200));
    bus.publish("voice:reply", { text: "here is my answer" });
```
with:
```typescript
  const client = startAudioClient(socketPath, "test-session-1", "voice_test_user");
  try {
    await new Promise((resolve) => setTimeout(resolve, 200));
    bus.publish("voice:reply", { text: "here is my answer", sessionId: "test-session-1" });
```

Also add a new assertion immediately after this test's existing one (still inside the same `try` block, right after the existing `if (parsed.type !== "speak" ...)` check) to prove the session-filtering actually filters, replacing:
```typescript
    const parsed = JSON.parse(receivedByDaemon.trim());
    if (parsed.type !== "speak" || parsed.text !== "here is my answer") {
      throw new Error(`AudioClient: expected a real "speak" message forwarded to the daemon, got: ${receivedByDaemon}`);
    }
  } finally {
    client.stop();
    fakeServer.close();
  }
});

registerTest("AudioClient", "publishes voice:audio-chunk when the daemon sends an audio_chunk message", async () => {
```
with:
```typescript
    const parsed = JSON.parse(receivedByDaemon.trim());
    if (parsed.type !== "speak" || parsed.text !== "here is my answer") {
      throw new Error(`AudioClient: expected a real "speak" message forwarded to the daemon, got: ${receivedByDaemon}`);
    }

    // A reply for a DIFFERENT session must not be spoken over this
    // connection at all.
    receivedByDaemon = "";
    bus.publish("voice:reply", { text: "someone else's answer", sessionId: "a-different-session" });
    await new Promise((resolve) => setTimeout(resolve, 200));
    if (receivedByDaemon.trim().length !== 0) {
      throw new Error(`AudioClient: expected a different session's voice:reply to be ignored, but the daemon received: ${receivedByDaemon}`);
    }
  } finally {
    client.stop();
    fakeServer.close();
  }
});

registerTest("AudioClient", "publishes voice:audio-chunk when the daemon sends an audio_chunk message", async () => {
```

Test **"publishes voice:audio-chunk when the daemon sends an audio_chunk message"** (~line 5365):

Replace:
```typescript
  const client = startAudioClient(socketPath);
  try {
    await new Promise((resolve) => setTimeout(resolve, 200));
    if (!received || received.data !== "ZmFrZS1hdWRpby1ieXRlcw==") {
      throw new Error(`AudioClient: expected a real voice:audio-chunk publish, got: ${JSON.stringify(received)}`);
    }
```
with:
```typescript
  const client = startAudioClient(socketPath, "test-session-1", "voice_test_user");
  try {
    await new Promise((resolve) => setTimeout(resolve, 200));
    if (!received || received.data !== "ZmFrZS1hdWRpby1ieXRlcw==" || received.sessionId !== "test-session-1") {
      throw new Error(`AudioClient: expected a real voice:audio-chunk publish with sessionId, got: ${JSON.stringify(received)}`);
    }
```

Test **"stop() closes the socket and unsubscribes so no further bus activity occurs"** (~line 5395):

Replace:
```typescript
  const client = startAudioClient(socketPath);
  await new Promise((resolve) => setTimeout(resolve, 150));
```
with:
```typescript
  const client = startAudioClient(socketPath, "test-session-1", "voice_test_user");
  await new Promise((resolve) => setTimeout(resolve, 150));
```

Test **"reconnects with backoff and starts working once the daemon becomes available"** (~line 5427):

Replace:
```typescript
  const client = startAudioClient(socketPath);
  let fakeServer: import("net").Server | null = null;
```
with:
```typescript
  const client = startAudioClient(socketPath, "test-session-1", "voice_test_user");
  let fakeServer: import("net").Server | null = null;
```

- [ ] **Step 3: Run the full test suite and typecheck**

Run: `npx tsc --noEmit`
Expected: no output (clean).

Run: `npm test 2>&1 | tail -5`
Expected: `TOTALS: 309 / 325 Tests Passed.` (same as Task 1's final count — this task doesn't add new tests, only updates existing ones and adds one new assertion inline).

- [ ] **Step 4: Commit**

```bash
git add src/core/audio-client.ts tests/index.test.ts
git commit -m "feat: session-scope audio-client.ts's daemon bridge

startAudioClient now takes (socketPath, sessionId, username) instead
of being a bare global singleton -- every event it publishes carries
sessionId, and its voice:reply subscription only forwards replies
matching its own session to the daemon it's bridging. The daemon
itself already isolates each connection's utterance buffer, so real
per-session correctness comes from opening one real connection per
session (Task 3), not from any daemon-side change.

Part of the per-user voice session pipeline (sub-project A) -- see
docs/superpowers/specs/2026-08-16-per-user-voice-session-design.md."
```

---

### Task 3: Session lifecycle manager + wire into `server.ts`

**Files:**
- Create: `src/interaction/voice-session-manager.ts`
- Modify: `src/server.ts:78-79,1534-1535,1580,1584`
- Test: `tests/index.test.ts` (new `VoiceSessionManager` category, appended after the `VoiceSession` tests added in Task 1)

**Interfaces:**
- Consumes: `startAudioClient(socketPath, sessionId, username)` from Task 2.
- Produces: `createVoiceSession(socketPath: string, username: string): string` (returns a new `sessionId`), `destroyVoiceSession(sessionId: string): boolean` (returns whether a session with that id existed), `destroyAllVoiceSessions(): void`. These are the functions a future producer (a later sub-project, out of scope here) will call.

- [ ] **Step 1: Write the failing tests for the manager**

Create the test file section. Append this new category to `tests/index.test.ts`, after the last `VoiceSession` test added in Task 1 (the "missing sessionId or username" test), before the next existing category begins:

```typescript
registerTest("VoiceSessionManager", "createVoiceSession returns a unique sessionId per call", async () => {
  const manager = await import("../src/interaction/voice-session-manager.js");
  const id1 = manager.createVoiceSession("/nonexistent/path/that/cannot/possibly/exist.sock", "alice");
  const id2 = manager.createVoiceSession("/nonexistent/path/that/cannot/possibly/exist.sock", "bob");
  try {
    if (typeof id1 !== "string" || !id1) throw new Error(`VoiceSessionManager: expected a real sessionId string, got: ${JSON.stringify(id1)}`);
    if (id1 === id2) throw new Error("VoiceSessionManager: expected two different sessions to get different sessionIds");
  } finally {
    manager.destroyVoiceSession(id1);
    manager.destroyVoiceSession(id2);
  }
});

registerTest("VoiceSessionManager", "destroyVoiceSession reports whether a session actually existed", async () => {
  const manager = await import("../src/interaction/voice-session-manager.js");
  const id = manager.createVoiceSession("/nonexistent/path/that/cannot/possibly/exist.sock", "alice");
  const firstDestroy = manager.destroyVoiceSession(id);
  const secondDestroy = manager.destroyVoiceSession(id);
  if (firstDestroy !== true) throw new Error("VoiceSessionManager: expected destroying a real session to return true");
  if (secondDestroy !== false) throw new Error("VoiceSessionManager: expected destroying an already-gone session to return false, not throw or return true again");
});

registerTest("VoiceSessionManager", "two real concurrent daemon connections stay isolated per session", async () => {
  // Live-daemon isolation check (spec's "real connection" test tier) --
  // uses two fake Unix-socket servers standing in for the daemon (same
  // fake-server pattern the AudioClient tests already use) rather than the
  // real Python daemon, since this environment doesn't reliably have
  // faster-whisper/kokoro installed outside the daemon's own Docker image.
  // This still proves the real thing this task adds: createVoiceSession
  // opens one REAL, independent net.Socket connection per session, and a
  // message written to one fake daemon never reaches the other session's
  // socket.
  const os = await import("os");
  const path = await import("path");
  const net = await import("net");
  const { EventBus } = await import("../src/core/event-bus.js");
  const manager = await import("../src/interaction/voice-session-manager.js");

  const aliceSocketPath = path.join(os.tmpdir(), `jarvis-voice-test-alice-${Date.now()}.sock`);
  const bobSocketPath = path.join(os.tmpdir(), `jarvis-voice-test-bob-${Date.now()}.sock`);

  const aliceServer = net.createServer((conn) => {
    conn.write(JSON.stringify({ type: "transcript", text: "alice said this" }) + "\n");
  });
  const bobServer = net.createServer((conn) => {
    conn.write(JSON.stringify({ type: "transcript", text: "bob said this" }) + "\n");
  });
  await new Promise<void>((resolve) => aliceServer.listen(aliceSocketPath, resolve));
  await new Promise<void>((resolve) => bobServer.listen(bobSocketPath, resolve));

  const bus = EventBus.getInstance();
  const transcriptsBySession: Record<string, string[]> = {};
  const unsubscribe = bus.subscribe<{ text: string; sessionId: string }>("voice:transcript", (payload) => {
    (transcriptsBySession[payload.sessionId] ||= []).push(payload.text);
  });

  const aliceSessionId = manager.createVoiceSession(aliceSocketPath, "alice");
  const bobSessionId = manager.createVoiceSession(bobSocketPath, "bob");
  try {
    await new Promise((resolve) => setTimeout(resolve, 300));
    const aliceTranscripts = transcriptsBySession[aliceSessionId] || [];
    const bobTranscripts = transcriptsBySession[bobSessionId] || [];
    if (aliceTranscripts.length !== 1 || aliceTranscripts[0] !== "alice said this") {
      throw new Error(`VoiceSessionManager: expected alice's session to receive only alice's transcript, got: ${JSON.stringify(transcriptsBySession)}`);
    }
    if (bobTranscripts.length !== 1 || bobTranscripts[0] !== "bob said this") {
      throw new Error(`VoiceSessionManager: expected bob's session to receive only bob's transcript, got: ${JSON.stringify(transcriptsBySession)}`);
    }
  } finally {
    unsubscribe();
    manager.destroyVoiceSession(aliceSessionId);
    manager.destroyVoiceSession(bobSessionId);
    aliceServer.close();
    bobServer.close();
  }
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `npx tsx tests/index.test.ts 2>&1 | grep -A1 "Category: VoiceSessionManager"`
Expected: FAIL for all 3 — `voice-session-manager.js` doesn't exist yet, so the `import(...)` calls throw a module-not-found error.

- [ ] **Step 3: Create `src/interaction/voice-session-manager.ts`**

```typescript
import * as crypto from "crypto";
import { startAudioClient } from "../core/audio-client.js";

interface ManagedSession {
  username: string;
  audioClient: { stop: () => void };
}

// Module-level by design (not a class) -- there's exactly one process-wide
// registry of active voice sessions, the same way EventBus.getInstance()
// is a singleton. A future producer (out of scope here) calls
// createVoiceSession() once per activation (e.g. once per wake-word
// trigger) and destroyVoiceSession() once that session's turn/connection
// should end.
const activeSessions = new Map<string, ManagedSession>();

/**
 * Opens one real, independent connection to the voice daemon for this
 * session and returns a fresh sessionId identifying it. The daemon's own
 * per-connection utterance-buffer isolation (daemon/voice_engine.py's
 * handle_connection) is what actually keeps concurrent sessions' audio
 * from mixing -- this function's job is just making sure each session
 * gets its own real connection instead of sharing the old single global
 * one, so that isolation guarantee actually applies.
 */
export function createVoiceSession(socketPath: string, username: string): string {
  const sessionId = crypto.randomUUID();
  const audioClient = startAudioClient(socketPath, sessionId, username);
  activeSessions.set(sessionId, { username, audioClient });
  return sessionId;
}

/**
 * Closes a session's daemon connection and forgets it. Returns whether a
 * session with that id actually existed, so a caller can tell "I cleaned
 * up a real session" apart from "there was nothing to clean up" -- e.g. a
 * double-destroy from an overlapping wake-word/timeout race in a future
 * producer.
 */
export function destroyVoiceSession(sessionId: string): boolean {
  const session = activeSessions.get(sessionId);
  if (!session) return false;
  session.audioClient.stop();
  activeSessions.delete(sessionId);
  return true;
}

/**
 * Closes every currently active session's daemon connection -- for a
 * clean process shutdown (see server.ts's SIGTERM handling), so a restart
 * doesn't leave orphaned daemon-side connections lingering until they time
 * out on their own.
 */
export function destroyAllVoiceSessions(): void {
  for (const sessionId of Array.from(activeSessions.keys())) {
    destroyVoiceSession(sessionId);
  }
}
```

- [ ] **Step 4: Run the new tests to verify they pass**

Run: `npx tsx tests/index.test.ts 2>&1 | grep -A1 "Category: VoiceSessionManager"`
Expected: all 3 lines show `✅ [PASSED]`.

- [ ] **Step 5: Wire `server.ts` to the new module and remove the old boot-time singleton**

Edit `src/server.ts`. Replace the two `let` declarations:
```typescript
let audioClient: any;
let voiceSession: any;
```
with:
```typescript
let voiceSession: any;
```

Replace the boot-time start calls:
```typescript
  liveAnalysis = startLiveAnalysis();
  shadowVerifier = startShadowVerifier();
  audioClient = startAudioClient(process.env.VOICE_DAEMON_SOCKET || "/tmp/jarvis-voice/voice.sock");
  voiceSession = startVoiceSession();
```
with:
```typescript
  liveAnalysis = startLiveAnalysis();
  shadowVerifier = startShadowVerifier();
  // Note: no boot-time audio-client connection anymore -- daemon
  // connections are now opened per-session via voice-session-manager.ts's
  // createVoiceSession(), on demand, once a real producer exists to call
  // it (out of scope for this plan). This one shared voice:transcript
  // subscription still starts at boot -- see voice-session.ts's own
  // doc-comment -- so it's ready the moment any session's transcript
  // arrives.
  voiceSession = startVoiceSession();
```

Update the import line (remove `startAudioClient`, since `server.ts` no longer calls it directly — `voice-session-manager.ts` does):
```typescript
import { startAudioClient } from "./core/audio-client.js";
```
with:
```typescript
import { destroyAllVoiceSessions } from "./interaction/voice-session-manager.js";
```

Replace the shutdown cleanup line:
```typescript
    audioClient?.stop?.();
```
with:
```typescript
    destroyAllVoiceSessions();
```

- [ ] **Step 6: Run the full test suite and typecheck**

Run: `npx tsc --noEmit`
Expected: no output (clean).

Run: `npm test 2>&1 | tail -5`
Expected: `TOTALS: 312 / 328 Tests Passed.` (previous 309/325 plus these 3 new `VoiceSessionManager` tests, same 16 pre-existing environment-only failures).

- [ ] **Step 7: Commit**

```bash
git add src/interaction/voice-session-manager.ts src/server.ts tests/index.test.ts
git commit -m "feat: per-session voice session lifecycle manager

createVoiceSession(socketPath, username) opens one real daemon
connection per session and returns a sessionId; destroyVoiceSession/
destroyAllVoiceSessions clean up. Replaces server.ts's old boot-time
singleton audio-client connection -- daemon connections are now
opened on demand, one per active session, once a real producer exists
to call createVoiceSession (a separate, later sub-project). The
shared voice:transcript subscription (voice-session.ts's
startVoiceSession) still starts at boot, ready for whenever that is.

Completes the per-user voice session pipeline (sub-project A) -- see
docs/superpowers/specs/2026-08-16-per-user-voice-session-design.md.
Ships as tested, dormant infrastructure: nothing calls
createVoiceSession in production yet."
```
