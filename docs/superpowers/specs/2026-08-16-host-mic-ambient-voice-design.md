# Host-Mic Ambient Voice (Sub-project 1 of 2) — Design Spec

## Problem

PR #154 (just merged) implemented ambient wake-word voice entirely client-side: a browser tab running WASM wake-word detection, requiring the user to keep that tab open. That doesn't work for the actual intended use — mobile clients can't realistically keep a browser tab open and listening, and the goal is a seamless, always-on experience like a physical smart speaker, not a webpage.

The real target is a single physical device (mic + speaker) attached to the machine running the Docker stack, always listening, with no browser involved at any point. Multiple household members should eventually each get their own account's memory/context from that one shared device (per-speaker identification) — but that's a separable concern (see "Explicitly deferred" below) from getting a real always-on voice loop working at all.

## Goal

A mic/speaker physically attached to the Docker host continuously listens for "hey jarvis." On detection, it captures the utterance, transcribes it, runs a full turn (cognition router, tools, memory, learning — everything a normal turn already does) as one fixed, admin-configured account, and speaks the reply back out loud through the same device. Zero browser tab, zero click, zero login required for this to work.

Sub-project 2 replaces the fixed account with real per-speaker voice matching. This spec's fixed-identity placeholder is the seam that swap will land on.

## Global Constraints

- **The daemon's STT/TTS/audio-domain-only boundary is preserved and unchanged.** It gains a wake-word model and (in this sub-project) zero new privileged access — no DB, no user accounts, no capability/memory/router logic. It still only ever produces transcript text and (Sub-project 2) raw embedding vectors. All identity, business-logic, and account decisions stay in Node, exactly as today.
- **No change to click-to-talk** (`/api/voice-input`, `whisper.ts`/`tts.ts`) — separate, unrelated code path, confirmed untouched by this spec.
- **The just-merged browser wake-word engine (PR #154) is removed, not kept as a fallback** — per explicit decision, one ambient path only.

## Design

### Where wake-word detection happens

Server-side, inside the existing `voice-daemon` container — not a new container, and not client-side. `voice-daemon` already owns the audio-model-loading infrastructure (Faster-Whisper, Kokoro-82M, `InferenceQueue`) and is the natural home for one more audio-domain model. A separate container would need the same real ALSA device passthrough for no isolation benefit.

Uses openWakeWord's **official Python package** (`pip install openwakeword`), not the hand-ported JS/ONNX pipeline PR #154 built for the browser. This eliminates that entire reimplementation — the real, maintained pipeline runs directly, loading its own bundled `hey_jarvis` model. (Coincidentally the same wake phrase PR #154 used — no user-facing wording change.)

### Audio device passthrough

New `devices: - "/dev/snd:/dev/snd"` entry on the `voice-daemon` service in `docker-compose.yml`, plus running the container with access to the host's `audio` group (exact mechanism — `group_add` vs. matching GID — is an implementation-time decision, verified against the real host). Which ALSA device index is the physical mic vs. speaker is host-specific and must be configurable, not hardcoded:

- `AMBIENT_MIC_DEVICE` (ALSA device name/index, e.g. `hw:1,0`)
- `AMBIENT_SPEAKER_DEVICE` (same)
- `AMBIENT_LISTENING_ENABLED` (`true`/`false`, default `false`) — the ambient background task only starts if this is explicitly on. A host with no mic attached, or before device passthrough is configured, must boot cleanly with ambient listening simply off, not crash on startup trying to open a nonexistent device.

**Real open risk, flagged not resolved:** this assumes raw ALSA device access works cleanly for the host's actual audio stack. If the host routes audio through PipeWire/PulseAudio as its primary layer, plain `/dev/snd` passthrough can conflict with or be invisible to that. The implementation plan should note this as a real on-host verification step, with PulseAudio/PipeWire socket forwarding as the fallback if ALSA passthrough doesn't work — not something resolvable without the actual host in front of us.

### New daemon component: ambient listener background task

New module (e.g. `daemon/ambient_listener.py`), started as an asyncio background task at daemon boot when `AMBIENT_LISTENING_ENABLED=true`. Responsibilities:

1. Continuously reads raw PCM from `AMBIENT_MIC_DEVICE` (via `sounddevice` or equivalent — new dependency).
2. Runs each frame through `openwakeword`'s streaming prediction API.
3. On a score crossing threshold (`AMBIENT_WAKE_WORD_THRESHOLD`, default matching openWakeWord's own recommended default), starts capturing the following utterance using the **existing** `UtteranceEndDetector` (`daemon/protocol.py`) — the exact same silence-duration state machine already used for the browser-streamed path, just fed from the live mic stream instead of socket messages. No new VAD logic.
4. Once the utterance ends, runs it through the daemon's existing `_stt.transcribe` (already daemon-side, unchanged).
5. Sends the transcript up to Node over the new persistent ambient connection (see below).
6. **Guards against re-triggering mid-turn:** while a previous utterance's turn is still awaiting a reply, incoming mic frames are dropped entirely — wake-word prediction does not run on them at all, so no new trigger (and no reply interruption) is possible until `turn_complete()` re-arms detection. (This is a stricter mid-turn behavior than "detection keeps running in the background"; see "Explicitly deferred" below — reply interruption/barge-in was never built, and isn't approximated by anything short of this.) Mirrors the same guard the browser version had.

### Protocol additions (`daemon/protocol.py` / `voice_engine.py`)

Two new message types, distinct from the existing per-session `audio_chunk`/`speak`/`transcript`/`speak_done` set (those stay exactly as they are, unchanged, still used by click-to-talk's `synthesizeOverSocket`/`transcribeOverSocket` one-shot helpers):

- **Daemon → Node: `{"type": "ambient_transcript", "text": "..."}`** — sent once per completed utterance, over the one persistent connection described below.
- **Node → daemon: `{"type": "speak_local", "text": "..."}`** — synthesize with Kokoro (existing `_tts.synthesize`) and play the result **directly out `AMBIENT_SPEAKER_DEVICE`**, entirely daemon-side. No `audio_chunk` frames are streamed back — unlike the existing `speak` handler (still used elsewhere, unchanged), there is no caller waiting to receive bytes; the daemon owns playback itself. Once playback finishes, sends `{"type": "speak_local_done"}` back so Node knows it's safe to consider the turn fully closed (used for the mid-turn re-trigger guard above).

### New Node component: persistent ambient connection

Opened once at API boot (`server.ts`'s existing startup sequence), not per-browser-session — this is the one important structural difference from every other daemon connection in this codebase, which are all per-session (`startAudioClient`) or one-shot (`transcribeOverSocket`/`synthesizeOverSocket`). Reuses the same `net.createConnection` + reconnect-with-backoff shape `audio-client.ts` already established, rather than inventing a new connection-lifecycle pattern.

On `ambient_transcript`: dispatches a full turn as `AMBIENT_DEFAULT_USERNAME` (new env var — the fixed placeholder account this sub-project uses) through the **existing** turn machinery `voice-session.ts` already runs for the browser ambient path — same cognition router call, same tool execution, same memory/session-history/learning side effects, same honest-spoken-error-on-failure behavior. **Exact wiring mechanism is a plan-level decision**, to be pinned down by reading `voice-session.ts`'s current internals during implementation — options include publishing a synthetic `voice:transcript` bus event under a reserved `sessionId` (reusing the event-bus path unchanged) versus a new direct entry point; the constraint that must hold is zero duplication of the router/tools/memory/learning logic itself.

On the reply becoming available: sends `{"type": "speak_local", "text": <reply>}` back down the same connection.

### Removed

- `src/interaction/static/openwakeword-engine.js`, `src/interaction/static/wake-word.js`
- `src/interaction/static/vendor/openwakeword/`, `src/interaction/static/vendor/onnxruntime-web/`
- The ambient-listening toggle UI in `index.html`
- `/ws/voice-stream`, `POST /api/voice-stream-ticket`, `src/interaction/voice-stream-ws.ts`
- The `voice.ambient` capability (and its entry in `DEFAULT_PERSONAL_CAPABILITIES`/backfill, if any) — this feature is no longer per-user-opt-in from a browser; it's a fixed host-level configuration.
- The CSP `scriptSrc` comment referencing `vendor/openwakeword/`/`vendor/onnxruntime-web/` (revert to whatever it described before PR #154, since neither vendor directory exists anymore).

### Error handling

- No mic configured/available at startup with `AMBIENT_LISTENING_ENABLED=true`: log a clear, specific error naming the missing device; the ambient task stays off, the rest of the daemon (STT/TTS for click-to-talk) continues functioning normally. Never crash the whole daemon over this optional subsystem — same philosophy as the existing daemon-health-gate design (`docker-compose.yml`'s `service_started` vs. `service_healthy` reasoning, already documented).
- Node's ambient connection drops: daemon logs and keeps listening (utterances simply queue up as text once reconnected, or are dropped if the gap is long — a plan-level bound, not a spec-level one); Node's side reconnects with backoff, matching `startAudioClient`'s existing behavior.
- A turn failing at the cognition-router layer: identical honest-spoken-error behavior `voice-session.ts` already implements — never a fabricated answer.
- Malformed/oversized `ambient_transcript` or `speak_local` messages: same `ProtocolError`-and-continue handling every other message type in `daemon/protocol.py` already has — one bad message never crashes the connection.

## Testing approach

- **`ambient_listener.py`'s chunking/dispatch logic**: unit-testable via an injectable wake-word predictor and injectable mic-frame source — the same "inject a fake predictor, assert the pipeline's own buffering/dispatch logic" pattern PR #154's `StreamingFeatureExtractor` used for exactly this reason. No real audio hardware needed for these tests.
- **New protocol message types**: round-trip tests via the existing fake-socket test pattern in `daemon/tests/test_voice_engine.py` — `ambient_transcript` sent correctly once an utterance completes; `speak_local` triggers synthesis + a fake "play" call (not a real device) + `speak_local_done`.
- **Node's persistent ambient connection module**: fake-daemon-socket test (same pattern `voice-stream-ws.ts`'s own tests used) — an `ambient_transcript` message triggers a real turn for `AMBIENT_DEFAULT_USERNAME` and results in a `speak_local` message with the real reply text; a pipeline failure results in the honest spoken-error text, not a crash or silence.
- **Reconnect behavior**: daemon connection dropping and coming back is tolerated without duplicate or lost turns, mirroring `audio-client.ts`'s existing reconnect tests.
- **Manual, the user's own step, not verifiable from a sandboxed dev environment**: real ALSA device passthrough actually reaching the physical mic/speaker; a real "hey jarvis" → real spoken reply round trip.

## Explicitly deferred / not in scope

- **Speaker identification** (Sub-project 2, next spec) — this sub-project uses one fixed configured account for every turn.
- Multi-room / multiple physical listening devices — one device, one host, for now.
- PulseAudio/PipeWire compatibility if raw ALSA passthrough doesn't work on the real host — flagged as a real risk above, not solved here.
- Any change to click-to-talk.
- Reply interruption ("stop, Jarvis" mid-reply) — the re-trigger guard above only prevents a *new* turn from starting mid-turn; it doesn't add a barge-in/interrupt mechanism.
