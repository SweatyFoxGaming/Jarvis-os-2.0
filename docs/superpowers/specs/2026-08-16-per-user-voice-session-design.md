# Per-User Voice Session Pipeline — Design Spec

## Problem

`src/interaction/voice-session.ts` (the turn-processing pipeline for local voice input — transcript in, cognition/tools/memory/learning run, spoken reply out) was built as part of the original local voice daemon work, before multi-user support existed. It's explicitly single-user by design: `handleTranscript` falls back to a hardcoded `DEFAULT_USERNAME` whenever `deps.username` isn't overridden, and `server.ts` starts exactly one global instance at boot (`voiceSession = startVoiceSession()`) with no override — so every voice turn, from anyone, would be attributed to the same fixed identity. The bridge to the voice daemon (`src/core/audio-client.ts`'s `startAudioClient()`) is the same shape: one persistent Unix-socket connection shared by the whole server process, whose per-connection utterance buffer would silently mix two people's concurrent speech into one garbled transcript if two sessions were ever active at once.

Today this is dormant, not actively broken — nothing currently publishes `voice:transcript` in production (click-to-talk uses a separate, already-correctly-per-user path via `/api/voice-input`, not this pipeline at all). But it's the foundation the upcoming ambient/wake-word voice feature (sub-project B) needs, and building that feature on top of a single-fixed-identity pipeline would either silently misattribute every ambient voice turn to one user, or require retrofitting this exact isolation work under deadline pressure once a real producer exists.

## Goal

Make the voice-session pipeline genuinely multi-user: any number of concurrent sessions, each correctly isolated to its own daemon connection, its own transcript/reply/audio events, and its own username-scoped cognition/memory/tool access — with no cross-session data leakage — verifiable by tests today, with no producer/UI required yet (that's sub-project B).

## Design, confirmed with the project owner before implementation

### Event shape

Every voice-pipeline bus event gains a required `sessionId` (opaque string, generated at session creation) and `username` field, replacing today's bare payloads and the `DEFAULT_USERNAME` fallback:

- `voice:transcript` — `{ sessionId, username, text }` (today: `{ text }`)
- `voice:reply` — `{ sessionId, username, ...existing fields }`
- `voice:audio-chunk` — `{ sessionId, ...existing fields }` (covers both the TTS-out direction that exists today and the mic-in direction sub-project B adds)
- `voice:error`, `voice:queued` — `{ sessionId, ...existing fields }`

`voice-session.ts`'s `handleTranscript` reads `username` from the event payload itself now, not from a `deps` override — the override mechanism (`VoiceSessionDeps.username`) is removed since it no longer reflects how identity actually flows through the system.

### Session lifecycle

New module `src/interaction/voice-session-manager.ts` replaces the current boot-time singleton wiring:

- `createVoiceSession(username): string` — generates a `sessionId`, opens one dedicated connection to the voice daemon for this session (reusing `audio-client.ts`'s existing connection/reconnect logic, parameterized per-session instead of module-global), returns the id.
- `destroyVoiceSession(sessionId): void` — closes that session's daemon connection, cleans up its bus subscriptions.
- One shared `voice:transcript` subscription (registered once, not per-session) reads `sessionId`/`username` off each event and calls `handleTranscript` — matches how a single Express route handler already serves many concurrent requests without one subscription per request.

`server.ts`'s current `voiceSession = startVoiceSession()` and the module-level `startAudioClient()` call are removed from the boot sequence — this pipeline becomes purely on-demand, created only when something (sub-project B, or a test) actually calls `createVoiceSession`. Nothing in this sub-project calls it in production yet; it ships as tested, dormant infrastructure, the same way `voice-session.ts` itself has been since it was first built.

### Daemon connection isolation

The voice daemon's `handle_connection()` already gives each Unix-socket connection its own `utterance_buffer`/`UtteranceEndDetector` state, and `InferenceQueue` already serializes the actual STT/TTS compute safely across connections (existing, unchanged). Per-session correctness therefore comes for free from opening one real daemon connection per active session — no daemon-side changes needed, only removing the assumption in `audio-client.ts` that there's exactly one connection for the whole process.

## Testing approach

No real producer or browser exists yet, so verification is entirely at the bus/daemon level, matching this codebase's existing dependency-injection test conventions (e.g. `daemon/tests/test_voice_engine.py`'s injected `model_loader`):

1. **Cross-session isolation (bus-level, no real daemon)**: create two fake sessions with different usernames, publish two interleaved `voice:transcript` events, assert each one's `handleTranscript` call receives the correct username (and therefore the correct memory/cognition/tool scoping) and that each `voice:reply` carries back the matching `sessionId` — proving no cross-contamination in the event-routing layer.
2. **Cross-session isolation (real daemon)**: open two real concurrent connections to the actual test-mode voice daemon via `createVoiceSession` with two different fake audio streams, confirm each session's transcript comes back correctly isolated and undistorted — proving the daemon's per-connection buffering actually holds under real concurrent load, not just in theory.
3. **Lifecycle**: `destroyVoiceSession` actually closes its daemon connection and unregisters cleanly (no leaked sockets/subscriptions across repeated create/destroy cycles — relevant since sub-project B will create/destroy a session every time someone's wake-word turn starts/ends).

## Explicitly deferred / not in scope

- Any real producer (microphone capture, wake-word detection) or consumer (browser playback, WebSocket relay) — that's sub-project B, built on top of this once it ships.
- Changing how click-to-talk (`/api/voice-input`) works — it's already correctly per-user via a separate code path and isn't touched by this work.
- Multi-device support for one user having two simultaneous ambient sessions — one active session per username is the assumed model; revisit only if that's a real need once sub-project B ships.
