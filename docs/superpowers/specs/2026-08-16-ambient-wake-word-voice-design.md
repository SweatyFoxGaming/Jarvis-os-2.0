# Ambient Wake-Word Voice — Design Spec

## Problem

Sub-project A (`docs/superpowers/specs/2026-08-16-per-user-voice-session-design.md`, PR #151) made the voice-session pipeline (`voice-session.ts`, `audio-client.ts`, `voice-session-manager.ts`) genuinely per-user/per-session, but it ships dormant: `createVoiceSession` has no production caller. Today the only working voice path is click-to-talk (`/api/voice-input`), a manual one-shot recording that a user has to click a button to start.

The original goal (per the user's own 3-phase plan) was "always-listening ambient interaction" — no click required, just say "Jarvis" and talk. An earlier version of this codebase had exactly that (a browser-based always-on mic bridge with wake-word gating over `/ws/voice`, talking to Gemini Live), but it was deliberately removed when the local voice daemon replaced Gemini Live for STT/TTS (see the comment at `src/interaction/static/index.html:1851-1868`). This sub-project rebuilds that capability, pointed at the new daemon/session-manager instead, and — unlike the old version — needs to support multiple concurrent per-user sessions rather than one shared identity.

The daemon itself already has unused, purpose-built support for this: `daemon/voice_engine.py`'s `handle_connection` already accepts a streaming `audio_chunk` message type with automatic voice-activity/utterance-end detection (`UtteranceEndDetector`), and already enforces a max-utterance-size safety valve. Nothing has ever called it.

## Goal

A user can enable "ambient listening" from their dashboard tab, say "Jarvis," speak, and get a spoken reply — without clicking anything — while their tab stays open. Multiple users can do this concurrently, each fully isolated (built on Sub-project A's guarantees), and a slow reply for one user must not delay another user's reply.

## Design, confirmed with the project owner before implementation

### Where wake-word detection happens

Detection runs **client-side**, in each user's own browser tab, using Picovoice Porcupine's WASM SDK and its built-in `"Jarvis"` keyword (one of Porcupine's free default keywords — no custom model training needed). Raw audio never leaves the device until the wake word fires. This was chosen over server-side detection specifically because it keeps audio local until there's something worth sending — continuously streaming raw mic audio to the server regardless of whether anyone is speaking would work against the reason a lightweight on-device wake-word engine was chosen in the first place.

Ambient listening only works while the user's dashboard tab is open (foreground or background) — there is no true background/system-level listener. A native companion app or browser extension would be required for that and is out of scope here.

### New component: `src/interaction/static/wake-word.js`

Browser-side. Wraps Porcupine WASM. Exposes an "ambient listening" toggle (new UI control, off by default — this is an opt-in feature, not automatically enabled for existing users). While enabled and idle: runs wake-word detection only, no network traffic. On detection:

1. Guards against re-triggering while a turn is already in progress (ignore new detections until the current WS closes).
2. Opens a WebSocket to `/ws/voice-stream`.
3. Streams raw PCM audio chunks (base64-encoded, matching the daemon's existing `audio_chunk` wire format) over that WS until it's told the turn ended (WS close from the server) or a `voice:error` control frame arrives. **Format is load-bearing:** `daemon/models.py`'s STT path never resamples — it assumes the PCM bytes it receives are already mono 16-bit little-endian at the exact sample rate the Whisper model expects. Click-to-talk's one-shot path (`whisper.ts`) gets away with recording whatever format `MediaRecorder` produces because it runs the result through `ffmpeg` server-side first; the streaming `audio_chunk` path has no such conversion step. `wake-word.js` must capture and downsample directly to that target format client-side (e.g. via an `AudioWorklet`/`AudioContext` at the matching sample rate), not just hand `MediaRecorder`'s native output to the socket — the plan must pin down and verify the exact target sample rate against `daemon/models.py`'s actual Whisper model config before implementing this.
4. On successful completion, plays the reply through the **existing** `/api/integrations/tts/speak` HTTP call the click-to-talk button already uses — this sub-project adds no new audio-*out* plumbing.
5. Re-arms wake-word listening once playback finishes (or immediately, on error).

### New component: `src/interaction/voice-stream-ws.ts`

Server-side `/ws/voice-stream` WebSocket handler, kept in its own module rather than added to `server.ts` (already large), matching how `voice-session-manager.ts` got its own file.

**Auth:** reuses the exact ticket/`X-API-Key` dual pattern `/ws/events` already implements (`server.ts`'s `issueEventsTicket`/`consumeEventsTicket`, `POST /api/events-ticket`) — a new, parallel short-lived single-use ticket type issued via a new `POST /api/voice-stream-ticket` endpoint (capability-gated the same way `/api/events-ticket` requires `hud.read`; this endpoint should require whatever capability already gates voice/ambient features, or a new narrowly-scoped one if none exists — a plan-level decision, not a spec-level one), since a browser WebSocket handshake can't carry a custom header either way. Not a new auth mechanism, the same one used elsewhere.

**On connect:** calls `createVoiceSession(socketPath, username)` to get a fresh per-user daemon connection and `sessionId`.

**On each inbound WS frame:** forwards it into that session's daemon connection via the new `sendVoiceSessionAudioChunk(sessionId, data)` (see below) — no buffering or VAD logic in this module; the daemon already owns that.

**On `voice:reply` for this session:** closes the WS (signals the browser the turn is over) and calls `destroyVoiceSession`.

**On `voice:error` for this session:** relays it as a control frame to the browser (so `wake-word.js` can surface a notification and re-arm instead of hanging), then closes the WS and calls `destroyVoiceSession`.

**On WS close from the browser side** (network drop, tab closed, backgrounding kills the connection): calls `destroyVoiceSession` immediately. No transcript will have fired, so no reply happens — a clean "nothing happened, try again," not a stuck state.

### Small addition: `src/core/audio-client.ts`

`startAudioClient`'s returned handle currently exposes only `{ stop }`. Add `sendAudioChunk(base64Data): boolean` alongside it, writing `{"type": "audio_chunk", "data": base64Data}` to the daemon socket (returns `false` if the socket isn't currently writable, mirroring how `stop()` already no-ops safely on a dead connection).

### Small addition: `src/interaction/voice-session-manager.ts`

Export `sendVoiceSessionAudioChunk(sessionId, data): boolean`, mirroring `destroyVoiceSession`'s existing lookup-and-delegate shape (look up the session, delegate to its `audioClient.sendAudioChunk`, return `false` for an unknown `sessionId`) — so `voice-stream-ws.ts` never touches an `audioClient` reference directly, same encapsulation `destroyVoiceSession` already enforces.

### Fix folded in from Sub-project A's final review: per-session turn queueing

`voice-session.ts`'s `startVoiceSession` currently serializes every session's turns through one shared `activeTurnPromise` — deliberately fine while nothing called this code in production (Sub-project A), but Sub-project B is the real producer that makes the cross-user blocking live. Replace the single promise with a `Map<sessionId, Promise<void>>`: each session's transcripts stay strictly ordered against themselves, but a slow turn for one session no longer delays another session's reply. Remove a session's map entry once its chain goes idle (no unbounded growth from short-lived ambient sessions being created and destroyed constantly).

### Multi-device clarification

Sub-project A's spec assumed "one active session per username" as a scoping placeholder, not an enforced constraint — nothing in the code actually restricts a user to one session. This sub-project relies on that: the same user with two tabs (or two devices) open gets two independent sessions, each isolated exactly the way two different users' sessions already are, verified by Sub-project A's own isolation tests. No new code needed for this to work correctly.

## Testing approach

- **`voice-stream-ws.ts`**: fake WS client + fake daemon socket (same pattern Sub-project A's tests use) — ticket/API-key auth accepted and rejected, `createVoiceSession`→`destroyVoiceSession` lifecycle on normal completion, on abrupt disconnect, and on `voice:error`; inbound frame forwarding reaches the fake daemon as a correctly-shaped `audio_chunk` message.
- **`audio-client.ts`'s `sendAudioChunk`**: direct test asserting the exact wire message reaches a fake daemon socket, and that it returns `false` on a non-writable socket instead of throwing.
- **`voice-session-manager.ts`'s `sendVoiceSessionAudioChunk`**: returns `false` for an unknown `sessionId`; delegates correctly for a real one.
- **`voice-session.ts`'s per-session queueing**: two sessions, one with an artificially delayed fake router response, asserting the fast session's reply is not delayed by the slow one — this is the test CodeRabbit's finding on Sub-project A asked for, now finally reachable since there's a real reason two sessions run concurrently.
- **Full round-trip through the WS layer**: extend Sub-project A's existing two-fake-daemon round-trip isolation test to go through `voice-stream-ws.ts` instead of calling `createVoiceSession` directly — proves the whole chain (WS in → daemon → transcript → reply → WS closes → session destroyed) end to end for two concurrent users.
- **`wake-word.js`**: not unit-testable in the usual sense (WASM audio pipeline) — verified manually in a real browser, the same way the existing click-to-talk mic code already is.

## Explicitly deferred / not in scope

- True background/system-level listening (native app or browser extension) — tab-open is the accepted model for this sub-project.
- Real-time streamed TTS playback (relaying the daemon's `audio_chunk` TTS frames back over the WS as they're generated) — reusing the existing HTTP TTS delivery path is sufficient; sub-second reply latency isn't a stated requirement.
- Any change to click-to-talk (`/api/voice-input`) — untouched, already correct, a separate code path.
- Custom wake-word training/models — Porcupine's built-in `"Jarvis"` keyword is used as-is.
