# Core Event Bus & Local Voice Engine (Phase 1)

## Goal

Replace Jarvis's cloud-based voice pipeline (Gemini Live API) and its two separate audio services (whisper-cpp for STT, openai-edge-tts for TTS) with a single, fully local, low-latency voice daemon (Faster-Whisper + Kokoro-82M), orchestrated through a new central TypeScript event bus that becomes the backbone for real-time subsystem communication — replacing today's cron-style polling with genuine pub/sub. This is Phase 1 of a larger architecture initiative; later phases will build on this backbone to touch the UI and builder modules, which are explicitly out of scope here.

## Why

The user wants Jarvis's voice mode fully offline-capable and consistent with the codebase's existing offline-first philosophy (local llama-cpp already preferred for text chat), rather than depending on Gemini's cloud Live API. Consolidating three separate audio services (whisper-cpp, openai-edge-tts, Gemini Live) into one purpose-built local daemon reduces operational surface area, and a real event bus replaces ad hoc polling with a foundation later phases (UI, builder modules) can build on.

## Architecture

Three layers, built in dependency order (the event bus first, since everything else depends on it, even though it's conceptually "step 2" in the original framing):

1. **Event bus** (`src/core/event-bus.ts`) — a pure, in-process TypeScript pub/sub singleton with no I/O of its own. Subsystems publish to named topics and subscribe with typed handlers. Filesystem watching (via `chokidar`) becomes one publisher into this bus, replacing today's cron-style polling.

2. **Voice daemon** (`daemon/voice_engine.py` + `src/core/audio-client.ts`) — a new Docker service (consistent with the whisper-cpp/tts/llama-cpp deployment pattern it replaces) running Faster-Whisper (STT) and Kokoro-82M (TTS), communicating over a Unix socket on a shared Docker volume with the `jarvis-os-api` container. The daemon does STT/TTS only — it never calls an LLM itself. After transcribing an utterance, it sends the transcript over the socket and waits for a reply to speak; it does not run tool-calling, memory recall, or reflection logic. `src/core/audio-client.ts` is a thin socket client that bridges the daemon's messages onto the event bus.

3. **Dual IPC bridges** (`src/ipc/`) — both are event-bus subscribers, nothing more. `eww-bridge.ts` replaces the existing `src/system/eww-adapter.ts`, pushing lightweight numeric/status updates to EWW's always-on glance via `eww update`. A new `electron-ipc.ts` subscribes to richer topics (code diffs, logs, spatial payloads) and pushes full state objects to the Electron window only when it's open — EWW and Electron serve two different, both-real jobs (always-on glance vs. on-demand deep view), not a deprecated-vs-current pair.

## Components

| File | Responsibility |
|---|---|
| `src/core/event-bus.ts` | Create — `EventBus.getInstance()` singleton, `subscribe(topic, handler): () => void`, `publish(topic, payload): void` |
| `daemon/voice_engine.py` | Create — Unix socket server, Faster-Whisper STT with utterance-end detection, Kokoro-82M TTS, newline-delimited JSON control protocol + base64 PCM audio chunks |
| `src/core/audio-client.ts` | Create — Unix socket client; publishes `voice:transcript` on the bus when the daemon sends a transcript, subscribes to `voice:reply` and forwards it back to the daemon over the socket |
| A new voice-session handler (exact location TBD at plan time) | Create — subscribes to `voice:transcript`, runs the turn through the existing local-llama-cpp-backed tool/memory pipeline (reusing the tool-calling pattern already established in `/api/chat`'s Groq/OmniRoute branch, not duplicating Gemini Live's bespoke `functionResponse`/`thought_signature` handling), publishes `voice:reply` |
| `src/ipc/eww-bridge.ts` | Create — replaces `src/system/eww-adapter.ts`; subscribes to lightweight status/metric topics, shells out `eww update` |
| `src/ipc/electron-ipc.ts` | Create — subscribes to richer topics; sends full state objects to the Electron window via WebSocket/IPC, only when the window is visible |
| `src/interaction/live-voice.ts` | Delete — replaced by the new voice pipeline |
| `src/server.ts` | Modify — remove the `/ws/voice` WebSocket route and its Gemini Live API wiring; wire the new voice-session handler in its place |
| `src/system/eww-adapter.ts` and its systemd unit | Delete — replaced by `eww-bridge.ts` |
| `docker-compose.yml` | Modify — remove `whisper-cpp` and `tts` services, add the new voice-daemon service with a shared volume for the Unix socket |
| `src/interaction/whisper.ts` | Modify — `/api/voice-input`'s fallback path currently calls `whisper.transcribeAudio()` (the same whisper-cpp wrapper being removed here); this call site needs to be re-pointed at the new daemon or explicitly lose its offline fallback — a real cross-cutting concern discovered during design, not something to let break silently |
| `src/interaction/tts.ts` | Modify — repoint its callers (the `speak_text` chat tool, notifications) to synthesize speech through the new daemon's Kokoro TTS instead of the removed `openai-edge-tts` container, per the "replace it entirely" decision covering all TTS use, not just the streaming voice path |

## Data Flow

Mic → daemon (Faster-Whisper) → utterance-end detected → socket message → `audio-client.ts` publishes `voice:transcript` → the voice-session handler runs the turn through the existing local-LLM tool/memory pipeline → publishes `voice:reply` → `audio-client.ts` forwards it to the daemon over the socket → daemon runs Kokoro-82M TTS → raw PCM streamed back to the client speakers. Status events (`voice:listening`, `voice:speaking`, `system:anomaly`, `filesystem:changed`, etc.) publish to the bus throughout, independently of the voice loop, for the IPC bridges to consume.

## Error Handling

- If the voice daemon is unreachable (socket connection refused/dropped), `audio-client.ts` publishes a `voice:error` event; the voice-session handler and IPC bridges degrade visibly (e.g., EWW shows a disconnected state) rather than silently hanging.
- If Faster-Whisper produces no usable transcript (silence, unintelligible audio), the daemon sends an empty-transcript signal rather than blocking indefinitely; the voice-session handler treats this as a no-op turn, not an error.
- If the local LLM pipeline itself fails (tool execution error, model unavailable), the voice-session handler publishes a `voice:reply` containing a clear spoken error message (matching this codebase's existing convention of never fabricating a plausible-sounding failure), rather than leaving the daemon waiting.
- `/api/voice-input`'s cross-cutting fallback dependency on whisper-cpp (see Components) must be resolved explicitly, not left to silently break when whisper-cpp is removed.

## Testing

- The event bus is pure and fully unit-testable: subscribe/publish/unsubscribe, multiple subscribers per topic, topic isolation (a publish to one topic never reaches another topic's subscribers).
- The Python daemon introduces `pytest` as a new test category for this codebase (everything else is TypeScript). Protocol-parsing and utterance-end-detection logic get tested independently of actually loading the Faster-Whisper/Kokoro models (which are slow and shouldn't be a CI dependency).
- `audio-client.ts` gets tested against a mocked or temp-path-based real Unix socket, verifying correct message parsing and event-bus publishing.
- The IPC bridges get tested with a mocked `eww update` shell invocation and a mocked Electron IPC layer, verifying correct topic-to-payload routing without needing a real EWW/Electron process running.
- No real audio hardware, no real Faster-Whisper/Kokoro model weights, and no real EWW/Electron process are required by any automated test.

## Out of Scope

- Anything touching the UI or builder modules — explicitly deferred to a later phase, per the user's own framing of this as "Phase 1... before modifying the UI or builder modules."
- A binary/length-prefixed audio framing protocol — Phase 1 uses simple newline-delimited JSON + base64 PCM; a more efficient framing is a natural future optimization only if the JSON/base64 overhead proves to be a real, measured bottleneck.
- A dedicated/separate LLM for voice specifically — Phase 1 reuses the existing local llama-cpp service; introducing a voice-specific model is a future decision, not part of this phase.
- Extracting a single shared "run one turn of conversation with tools" function used by both `/api/chat` and the new voice-session handler — the voice-session handler reuses the *pattern* already established in `/api/chat`'s Groq/OmniRoute branch, but a full deduplication refactor of the three currently-separate tool-calling implementations (Gemini branch, Groq/OmniRoute branch, and now voice) is a separate concern, not required for this phase to function correctly.
- The already-in-progress, separate `feat/omniroute-cognition-gateway` branch (currently paused, Tasks 1-7 of 11 complete) — unrelated work, not touched by this plan.
