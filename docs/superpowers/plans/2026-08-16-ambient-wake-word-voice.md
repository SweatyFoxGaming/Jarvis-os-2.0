# Ambient Wake-Word Voice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a signed-in user enable "ambient listening," say "Jarvis," speak, and get a spoken reply — no click required — while their dashboard tab is open, with multiple users able to do this concurrently without one user's turn blocking another's.

**Architecture:** Client-side Picovoice Porcupine wake-word detection (browser, on-device, built-in `"Jarvis"` keyword) opens a `/ws/voice-stream` WebSocket on trigger, streaming raw 16kHz mono 16-bit PCM in one direction into the daemon's already-built (but previously uncalled) `audio_chunk`/`UtteranceEndDetector` path via the now-merged per-session pipeline (`createVoiceSession`/`destroyVoiceSession`). The reply — synthesized daemon-side as a side effect of the existing `voice:reply` → `audio-client.ts` → daemon `"speak"` flow — is accumulated server-side into one WAV blob and sent back as a single `turn_complete` control message, played via `index.html`'s existing `playAudioBase64`. Folds in a per-session turn-queueing fix to `voice-session.ts` so this producer doesn't introduce cross-user head-of-line blocking.

**Tech Stack:** TypeScript/Node (Express, `ws`), Picovoice Porcupine Web SDK (WASM), vanilla browser JS (no bundler — matches this codebase's existing unbundled static frontend).

**Spec:** `docs/superpowers/specs/2026-08-16-ambient-wake-word-voice-design.md`

## Global Constraints

- Every new voice-pipeline interaction must use the existing per-session identity model (`sessionId`/`username`) established by Sub-project A — no new fixed/default identity anywhere.
- No daemon-side changes (`daemon/voice_engine.py` already supports everything this plan needs).
- The streaming PCM format is load-bearing and exact: mono, 16-bit signed little-endian, 16kHz — matching `daemon/models.py`'s STT expectation, documented at `src/core/audio-client.ts:199` (`transcribeOverSocket`'s doc comment).
- No production code may call `createVoiceSession` with a silent/default identity — every call site must have a real, authenticated username, consistent with the "no silent defaults" lesson from Sub-project A's Task 2 fix.
- Reply audio playback reuses the existing `playAudioBase64(mimeType, base64)` client-side function — no new decoding/streaming-playback code, and no second synthesis call against `/api/integrations/tts/speak` (that endpoint belongs to click-to-talk's unrelated reply mechanism, not this pipeline's).
- `wake-word.js`'s own audio pipeline (Porcupine WASM, `getUserMedia`, real microphone) is not unit-testable in this codebase's existing test harness — verified by manual checklist in a real browser, same as the existing click-to-talk mic code.

---

### Task 1: `audio-client.ts` — outbound audio-chunk forwarding + speak-done signal

**Files:**
- Modify: `src/core/audio-client.ts:65-183` (the `startAudioClient` function, its inbound message handler, and its return statement)
- Test: `tests/index.test.ts` (two new tests in the existing `AudioClient` category, near line 5374)

**Interfaces:**
- Consumes: nothing new — this task only extends `startAudioClient`'s existing returned handle and message handling.
- Produces: (1) `startAudioClient(...)`'s returned handle gains `sendAudioChunk(pcmBytes: Buffer): boolean` — writes `{"type": "audio_chunk", "data": <base64>}` to the daemon socket, returns `false` (no-op, no throw) if the connection isn't currently writable (mirrors how `stop()` already no-ops safely on a dead connection). (2) A new `voice:speak-done` bus event, `{ sessionId }`, published when the daemon sends `{"type": "speak_done"}` — the daemon's own signal that it has finished streaming every `audio_chunk` of a synthesized reply. Task 5's `voice-stream-ws.ts` subscribes to both this and `voice:audio-chunk` to know precisely when a reply's audio is complete.

- [ ] **Step 1: Write the failing test**

Add this test immediately after the existing `"forwards a voice:reply bus event to the daemon as a speak message"` test (ends around line 5372) in `tests/index.test.ts`:

```typescript
registerTest("AudioClient", "sendAudioChunk writes a correctly-shaped audio_chunk message to the daemon, and no-ops after stop()", async () => {
  const os = await import("os");
  const path = await import("path");
  const net = await import("net");
  const { startAudioClient } = await import("../src/core/audio-client.js");

  const socketPath = path.join(os.tmpdir(), `jarvis-voice-test-${Date.now()}.sock`);
  let receivedByDaemon = "";
  const fakeServer = net.createServer((conn) => {
    conn.on("data", (data) => { receivedByDaemon += data.toString(); });
  });
  await new Promise<void>((resolve) => fakeServer.listen(socketPath, resolve));

  const client = startAudioClient(socketPath, "test-session-1", "voice_test_user");
  try {
    await new Promise((resolve) => setTimeout(resolve, 200));

    const pcm = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
    const sent = client.sendAudioChunk(pcm);
    if (sent !== true) throw new Error("AudioClient: expected sendAudioChunk to return true while connected");

    await new Promise((resolve) => setTimeout(resolve, 200));
    const parsed = JSON.parse(receivedByDaemon.trim());
    if (parsed.type !== "audio_chunk" || parsed.data !== pcm.toString("base64")) {
      throw new Error(`AudioClient: expected a correctly-shaped audio_chunk message, got: ${receivedByDaemon}`);
    }

    client.stop();
    const sentAfterStop = client.sendAudioChunk(pcm);
    if (sentAfterStop !== false) throw new Error("AudioClient: expected sendAudioChunk to return false after stop()");
  } finally {
    client.stop();
    fakeServer.close();
  }
});

registerTest("AudioClient", "publishes voice:speak-done when the daemon sends a speak_done message", async () => {
  const os = await import("os");
  const path = await import("path");
  const net = await import("net");
  const { EventBus } = await import("../src/core/event-bus.js");
  const { startAudioClient } = await import("../src/core/audio-client.js");

  const socketPath = path.join(os.tmpdir(), `jarvis-voice-test-speakdone-${Date.now()}.sock`);
  const fakeServer = net.createServer((conn) => {
    conn.write(JSON.stringify({ type: "speak_done" }) + "\n");
  });
  await new Promise<void>((resolve) => fakeServer.listen(socketPath, resolve));

  const bus = EventBus.getInstance();
  let received: any = null;
  let publishCount = 0;
  const unsubscribe = bus.subscribe("voice:speak-done", (payload) => { received = payload; publishCount++; });

  const client = startAudioClient(socketPath, "test-session-1", "voice_test_user");
  try {
    await new Promise((resolve) => setTimeout(resolve, 200));
    if (!received || received.sessionId !== "test-session-1") {
      throw new Error(`AudioClient: expected a voice:speak-done publish with sessionId, got: ${JSON.stringify(received)}`);
    }
    if (publishCount !== 1) {
      throw new Error(`AudioClient: expected exactly 1 voice:speak-done publish, got ${publishCount}`);
    }
  } finally {
    unsubscribe();
    client.stop();
    fakeServer.close();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx tests/index.test.ts 2>&1 | grep -A5 "sendAudioChunk writes\|voice:speak-done"`
Expected: both FAIL — `client.sendAudioChunk is not a function`; no `voice:speak-done` ever published.

- [ ] **Step 3: Write minimal implementation**

In `src/core/audio-client.ts`, add a `"speak_done"` branch to the existing inbound message handler (the `if (msg.type === "transcript") {...} else if (msg.type === "audio_chunk") {...} else if (msg.type === "queued") {...}` chain around line 133-139):

```typescript
      if (msg.type === "transcript") {
        bus.publish("voice:transcript", { text: msg.text, sessionId, username });
      } else if (msg.type === "audio_chunk") {
        bus.publish("voice:audio-chunk", { data: msg.data, sessionId });
      } else if (msg.type === "queued") {
        bus.publish("voice:queued", { position: msg.position, sessionId });
      } else if (msg.type === "speak_done") {
        bus.publish("voice:speak-done", { sessionId });
      }
```

Then change the function signature and return statement:

```typescript
export function startAudioClient(socketPath: string, sessionId: string, username: string): { stop: () => void; sendAudioChunk: (pcmBytes: Buffer) => boolean } {
```

Replace the existing `return { stop: ... };` block (currently lines 170-182):

```typescript
  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      unsubscribeReply();
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (rl) rl.close();
      if (socket) socket.destroy();
    },
    sendAudioChunk: (pcmBytes: Buffer): boolean => {
      if (stopped || !socket || !socket.writable) return false;
      socket.write(JSON.stringify({ type: "audio_chunk", data: pcmBytes.toString("base64") }) + "\n");
      return true;
    },
  };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx tests/index.test.ts 2>&1 | grep -A5 "sendAudioChunk writes\|voice:speak-done"`
Expected: both PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/audio-client.ts tests/index.test.ts
git commit -m "feat: add sendAudioChunk and voice:speak-done to audio-client.ts"
```

---

### Task 2: `voice-session-manager.ts` — per-session audio forwarding

**Files:**
- Modify: `src/interaction/voice-session-manager.ts`
- Test: `tests/index.test.ts` (new test in the existing `VoiceSessionManager` category)

**Interfaces:**
- Consumes: Task 1's `sendAudioChunk(pcmBytes: Buffer): boolean` on the handle `startAudioClient` returns.
- Produces: `sendVoiceSessionAudioChunk(sessionId: string, pcmBytes: Buffer): boolean` — looks up the session, delegates to its `audioClient.sendAudioChunk`, returns `false` for an unknown `sessionId` (mirrors `destroyVoiceSession`'s existing lookup-and-delegate shape exactly). Task 5's `voice-stream-ws.ts` calls this; it never touches an `audioClient` reference directly.

- [ ] **Step 1: Write the failing test**

Add this test immediately after the existing `"two real concurrent daemon connections stay isolated per session"` test in the `VoiceSessionManager` category of `tests/index.test.ts`:

```typescript
registerTest("VoiceSessionManager", "sendVoiceSessionAudioChunk delegates to the right session's daemon connection, and returns false for an unknown sessionId", async () => {
  const os = await import("os");
  const path = await import("path");
  const net = await import("net");
  const manager = await import("../src/interaction/voice-session-manager.js");

  const socketPath = path.join(os.tmpdir(), `jarvis-voice-test-sendchunk-${Date.now()}.sock`);
  let receivedByDaemon = "";
  const fakeServer = net.createServer((conn) => {
    conn.on("data", (data) => { receivedByDaemon += data.toString(); });
  });
  await new Promise<void>((resolve) => fakeServer.listen(socketPath, resolve));

  const sessionId = manager.createVoiceSession(socketPath, "alice");
  try {
    await new Promise((resolve) => setTimeout(resolve, 200));

    const pcm = Buffer.from([9, 9, 9]);
    const sent = manager.sendVoiceSessionAudioChunk(sessionId, pcm);
    if (sent !== true) throw new Error("VoiceSessionManager: expected sendVoiceSessionAudioChunk to return true for a real session");

    await new Promise((resolve) => setTimeout(resolve, 200));
    const parsed = JSON.parse(receivedByDaemon.trim());
    if (parsed.type !== "audio_chunk" || parsed.data !== pcm.toString("base64")) {
      throw new Error(`VoiceSessionManager: expected the chunk to reach the daemon, got: ${receivedByDaemon}`);
    }

    const sentUnknown = manager.sendVoiceSessionAudioChunk("not-a-real-session-id", pcm);
    if (sentUnknown !== false) throw new Error("VoiceSessionManager: expected false for an unknown sessionId");
  } finally {
    manager.destroyVoiceSession(sessionId);
    fakeServer.close();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx tests/index.test.ts 2>&1 | grep -A5 "sendVoiceSessionAudioChunk delegates"`
Expected: FAIL — `manager.sendVoiceSessionAudioChunk is not a function`

- [ ] **Step 3: Write minimal implementation**

In `src/interaction/voice-session-manager.ts`, add this export immediately after the existing `getVoiceSessionUsername` function:

```typescript
/**
 * Forwards one raw PCM audio chunk into a still-active session's daemon
 * connection. Returns false (no throw) for an unknown sessionId or a
 * currently-unwritable connection -- callers (voice-stream-ws.ts) treat
 * false as "this frame was dropped," not a fatal error, since a session
 * can legitimately end mid-stream (the daemon fires an utterance-end
 * transcript, or the browser side disconnects) without every in-flight
 * frame being a bug.
 */
export function sendVoiceSessionAudioChunk(sessionId: string, pcmBytes: Buffer): boolean {
  const session = activeSessions.get(sessionId);
  if (!session) return false;
  return session.audioClient.sendAudioChunk(pcmBytes);
}
```

This requires `ManagedSession.audioClient`'s type to include `sendAudioChunk`. Update the interface near the top of the file:

```typescript
interface ManagedSession {
  username: string;
  audioClient: { stop: () => void; sendAudioChunk: (pcmBytes: Buffer) => boolean };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx tests/index.test.ts 2>&1 | grep -A5 "sendVoiceSessionAudioChunk delegates"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/interaction/voice-session-manager.ts tests/index.test.ts
git commit -m "feat: add sendVoiceSessionAudioChunk to voice-session-manager.ts"
```

---

### Task 3: `voice-session.ts` — per-session turn queueing

**Files:**
- Modify: `src/interaction/voice-session.ts:124-184` (the `startVoiceSession` function)
- Test: `tests/index.test.ts` (new test in the existing `VoiceSession` category)

**Interfaces:**
- Consumes: nothing new.
- Produces: no new exported interface — this is an internal concurrency fix. `startVoiceSession`'s external behavior (subscribes to `voice:transcript`, publishes `voice:reply`) is unchanged; only the internal serialization changes from "one queue for every session" to "one queue per session."

- [ ] **Step 1: Write the failing test**

Add this test immediately after the existing `"a voice:transcript event missing sessionId or username is dropped, not misattributed"` test in the `VoiceSession` category of `tests/index.test.ts`:

```typescript
registerTest("VoiceSession", "a slow session's turn does not delay a different session's reply", async () => {
  const { EventBus } = await import("../src/core/event-bus.js");
  const { startVoiceSession } = await import("../src/interaction/voice-session.js");

  const bus = EventBus.getInstance();
  const replies: Array<{ sessionId: string; at: number }> = [];
  const unsubscribe = bus.subscribe<{ sessionId: string }>("voice:reply", (payload) => {
    replies.push({ sessionId: payload.sessionId, at: Date.now() });
  });

  const fakeRouter = {
    generateWithFallback: async (username: string) => {
      if (username === "slow_user") {
        await new Promise((resolve) => setTimeout(resolve, 800));
      }
      return { choices: [{ message: { content: `Reply for ${username}`, tool_calls: undefined } }] };
    },
  } as any;

  const session = startVoiceSession({ router: fakeRouter, recall: (async () => []) as any });
  try {
    const startedAt = Date.now();
    bus.publish("voice:transcript", { text: "slow question", sessionId: "slow-session", username: "slow_user" });
    // Published second but must NOT wait behind the slow session above --
    // this is exactly the fix: independent per-sessionId queues.
    bus.publish("voice:transcript", { text: "fast question", sessionId: "fast-session", username: "fast_user" });

    await new Promise((resolve) => setTimeout(resolve, 300));
    const fastReply = replies.find((r) => r.sessionId === "fast-session");
    if (!fastReply) {
      throw new Error("VoiceSession: expected the fast session's reply well before the slow session's 800ms delay elapses");
    }
    if (fastReply.at - startedAt > 500) {
      throw new Error(`VoiceSession: fast session's reply took ${fastReply.at - startedAt}ms -- it was blocked behind the slow session`);
    }

    await new Promise((resolve) => setTimeout(resolve, 700));
    const slowReply = replies.find((r) => r.sessionId === "slow-session");
    if (!slowReply) throw new Error("VoiceSession: expected the slow session's reply to eventually arrive too");
  } finally {
    unsubscribe();
    session.stop();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx tests/index.test.ts 2>&1 | grep -A5 "a slow session's turn does not delay"`
Expected: FAIL — the fast session's reply arrives after ~800ms (blocked behind the slow one's shared queue), not within 500ms.

- [ ] **Step 3: Write minimal implementation**

In `src/interaction/voice-session.ts`, replace the single shared queue (currently lines 128-136):

```typescript
  // Per-call, not module-level: startVoiceSession() returns an independent
  // { stop } handle, so each call (e.g. a fresh instance in tests) must get
  // its own turn-queue registry rather than sharing one across every call
  // this process ever makes.
  //
  // Keyed by sessionId, not shared: two DIFFERENT sessions' turns now run
  // fully concurrently -- a slow LLM call for one user must never delay
  // another user's reply (this is the fix for the head-of-line-blocking
  // finding both the sub-project A final review and CodeRabbit raised).
  // Turns WITHIN one session still run strictly in order (a session's own
  // queue is still a promise chain), matching the original single-queue's
  // per-session guarantee -- only the cross-session sharing is removed.
  // Entries are deleted once a session's chain goes idle so this map never
  // grows unbounded across the lifetime of a long-running process serving
  // many short-lived ambient sessions.
  const turnQueues = new Map<string, Promise<void>>();
```

Replace the subscription body's queueing line (currently lines 157-176):

```typescript
    // Queue this session's turns sequentially (so its own tool loops never
    // race), independently of every other session's queue.
    const priorTurn = turnQueues.get(sessionId) ?? Promise.resolve();
    const thisTurn = priorTurn
      .then(() => handleTranscript(text, sessionId, username, deps, bus))
      .catch((err: any) => {
        // handleTranscript already catches every failure internally and
        // always publishes an honest reply rather than throwing -- this is
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
        bus.publish("voice:reply", { text: HONEST_PIPELINE_ERROR_REPLY, sessionId, username });
      });
    turnQueues.set(sessionId, thisTurn);
    thisTurn.then(() => {
      // Only clear this session's entry if nothing queued a NEWER turn
      // behind it while it was running -- otherwise a fast second turn
      // for the same session would lose its place in line.
      if (turnQueues.get(sessionId) === thisTurn) turnQueues.delete(sessionId);
    });
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx tests/index.test.ts 2>&1 | grep -A5 "a slow session's turn does not delay"`
Expected: PASS

- [ ] **Step 5: Run the full suite to confirm no regressions in the existing VoiceSession tests**

Run: `npx tsx tests/index.test.ts 2>&1 | grep -E "VoiceSession|TOTALS"`
Expected: every existing `VoiceSession`-category test still passes (per-session ordering is preserved; only cross-session sharing was removed).

- [ ] **Step 6: Commit**

```bash
git add src/interaction/voice-session.ts tests/index.test.ts
git commit -m "fix: give each voice session its own turn queue so one session never blocks another"
```

---

### Task 4: `voice.ambient` capability + `/api/voice-stream-ticket`

**Files:**
- Modify: `src/kernel/security.ts:35-129` (`ALL_CAPABILITIES` and `DEFAULT_PERSONAL_CAPABILITIES`)
- Modify: `src/server.ts` (new ticket issuance block, mirroring the existing `/api/events-ticket` block at lines 1381-1406)
- Test: `tests/index.test.ts` (new test in the `HTTP Boundary` category)

**Interfaces:**
- Consumes: nothing new.
- Produces: capability string `"voice.ambient"`; `POST /api/voice-stream-ticket` (auth: `validateApiKey` + `requireCapability("voice.ambient")`) returning `{ ticket: string }`; server-local functions `issueVoiceStreamTicket(username: string): string` and `consumeVoiceStreamTicket(ticket: string): string | null` (both defined in `server.ts`, same file Task 5's WS connection handler runs in, so Task 5 calls `consumeVoiceStreamTicket` directly without a new export).

Note: `requireCapability` itself (the gate mechanism) is already proven generic and correct by the existing `"requireCapability(\"vault.write\") rejects a user who holds identity.read but not vault.write"` test — it works for any capability string, so a test that only re-proves the mechanism in isolation would pass immediately without any of this task's actual new code, failing TDD's red-first requirement. What's genuinely new here is the ROUTE itself actually being wired with `validateApiKey` + `requireCapability("voice.ambient")` — exactly what the existing `"newly capability-gated routes reject unauthenticated requests and admit a granted admin"` test at `tests/index.test.ts:2116` proves for other routes, via a real spawned server (`spawnTestServer`). Match that pattern. Separately, once `"voice.ambient"` is added to `DEFAULT_PERSONAL_CAPABILITIES`, the existing `"every DEFAULT_PERSONAL_CAPABILITIES entry is a real, valid capability"` test (line 808) already fails for free if it's missing from `ALL_CAPABILITIES` — no new test needed for that invariant.

- [ ] **Step 1: Write the failing test**

Add this test to the `HTTP Boundary` category of `tests/index.test.ts`, immediately after the `"newly capability-gated routes reject unauthenticated requests and admit a granted admin"` test (ends around line 2165). Use port `3024` — not used by any other test in this file:

```typescript
registerTest("HTTP Boundary", "POST /api/voice-stream-ticket requires auth and returns a real ticket for a granted admin", async () => {
  const port = 3024;
  const child = await spawnTestServer(port, { INTERNAL_API_KEY: TEST_ADMIN_API_KEY });

  try {
    const noKey = await fetch(`http://127.0.0.1:${port}/api/voice-stream-ticket`, { method: "POST" });
    if (noKey.status !== 401) {
      throw new Error(`HTTP Boundary: expected 401 with no API key on POST /api/voice-stream-ticket, got ${noKey.status}`);
    }

    const adminRes = await fetch(`http://127.0.0.1:${port}/api/voice-stream-ticket`, {
      method: "POST",
      headers: { "X-API-Key": TEST_ADMIN_API_KEY },
    });
    if (adminRes.status !== 200) {
      throw new Error(`HTTP Boundary: expected 200 for an admin request, got ${adminRes.status}`);
    }
    const body = await adminRes.json();
    if (typeof body.ticket !== "string" || body.ticket.length === 0) {
      throw new Error(`HTTP Boundary: expected a real ticket string, got: ${JSON.stringify(body)}`);
    }
  } finally {
    await stopTestServer(child);
  }
});
```

(Uses the exact same `spawnTestServer`/`stopTestServer`/`TEST_ADMIN_API_KEY` helpers the neighboring test at line 2116 already uses — no new imports needed.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx tests/index.test.ts 2>&1 | grep -A5 "voice-stream-ticket"`
Expected: FAIL — `404` (the route doesn't exist yet).

- [ ] **Step 3: Write minimal implementation**

In `src/kernel/security.ts`, add the new capability to `ALL_CAPABILITIES` immediately after `"tts.speak",` (line 53):

```typescript
  "tts.speak",
  // Gates POST /api/voice-stream-ticket (src/server.ts) -- issuing a
  // short-lived ticket to open the ambient wake-word /ws/voice-stream
  // WebSocket. Kept separate from tts.speak (reply playback) since a user
  // could reasonably be granted one without the other (e.g. click-to-talk
  // only, no ambient listening).
  "voice.ambient",
```

Add it to `DEFAULT_PERSONAL_CAPABILITIES` immediately after `"tts.speak",` (line 120):

```typescript
  "tts.speak",
  "voice.ambient",
```

In `src/server.ts`, add this block immediately after the existing `/api/events-ticket` route (immediately after line 1406, before the `PostgreSQL connection parameters` comment):

```typescript
// One-time tickets for /ws/voice-stream -- same rationale as the
// /ws/events tickets immediately above: a browser WebSocket handshake
// can't carry a custom X-API-Key header, so identity crosses via a
// short-lived, single-use ticket obtained through a normal authenticated
// POST instead. Kept as its own Map/TTL rather than reusing eventsTickets
// so a ticket meant for one WS endpoint can never be replayed against the
// other.
const VOICE_STREAM_TICKET_TTL_MS = 30_000;
const voiceStreamTickets = new Map<string, { username: string; expiresAt: number }>();

function issueVoiceStreamTicket(username: string): string {
  const now = Date.now();
  for (const [t, v] of voiceStreamTickets) {
    if (v.expiresAt < now) voiceStreamTickets.delete(t);
  }
  const ticket = crypto.randomBytes(24).toString("hex");
  voiceStreamTickets.set(ticket, { username, expiresAt: now + VOICE_STREAM_TICKET_TTL_MS });
  return ticket;
}

function consumeVoiceStreamTicket(ticket: string): string | null {
  const entry = voiceStreamTickets.get(ticket);
  voiceStreamTickets.delete(ticket);
  if (!entry || entry.expiresAt < Date.now()) return null;
  return entry.username;
}

app.post("/api/voice-stream-ticket", validateApiKey, requireCapability("voice.ambient"), (req: any, res: any) => {
  res.json({ ticket: issueVoiceStreamTicket(req.username) });
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx tests/index.test.ts 2>&1 | grep -A5 "voice-stream-ticket"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/kernel/security.ts src/server.ts tests/index.test.ts
git commit -m "feat: add voice.ambient capability and /api/voice-stream-ticket"
```

---

### Task 5: `/ws/voice-stream` — the mic-streaming WebSocket

**Files:**
- Create: `src/interaction/voice-stream-ws.ts`
- Modify: `src/server.ts` (new `voiceStreamWss` instance, its `"connection"` handler doing ticket/API-key auth then delegating, and extending the existing `httpServer.on("upgrade", ...)` routing)
- Test: `tests/index.test.ts` (new tests in a new `VoiceStreamWs` category)

**Interfaces:**
- Consumes: Task 2's `sendVoiceSessionAudioChunk(sessionId, pcmBytes): boolean`; Sub-project A's `createVoiceSession(socketPath, username): string` and `destroyVoiceSession(sessionId): boolean`; Task 1's `voice:speak-done` (`{ sessionId }`) and the existing `voice:audio-chunk` (`{ data, sessionId }`) bus events; Task 4's `consumeVoiceStreamTicket` (called from `server.ts`, same file it's defined in); this task's own new `tts.ts` exports, `pcm16ToWav(pcm: Buffer, sampleRate: number): Buffer` and `KOKORO_SAMPLE_RATE`.
- Produces: `handleVoiceStreamConnection(ws: WebSocket, username: string, socketPath: string): void` — the full per-connection lifecycle (session creation, inbound frame forwarding, accumulating and relaying reply audio, `voice:error` handling, cleanup). `server.ts` calls this after authenticating; nothing else needs to import it.

- [ ] **Step 1: Export what Task 5 needs from `tts.ts`**

In `src/interaction/tts.ts`, add `export` to the two existing private declarations (no other change):

```typescript
export const KOKORO_SAMPLE_RATE = 24000;
```

```typescript
export function pcm16ToWav(pcm: Buffer, sampleRate: number): Buffer {
```

- [ ] **Step 2: Write the failing test**

Add this new test category to `tests/index.test.ts`, after the last `VoiceSessionManager` test and before the `HealthWatchdog` tests:

```typescript
// ---------- VoiceStreamWs Tests ----------
registerTest("VoiceStreamWs", "forwards inbound binary frames to the daemon as audio_chunk, and ignores an unrelated session's voice:error", async () => {
  const os = await import("os");
  const path = await import("path");
  const net = await import("net");
  const { WebSocketServer, WebSocket } = await import("ws");
  const { EventBus } = await import("../src/core/event-bus.js");
  const { handleVoiceStreamConnection } = await import("../src/interaction/voice-stream-ws.js");

  const daemonSocketPath = path.join(os.tmpdir(), `jarvis-voice-test-wsstream-${Date.now()}.sock`);
  let receivedByDaemon = "";
  const fakeDaemon = net.createServer((conn) => {
    conn.on("data", (data) => { receivedByDaemon += data.toString(); });
  });
  await new Promise<void>((resolve) => fakeDaemon.listen(daemonSocketPath, resolve));

  const testWss = new WebSocketServer({ port: 0 });
  const port = (testWss.address() as any).port;
  testWss.on("connection", (ws) => {
    handleVoiceStreamConnection(ws as any, "alice", daemonSocketPath);
  });

  const client = new WebSocket(`ws://127.0.0.1:${port}`);
  const clientMessages: any[] = [];
  client.on("message", (data) => { clientMessages.push(JSON.parse(data.toString())); });
  let clientClosed = false;
  client.on("close", () => { clientClosed = true; });

  try {
    await new Promise<void>((resolve) => client.on("open", () => resolve()));
    await new Promise((resolve) => setTimeout(resolve, 200));

    const pcm = Buffer.from([1, 2, 3]);
    client.send(pcm);
    await new Promise((resolve) => setTimeout(resolve, 200));

    const parsed = JSON.parse(receivedByDaemon.trim());
    if (parsed.type !== "audio_chunk" || parsed.data !== pcm.toString("base64")) {
      throw new Error(`VoiceStreamWs: expected the frame forwarded as audio_chunk, got: ${receivedByDaemon}`);
    }

    // This connection's real sessionId is internal (a fresh
    // crypto.randomUUID() from createVoiceSession) -- there is no public
    // "list sessions" API by design. The full happy path (matching
    // sessionId, real turn_complete payload) is proven end to end by the
    // round-trip test below; this test only proves the session-scoping
    // guard itself: an event for a sessionId that can't possibly be this
    // connection's must never affect it.
    const bus = EventBus.getInstance();
    bus.publish("voice:error", { message: "not for this connection", sessionId: "definitely-not-this-sessions-id" });
    await new Promise((resolve) => setTimeout(resolve, 200));
    if (clientClosed) {
      throw new Error("VoiceStreamWs: an unrelated session's voice:error must not close this connection");
    }
  } finally {
    client.close();
    testWss.close();
    fakeDaemon.close();
  }
});

registerTest("VoiceStreamWs", "a full round trip: connect, stream audio, daemon transcribes and synthesizes, turn_complete carries a real playable WAV", async () => {
  const os = await import("os");
  const path = await import("path");
  const net = await import("net");
  const readline = await import("readline");
  const { WebSocketServer, WebSocket } = await import("ws");
  const { handleVoiceStreamConnection } = await import("../src/interaction/voice-stream-ws.js");
  const { startVoiceSession } = await import("../src/interaction/voice-session.js");

  const daemonSocketPath = path.join(os.tmpdir(), `jarvis-voice-test-wsroundtrip-${Date.now()}.sock`);
  const fakeReplyPcm = Buffer.from([10, 20, 30, 40]);
  const fakeDaemon = net.createServer((conn) => {
    const rl = readline.createInterface({ input: conn });
    let transcriptSent = false;
    rl.on("line", (line) => {
      let msg: any;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.type === "audio_chunk" && !transcriptSent) {
        // Simulate the real daemon's UtteranceEndDetector firing on the
        // first chunk of mic audio it receives.
        transcriptSent = true;
        conn.write(JSON.stringify({ type: "transcript", text: "what time is it" }) + "\n");
      } else if (msg.type === "speak") {
        // Simulate synthesis: one audio_chunk of fake reply PCM, then
        // speak_done, exactly matching daemon/voice_engine.py's real
        // _handle_speak sequence.
        conn.write(JSON.stringify({ type: "audio_chunk", data: fakeReplyPcm.toString("base64") }) + "\n");
        conn.write(JSON.stringify({ type: "speak_done" }) + "\n");
      }
    });
  });
  await new Promise<void>((resolve) => fakeDaemon.listen(daemonSocketPath, resolve));

  const fakeRouter = {
    generateWithFallback: async () => ({
      choices: [{ message: { content: "It's time to build.", tool_calls: undefined } }],
    }),
  } as any;
  const sessionHandle = startVoiceSession({ router: fakeRouter, recall: (async () => []) as any });

  const testWss = new WebSocketServer({ port: 0 });
  const port = (testWss.address() as any).port;
  testWss.on("connection", (ws) => {
    handleVoiceStreamConnection(ws as any, "alice", daemonSocketPath);
  });

  const client = new WebSocket(`ws://127.0.0.1:${port}`);
  const clientMessages: any[] = [];
  client.on("message", (data) => { clientMessages.push(JSON.parse(data.toString())); });
  const closed = new Promise<void>((resolve) => client.on("close", () => resolve()));

  try {
    await new Promise<void>((resolve) => client.on("open", () => resolve()));
    await new Promise((resolve) => setTimeout(resolve, 200));
    client.send(Buffer.from([1, 2, 3, 4]));

    await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error("timed out waiting for the connection to close")), 3000))]);

    const turnComplete = clientMessages.find((m) => m.type === "turn_complete");
    if (!turnComplete) {
      throw new Error(`VoiceStreamWs: expected a turn_complete message before close, got: ${JSON.stringify(clientMessages)}`);
    }
    if (turnComplete.mimeType !== "audio/wav" || typeof turnComplete.audio !== "string") {
      throw new Error(`VoiceStreamWs: expected turn_complete to carry a base64 audio/wav payload, got: ${JSON.stringify(turnComplete)}`);
    }
    const wavBytes = Buffer.from(turnComplete.audio, "base64");
    // A valid minimal WAV: "RIFF" header, "WAVE" format tag, and the raw
    // PCM bytes present verbatim after the 44-byte header -- proving this
    // is a real, well-formed container built from the exact bytes the
    // fake daemon sent, not a stub or an empty buffer.
    if (wavBytes.toString("ascii", 0, 4) !== "RIFF" || wavBytes.toString("ascii", 8, 12) !== "WAVE") {
      throw new Error("VoiceStreamWs: turn_complete's audio is not a well-formed WAV file");
    }
    if (!wavBytes.subarray(44).equals(fakeReplyPcm)) {
      throw new Error("VoiceStreamWs: expected the WAV's PCM data to match the fake daemon's exact synthesized bytes");
    }
  } finally {
    client.close();
    testWss.close();
    fakeDaemon.close();
    sessionHandle.stop();
  }
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx tsx tests/index.test.ts 2>&1 | grep -A5 "VoiceStreamWs"`
Expected: FAIL — `Cannot find module '../src/interaction/voice-stream-ws.js'`

- [ ] **Step 4: Write minimal implementation**

Create `src/interaction/voice-stream-ws.ts`:

```typescript
import { WebSocket } from "ws";
import { EventBus } from "../core/event-bus.js";
import { ObservationPlatform } from "../kernel/observation.js";
import { createVoiceSession, destroyVoiceSession, sendVoiceSessionAudioChunk } from "./voice-session-manager.js";
import { pcm16ToWav, KOKORO_SAMPLE_RATE } from "./tts.js";

const observation = ObservationPlatform.getInstance();

/**
 * Handles one already-authenticated /ws/voice-stream connection end to
 * end: opens a fresh per-connection voice session, forwards every inbound
 * binary frame into it as a raw PCM audio_chunk, accumulates the reply
 * audio the daemon streams back (voice:audio-chunk) until the daemon
 * signals it's done synthesizing (voice:speak-done), then sends the whole
 * reply as one playable WAV blob in a single "turn_complete" control
 * message and closes -- or relays voice:error and closes, on failure.
 *
 * Deliberately does NOT subscribe to voice:reply: that event fires the
 * moment a text reply exists and synthesis has just been REQUESTED, not
 * when the audio is actually finished streaming -- closing on voice:reply
 * would truncate the reply. voice:speak-done is the precise "audio is
 * done" signal (see audio-client.ts).
 *
 * server.ts owns authentication (ticket/X-API-Key) and wiring this into
 * its own httpServer "upgrade" dispatch -- this function starts from an
 * already-known-good username, which keeps it independently testable
 * (see tests/index.test.ts's VoiceStreamWs category) without needing a
 * full authenticated HTTP round trip.
 */
export function handleVoiceStreamConnection(ws: WebSocket, username: string, socketPath: string): void {
  const bus = EventBus.getInstance();
  const sessionId = createVoiceSession(socketPath, username);
  let closed = false;
  const audioChunks: Buffer[] = [];

  let unsubAudioChunk: () => void = () => {};
  let unsubSpeakDone: () => void = () => {};
  let unsubError: () => void = () => {};

  const finish = (reason: "reply" | "error" | "client-closed", message?: string) => {
    if (closed) return;
    closed = true;
    unsubAudioChunk();
    unsubSpeakDone();
    unsubError();
    if (ws.readyState === ws.OPEN) {
      if (reason === "reply") {
        const pcm = Buffer.concat(audioChunks);
        const wav = pcm16ToWav(pcm, KOKORO_SAMPLE_RATE);
        ws.send(JSON.stringify({ type: "turn_complete", mimeType: "audio/wav", audio: wav.toString("base64") }));
      } else if (reason === "error") {
        ws.send(JSON.stringify({ type: "error", message: message || "Voice pipeline error" }));
      }
      ws.close();
    }
    destroyVoiceSession(sessionId);
    observation.logTelemetry("info", "VoiceStreamWs", `/ws/voice-stream session ${sessionId} for "${username}" ended (${reason}).`);
  };

  unsubAudioChunk = bus.subscribe<{ sessionId?: string; data?: string }>("voice:audio-chunk", (payload) => {
    if (payload?.sessionId !== sessionId || typeof payload.data !== "string") return;
    audioChunks.push(Buffer.from(payload.data, "base64"));
  });
  unsubSpeakDone = bus.subscribe<{ sessionId?: string }>("voice:speak-done", (payload) => {
    if (payload?.sessionId !== sessionId) return;
    finish("reply");
  });
  unsubError = bus.subscribe<{ sessionId?: string; message?: string }>("voice:error", (payload) => {
    if (payload?.sessionId !== sessionId) return;
    finish("error", payload.message);
  });

  observation.logTelemetry("info", "VoiceStreamWs", `/ws/voice-stream session ${sessionId} opened for "${username}".`);

  ws.on("message", (data: Buffer, isBinary: boolean) => {
    if (closed || !isBinary) return;
    sendVoiceSessionAudioChunk(sessionId, data);
  });

  ws.on("error", (err: any) => {
    observation.logTelemetry("warn", "VoiceStreamWs", `/ws/voice-stream socket error for session ${sessionId}: ${err?.message || err}`);
  });

  ws.on("close", () => {
    finish("client-closed");
  });
}
```

In `src/server.ts`, add the import near the other `voice-session`-related imports (immediately after line 70's `import { destroyAllVoiceSessions } ...`):

```typescript
import { handleVoiceStreamConnection } from "./interaction/voice-stream-ws.js";
```

Add a new module-level variable next to `let eventsWss: WebSocketServer | undefined;` (line 77):

```typescript
let voiceStreamWss: WebSocketServer | undefined;
```

Immediately after the `eventsWss.on("connection", ...)` block closes (after line 1504, before `httpServer.on("upgrade", ...)`), add:

```typescript
  const DEFAULT_VOICE_DAEMON_SOCKET = "/tmp/jarvis-voice/voice.sock";
  voiceStreamWss = new WebSocketServer({ noServer: true });
  voiceStreamWss.on("connection", (ws, req) => {
    const url = new URL(req.url || "", `http://${req.headers.host}`);
    const ticket = url.searchParams.get("ticket");
    const apiKeyHeader = req.headers["x-api-key"];

    let username: string | null = null;
    if (ticket) {
      username = consumeVoiceStreamTicket(ticket);
    } else if (
      typeof apiKeyHeader === "string" &&
      typeof ADMIN_API_KEY === "string" &&
      ADMIN_API_KEY.length > 0 &&
      safeCompare(apiKeyHeader, ADMIN_API_KEY)
    ) {
      username = "admin";
    }

    if (!username) {
      ws.send(JSON.stringify({ type: "error", message: "Missing or invalid/expired voice-stream ticket, and no valid X-API-Key header." }));
      ws.close();
      return;
    }

    handleVoiceStreamConnection(ws, username, process.env.VOICE_DAEMON_SOCKET || DEFAULT_VOICE_DAEMON_SOCKET);
  });
```

Update the existing `httpServer.on("upgrade", ...)` handler (currently lines 1506-1523) to route both paths:

```typescript
  httpServer.on("upgrade", (req, socket, head) => {
    let pathname: string;
    try {
      ({ pathname } = new URL(req.url || "", `http://${req.headers.host}`));
    } catch {
      socket.destroy();
      return;
    }

    if (pathname === "/ws/events" && eventsWss) {
      const wss = eventsWss;
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    } else if (pathname === "/ws/voice-stream" && voiceStreamWss) {
      const wss = voiceStreamWss;
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    } else {
      socket.destroy();
    }
  });
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx tsx tests/index.test.ts 2>&1 | grep -A5 "VoiceStreamWs"`
Expected: PASS

- [ ] **Step 6: Run the full suite**

Run: `npx tsc --noEmit && npm test`
Expected: `tsc` clean. Test count increases by 7 over whatever `npm test` reported immediately before Task 1 started (2 new tests from Task 1, 1 each from Tasks 2, 3, and 4, 2 from Task 5). Confirm no NEW failures beyond whatever this dev environment's pre-existing baseline already was (this worktree lacks live Postgres, which has caused a fixed set of ~16 `HTTP Boundary`/`Auth`-category failures throughout this codebase's history, unrelated to any of this work — Task 4's new test doesn't touch Postgres at all, so it should pass cleanly even here, but confirm against the actual pre-Task-1 count rather than assuming).

- [ ] **Step 7: Commit**

```bash
git add src/interaction/voice-stream-ws.ts src/interaction/tts.ts src/server.ts tests/index.test.ts
git commit -m "feat: add /ws/voice-stream, the mic-streaming WebSocket for ambient voice"
```

---

### Task 6: Browser wake-word listener + UI wiring

**Files:**
- Create: `src/interaction/static/wake-word.js`
- Modify: `src/interaction/static/index.html` (add the ambient-listening toggle control, load `wake-word.js`)
- Modify: `src/server.ts:143-180` (CSP: add `'wasm-unsafe-eval'` to `scriptSrc` — required for `WebAssembly.instantiate` under a strict CSP with no `unsafe-eval`; everything else Porcupine needs is already covered since its WASM/model files are vendored locally under `src/interaction/static/`, served from `'self'`)

**Interfaces:**
- Consumes: Task 4's `POST /api/voice-stream-ticket`; Task 5's `/ws/voice-stream` (including its `turn_complete`/`error` control-message shape); the existing `playAudioBase64(mimeType, base64)` function already defined in `index.html` (`index.html:2414`).
- Produces: nothing other tasks depend on — this is the terminal component.

**Prerequisite outside this plan's control:** Picovoice Porcupine requires a free `AccessKey` from `console.picovoice.ai`, tied to a Picovoice account. This cannot be provisioned by an automated agent — get a free key and vendor Porcupine's Web SDK files (WASM binary, worker script, and the built-in `Jarvis` keyword model file — all downloadable from Picovoice's own Web SDK package, `@picovoice/porcupine-web` and `@picovoice/web-voice-processor`) into `src/interaction/static/vendor/porcupine/` before Step 3 below can actually run in a real browser. Steps 1-2 and the CSP change do not require this; the manual verification in Step 6 does.

- [ ] **Step 1: Add the CSP directive**

In `src/server.ts`, change line 147:

```typescript
      scriptSrc: ["'self'", "'unsafe-inline'", "https://unpkg.com"],
```

to:

```typescript
      // 'wasm-unsafe-eval' is required for WebAssembly.instantiate to run
      // under this CSP at all (Porcupine's wake-word engine is WASM) --
      // without it, wake-word.js's WASM module load throws a CSP
      // violation in any browser enforcing this policy strictly. Every
      // other resource Porcupine needs (its worker script, .wasm binary,
      // and the "Jarvis" keyword model file) is vendored locally under
      // src/interaction/static/vendor/porcupine/ and served from 'self',
      // so no connect-src/worker-src change is needed alongside this.
      scriptSrc: ["'self'", "'unsafe-inline'", "https://unpkg.com", "'wasm-unsafe-eval'"],
```

- [ ] **Step 2: Verify the change compiles**

Run: `npx tsc --noEmit`
Expected: clean (this is a string literal change, not a logic change — this step just confirms nothing else in `server.ts` broke).

- [ ] **Step 3: Create the wake-word listener module**

Create `src/interaction/static/wake-word.js`:

```javascript
// Ambient wake-word listening: Picovoice Porcupine detects "Jarvis"
// entirely on-device (no network traffic) while enabled and idle. On
// detection, opens a one-way WebSocket to /ws/voice-stream and streams
// raw mono 16-bit PCM at 16kHz -- the exact format daemon/models.py's STT
// expects (see src/core/audio-client.ts's transcribeOverSocket doc
// comment) -- until the server sends back a "turn_complete" (carrying the
// complete reply as one base64 WAV blob, already assembled server-side
// from the daemon's own synthesized audio -- see voice-stream-ws.ts) or
// "error" control message. Reply playback calls the SAME playAudioBase64
// this page already uses elsewhere for a server-synthesized reply arriving
// over a different channel -- this module adds no new audio DECODING or
// raw-PCM playback code of its own.
//
// State machine, one turn at a time:
//   idle (wake-word listening) -> streaming (WS open, sending PCM)
//     -> idle again, either on a server "turn_complete"/"error" control
//        message, or on the WS closing for any other reason.
// A new wake-word detection while already "streaming" is ignored --
// guarded by the `streaming` flag below -- so a false re-trigger mid-turn
// can never open a second concurrent stream for the same tab.

const TARGET_SAMPLE_RATE = 16000;

let streaming = false;
let porcupineWorker = null;
let audioContext = null;
let micStream = null;
let ws = null;

async function fetchVoiceStreamTicket() {
  const apiKey = window.CURRENT_API_KEY; // set elsewhere in index.html's existing auth flow
  const res = await fetch("/api/voice-stream-ticket", {
    method: "POST",
    headers: { "X-API-Key": apiKey },
  });
  if (!res.ok) {
    throw new Error(`Failed to obtain a voice-stream ticket: HTTP ${res.status}`);
  }
  const body = await res.json();
  return body.ticket;
}

// Downsamples a Float32Array captured at the AudioContext's native sample
// rate down to TARGET_SAMPLE_RATE mono 16-bit PCM. Simple linear-interp
// decimation -- adequate for speech-to-text input (Whisper itself resamples
// internally for a lot of its own training data), not audiophile-grade,
// which this doesn't need to be. This is the OUTBOUND (mic-capture)
// direction only -- there is no corresponding downstream/decode step in
// this file, since the reply comes back as a complete, already-encoded
// WAV blob (see the "turn_complete" handling in ws.onmessage below), not
// raw PCM this module would need to decode itself.
function downsampleTo16kHzPcm16(float32Input, inputSampleRate) {
  const ratio = inputSampleRate / TARGET_SAMPLE_RATE;
  const outputLength = Math.floor(float32Input.length / ratio);
  const pcm16 = new Int16Array(outputLength);
  for (let i = 0; i < outputLength; i++) {
    const srcIndex = Math.floor(i * ratio);
    const sample = Math.max(-1, Math.min(1, float32Input[srcIndex]));
    pcm16[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return pcm16;
}

async function startStreamingTurn() {
  if (streaming) return; // guard: ignore a re-trigger while a turn is already in progress
  streaming = true;

  try {
    const ticket = await fetchVoiceStreamTicket();
    const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${wsProtocol}//${window.location.host}/ws/voice-stream?ticket=${encodeURIComponent(ticket)}`);

    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioContext.createMediaStreamSource(micStream);
    const processor = audioContext.createScriptProcessor(4096, 1, 1);

    processor.onaudioprocess = (event) => {
      if (!streaming || !ws || ws.readyState !== WebSocket.OPEN) return;
      const input = event.inputBuffer.getChannelData(0);
      const pcm16 = downsampleTo16kHzPcm16(input, audioContext.sampleRate);
      ws.send(pcm16.buffer);
    };

    source.connect(processor);
    processor.connect(audioContext.destination);

    // The server never sends binary frames back on this connection -- only
    // these two JSON control messages -- so event.data is always a string
    // here; no ws.binaryType setting is needed.
    ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.type === "turn_complete") {
        if (msg.audio && typeof playAudioBase64 === "function") {
          playAudioBase64(msg.mimeType || "audio/wav", msg.audio);
        }
        endStreamingTurn();
      } else if (msg.type === "error") {
        console.warn("Ambient voice error:", msg.message);
        if (typeof addNotification === "function") {
          addNotification(`Ambient listening error: ${msg.message}`, "danger");
        }
        endStreamingTurn();
      }
    };

    ws.onclose = () => {
      endStreamingTurn();
    };
    ws.onerror = () => {
      endStreamingTurn();
    };
  } catch (err) {
    console.error("Failed to start ambient voice turn:", err);
    endStreamingTurn();
  }
}

function endStreamingTurn() {
  streaming = false;
  if (micStream) {
    micStream.getTracks().forEach((track) => track.stop());
    micStream = null;
  }
  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }
  if (ws) {
    try { ws.close(); } catch {}
    ws = null;
  }
  // Re-arm wake-word listening for the next "Jarvis."
  if (porcupineWorker) {
    porcupineWorker.postMessage({ command: "resume" });
  }
}

// Public entry points wired to the ambient-listening toggle in index.html.
async function enableAmbientListening() {
  if (porcupineWorker) return; // already enabled
  // Porcupine Web SDK initialization (AccessKey + vendored model files) --
  // see this task's Prerequisite note. PorcupineWorker is the SDK's own
  // class, loaded via a <script type="module"> import in index.html
  // pointed at the vendored src/interaction/static/vendor/porcupine/ files.
  porcupineWorker = await PorcupineWorkerFactory.create(
    window.PORCUPINE_ACCESS_KEY,
    [{ builtin: "Jarvis" }],
    (detection) => {
      if (detection) startStreamingTurn();
    }
  );
  await WebVoiceProcessor.subscribe(porcupineWorker);
}

function disableAmbientListening() {
  if (!porcupineWorker) return;
  WebVoiceProcessor.unsubscribe(porcupineWorker);
  porcupineWorker.terminate();
  porcupineWorker = null;
  if (streaming) endStreamingTurn();
}
```

- [ ] **Step 4: Wire the toggle into `index.html`**

Add a new toggle button in `src/interaction/static/index.html`, next to the existing `btn-mic-toggle` click-to-talk button (search for that id to find the right spot):

```html
<button onclick="toggleAmbientListening()" id="btn-ambient-toggle" title="Ambient wake-word listening" class="relative p-2 rounded-full text-secondary hover:text-white hover:bg-white/5 transition-all">
  <span id="ambient-status-dot" class="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-primary hidden"></span>
</button>
```

Add the corresponding toggle function and script imports near the file's other `<script>` tags:

```html
<script type="module" src="vendor/porcupine/porcupine-web.js"></script>
<script type="module" src="vendor/porcupine/web-voice-processor.js"></script>
<script src="wake-word.js"></script>
<script>
  let ambientListeningEnabled = false;
  async function toggleAmbientListening() {
    const dot = document.getElementById('ambient-status-dot');
    if (ambientListeningEnabled) {
      disableAmbientListening();
      ambientListeningEnabled = false;
      if (dot) dot.classList.add('hidden');
      addNotification("Ambient listening disabled.", "warning");
    } else {
      try {
        await enableAmbientListening();
        ambientListeningEnabled = true;
        if (dot) dot.classList.remove('hidden');
        addNotification("Ambient listening enabled — say \"Jarvis\" any time.", "success");
      } catch (err) {
        addNotification(`Couldn't enable ambient listening: ${err.message || err}`, "danger");
      }
    }
  }
</script>
```

- [ ] **Step 5: Verify the static assets serve correctly**

Run: `npx tsc --noEmit && npm test`
Expected: both clean/passing — `.js`/`.html` static files aren't compiled or exercised by the existing test suite, so this step confirms the CSP/import changes didn't break anything the suite *does* cover (route registration, capability gates, etc.).

- [ ] **Step 6: Manual verification checklist (requires a real Picovoice AccessKey and a real browser — not automatable in this environment)**

1. Obtain a free AccessKey from `console.picovoice.ai`, set `window.PORCUPINE_ACCESS_KEY` (e.g. via a small server-rendered `<script>` block reading an env var, or a config endpoint — pick whichever this codebase's existing client-config pattern already uses).
2. Vendor Porcupine's Web SDK files into `src/interaction/static/vendor/porcupine/` per the SDK's own packaging instructions.
3. Open the dashboard in a real browser, sign in, click the new ambient-listening toggle, grant microphone permission.
4. Say "Jarvis," then ask a real question. Confirm: the WS opens (check DevTools Network tab), a spoken reply plays, and the toggle's dot stays lit (still listening) afterward — say "Jarvis" again to confirm it re-armed correctly.
5. Open a second browser (or a private/incognito window) signed in as a different user, repeat step 4 concurrently with the first still ambient-listening. Confirm neither user's turn is delayed by the other, and replies never cross between the two sessions.
6. Deny microphone permission once, confirm a clear, honest error notification appears (not a silent failure) and the toggle reflects the disabled state.

- [ ] **Step 7: Commit**

```bash
git add src/interaction/static/wake-word.js src/interaction/static/index.html src/server.ts
git commit -m "feat: ambient wake-word listening (browser Porcupine + /ws/voice-stream client)"
```

---

## Final Verification

Run: `npx tsc --noEmit && npm test`
Expected: `tsc` clean; test count is the pre-Task-1 baseline + 7 new automated tests (2 from Task 1, 1 each from Tasks 2-4, 2 from Task 5; Task 6 has no automated tests per this plan's Global Constraints), with no new failures beyond this dev environment's pre-existing baseline (unrelated ~16 `HTTP Boundary`/`Auth` failures from missing live Postgres in this worktree).
