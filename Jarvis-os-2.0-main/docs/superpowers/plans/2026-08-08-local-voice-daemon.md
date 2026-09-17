# Local Voice Daemon Implementation Plan (Plan B)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Jarvis's cloud-based voice pipeline (Gemini Live API) and its two separate audio services (whisper-cpp, openai-edge-tts) with one local, offline-capable voice daemon (Faster-Whisper STT + Kokoro-82M TTS), built on the event bus and `/ws/events` transport this branch already has (Plan A, already merged).

**Architecture:** `daemon/voice_engine.py` (new Docker service, Python, Unix socket server) does STT/TTS only — no LLM calls, no tool-calling, no memory. `src/core/audio-client.ts` is a thin Unix socket client bridging the daemon's messages onto the existing `EventBus`. A new voice-session handler subscribes to `voice:transcript`, runs the turn through the existing local-llama-cpp-backed tool/memory pipeline (reusing `/api/chat`'s Groq/CognitionRouter branch pattern, not duplicating Gemini Live's bespoke handling), and publishes `voice:reply`. `server.ts` drops `/ws/voice` and the Gemini Live wiring entirely.

**Tech Stack:** Python 3 (`faster-whisper`, `kokoro`, `soundfile`/`numpy` for PCM handling) for the daemon; TypeScript (`net` module, Unix domain sockets) for the client; Docker for deployment, matching the `llama-cpp` service's existing pattern.

## Global Constraints

- The daemon does STT/TTS ONLY — never calls an LLM, never does tool-calling, never touches memory/knowledge-graph. All of that stays in TypeScript, reusing the existing local-llama-cpp pipeline. This boundary is the single most important architectural rule in this plan; violating it (e.g. putting any "smarts" in Python) recreates the exact duplication the spec's own Out of Scope section explicitly rejected.
- Protocol: newline-delimited JSON control messages + base64-encoded PCM audio chunks over a Unix domain socket on a shared Docker volume. No binary/length-prefixed framing in this phase (explicitly out of scope per the spec).
- Protocol-parsing and utterance-end-detection logic must be testable WITHOUT loading real Faster-Whisper/Kokoro model weights — these are slow and must never be a test-suite dependency. Structure the Python code so the protocol/framing logic is a separate, pure-testable layer from the actual model-inference calls.
- No real audio hardware, no real Faster-Whisper/Kokoro model weights, and no real EWW/Electron process are required by any TypeScript automated test — matches every other hardware-dependent piece of work this session (GUI camera tests, EWW HUD).
- `/api/voice-input`'s existing fallback dependency on `whisper.transcribeAudio()` (which itself calls the now-removed `WHISPER_URL` service) must be resolved explicitly — repoint it at the new daemon, don't leave it silently broken.
- `speak_text`/TTS notification call sites must be repointed at the new daemon's Kokoro synthesis, not left calling the removed `TTS_URL` service.
- This CPU-only sandbox has no GPU — Faster-Whisper/Kokoro must run in CPU inference mode; document this explicitly in the daemon's config rather than assuming GPU availability.

---

## Task 1: `daemon/voice_engine.py` — protocol layer (testable without models)

**Files:**
- Create: `daemon/voice_engine.py`
- Create: `daemon/protocol.py` (the pure, model-free layer)
- Create: `daemon/requirements.txt`
- Create: `daemon/tests/test_protocol.py`
- Create: `daemon/pytest.ini` (or equivalent minimal pytest config)

**Interfaces:**
- Produces: `daemon/protocol.py` — `parse_control_message(line: str) -> dict` (parses one newline-delimited JSON line, raises `ProtocolError` on malformed input, never crashes the daemon), `encode_audio_chunk(pcm_bytes: bytes) -> str` (base64), `decode_audio_chunk(b64: str) -> bytes`, and a small `UtteranceEndDetector` class: `feed(is_speech: bool) -> bool` (returns `True` the instant it decides an utterance has ended, based on a configurable silence-duration threshold measured in consecutive `feed()` calls representing fixed-size audio frames — no model dependency, pure logic).

- [ ] **Step 1: Write the failing tests**

```python
# daemon/tests/test_protocol.py
import base64
import pytest
from daemon.protocol import parse_control_message, encode_audio_chunk, decode_audio_chunk, ProtocolError, UtteranceEndDetector

def test_parse_control_message_valid():
    msg = parse_control_message('{"type": "reply", "text": "hello"}')
    assert msg == {"type": "reply", "text": "hello"}

def test_parse_control_message_malformed_raises_protocol_error():
    with pytest.raises(ProtocolError):
        parse_control_message("not json{{{")

def test_parse_control_message_empty_line_raises_protocol_error():
    with pytest.raises(ProtocolError):
        parse_control_message("")

def test_encode_decode_audio_chunk_round_trips():
    original = b"\x00\x01\x02\xff\xfe"
    encoded = encode_audio_chunk(original)
    assert isinstance(encoded, str)
    assert decode_audio_chunk(encoded) == original

def test_decode_audio_chunk_malformed_raises_protocol_error():
    with pytest.raises(ProtocolError):
        decode_audio_chunk("not-valid-base64!!!")

def test_utterance_end_detector_fires_after_sustained_silence():
    # Configured for a short threshold so the test doesn't need real timing —
    # silence_frames_threshold=3 means 3 consecutive non-speech frames end
    # the utterance.
    detector = UtteranceEndDetector(silence_frames_threshold=3)
    assert detector.feed(True) is False   # speech
    assert detector.feed(True) is False   # speech
    assert detector.feed(False) is False  # 1st silence frame
    assert detector.feed(False) is False  # 2nd silence frame
    assert detector.feed(False) is True   # 3rd silence frame -> utterance ends

def test_utterance_end_detector_resets_silence_count_on_new_speech():
    detector = UtteranceEndDetector(silence_frames_threshold=3)
    detector.feed(True)
    detector.feed(False)
    detector.feed(False)
    assert detector.feed(True) is False   # speech resumes, silence count resets
    assert detector.feed(False) is False  # 1st silence frame again, not 3rd
    assert detector.feed(False) is False  # 2nd
    assert detector.feed(False) is True   # 3rd -> now it ends

def test_utterance_end_detector_never_fires_on_leading_silence_alone():
    # Silence before any speech has happened at all must not count as "the
    # utterance ended" -- there was no utterance yet.
    detector = UtteranceEndDetector(silence_frames_threshold=3)
    assert detector.feed(False) is False
    assert detector.feed(False) is False
    assert detector.feed(False) is False
    assert detector.feed(False) is False
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd daemon && python3 -m pytest tests/test_protocol.py -v`
Expected: `ModuleNotFoundError` — `protocol.py` doesn't exist yet.

- [ ] **Step 3: Implement**

```python
# daemon/protocol.py
"""
Pure, model-free protocol layer for the voice daemon -- newline-delimited
JSON control messages plus base64-encoded PCM audio chunks over a Unix
socket. Deliberately has zero dependency on faster-whisper/kokoro so this
whole module (and its tests) never needs real model weights loaded.
"""
import base64
import binascii
import json


class ProtocolError(Exception):
    """Raised on any malformed control message or audio chunk -- callers
    must catch this and continue the connection, never crash the daemon
    over one bad message."""


def parse_control_message(line: str) -> dict:
    stripped = line.strip()
    if not stripped:
        raise ProtocolError("empty control message line")
    try:
        return json.loads(stripped)
    except json.JSONDecodeError as e:
        raise ProtocolError(f"malformed JSON control message: {e}") from e


def encode_audio_chunk(pcm_bytes: bytes) -> str:
    return base64.b64encode(pcm_bytes).decode("ascii")


def decode_audio_chunk(b64: str) -> bytes:
    try:
        return base64.b64decode(b64, validate=True)
    except (binascii.Error, ValueError) as e:
        raise ProtocolError(f"malformed base64 audio chunk: {e}") from e


class UtteranceEndDetector:
    """Pure silence-duration logic, no audio analysis of its own -- the
    caller (the real STT loop, wired to an actual VAD/energy check against
    real audio frames) decides is_speech per frame and feeds it in here.
    Fires exactly once per utterance, the instant sustained silence
    following real speech crosses the threshold. Silence before any speech
    has occurred is never treated as an utterance ending, since there was
    no utterance to end."""

    def __init__(self, silence_frames_threshold: int = 15):
        self.silence_frames_threshold = silence_frames_threshold
        self._has_seen_speech = False
        self._consecutive_silence = 0

    def feed(self, is_speech: bool) -> bool:
        if is_speech:
            self._has_seen_speech = True
            self._consecutive_silence = 0
            return False
        if not self._has_seen_speech:
            return False
        self._consecutive_silence += 1
        if self._consecutive_silence >= self.silence_frames_threshold:
            # Reset so the SAME detector instance can be reused for the
            # next utterance in the same connection, rather than requiring
            # the caller to construct a fresh one every time.
            self._has_seen_speech = False
            self._consecutive_silence = 0
            return True
        return False
```

```
# daemon/requirements.txt
faster-whisper==1.0.3
kokoro>=0.3.4
soundfile>=0.12.1
numpy>=1.26.0
pytest>=8.0.0
```

```ini
# daemon/pytest.ini
[pytest]
testpaths = tests
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd daemon && python3 -m pip install pytest && python3 -m pytest tests/test_protocol.py -v` (only `pytest` itself is needed for this task — `faster-whisper`/`kokoro` are Task 2's concern, don't install them yet).
Expected: all 8 tests pass.

- [ ] **Step 5: Write the daemon's socket-server skeleton (still model-free)**

```python
# daemon/voice_engine.py
"""
Unix socket server for the local voice daemon. STT/TTS only -- this file
and everything it imports never calls an LLM, never does tool-calling,
never touches memory or the knowledge graph. That boundary lives entirely
in TypeScript (src/core/audio-client.ts + the voice-session handler);
violating it here recreates the duplication the design spec explicitly
rejected.

Protocol: newline-delimited JSON control messages, base64 PCM audio
chunks. See protocol.py for the pure parsing/framing logic this file
wires up to real socket I/O and (in a later task) real model inference.
"""
import asyncio
import json
import logging
import os
import sys

from protocol import ProtocolError, parse_control_message

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("voice_engine")

SOCKET_PATH = os.environ.get("VOICE_DAEMON_SOCKET", "/tmp/jarvis-voice/voice.sock")


async def handle_connection(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    peer = writer.get_extra_info("peername") or "unix-client"
    log.info(f"connection opened: {peer}")
    try:
        while True:
            line = await reader.readline()
            if not line:
                break
            try:
                msg = parse_control_message(line.decode("utf-8"))
            except ProtocolError as e:
                log.warning(f"malformed message from {peer}, ignoring: {e}")
                continue
            # Task 2 wires real STT/TTS handling in here based on msg["type"].
            log.info(f"received control message: {msg.get('type', 'unknown')}")
    except (ConnectionResetError, BrokenPipeError):
        log.info(f"connection reset: {peer}")
    finally:
        writer.close()
        log.info(f"connection closed: {peer}")


async def main() -> None:
    socket_dir = os.path.dirname(SOCKET_PATH)
    os.makedirs(socket_dir, exist_ok=True)
    if os.path.exists(SOCKET_PATH):
        os.remove(SOCKET_PATH)

    server = await asyncio.start_unix_server(handle_connection, path=SOCKET_PATH)
    log.info(f"voice daemon listening on {SOCKET_PATH}")
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        sys.exit(0)
```

- [ ] **Step 6: Manual verification of the socket server**

Run `cd daemon && python3 voice_engine.py &` then in another shell, `echo '{"type":"ping"}' | socat - UNIX-CONNECT:/tmp/jarvis-voice/voice.sock` (or a small Python one-liner using `socket.socket(socket.AF_UNIX, ...)` if `socat` isn't available) and confirm the daemon logs "received control message: ping". Kill the background process afterward. Document the exact command used and its output in your report.

- [ ] **Step 7: Commit**

```bash
git add daemon/
git commit -m "feat: add the voice daemon's protocol layer and socket-server skeleton"
```

---

## Task 2: `daemon/voice_engine.py` — real Faster-Whisper STT + Kokoro-82M TTS

**Files:**
- Modify: `daemon/voice_engine.py`
- Create: `daemon/models.py`
- Test: `daemon/tests/test_models.py` (mocked, not loading real weights)

**Interfaces:**
- Produces: `daemon/models.py` — `class SpeechToText: def transcribe(self, pcm_bytes: bytes) -> str` (wraps `faster-whisper`, CPU inference mode, lazy-loads the model on first real call so import time stays fast), `class TextToSpeech: def synthesize(self, text: str) -> bytes` (wraps `kokoro`, returns raw PCM bytes).
- `voice_engine.py`'s `handle_connection` now dispatches real control-message types: `{"type": "audio_chunk", "data": "<base64>"}` feeds `UtteranceEndDetector`; on utterance end, calls `SpeechToText.transcribe`, writes `{"type": "transcript", "text": "..."}\n` back over the socket. `{"type": "speak", "text": "..."}` calls `TextToSpeech.synthesize`, writes back one or more `{"type": "audio_chunk", "data": "<base64>"}\n` lines followed by `{"type": "speak_done"}\n`.

- [ ] **Step 1: Write the failing tests (mocked models, no real weights)**

```python
# daemon/tests/test_models.py
from unittest.mock import MagicMock, patch

def test_speech_to_text_transcribe_calls_underlying_model(monkeypatch):
    from daemon.models import SpeechToText
    fake_segment = MagicMock(text=" hello world ")
    fake_model = MagicMock()
    fake_model.transcribe.return_value = ([fake_segment], MagicMock())
    stt = SpeechToText(model_loader=lambda: fake_model)
    result = stt.transcribe(b"\x00\x01")
    assert result == "hello world"
    fake_model.transcribe.assert_called_once()

def test_speech_to_text_empty_segments_returns_empty_string(monkeypatch):
    from daemon.models import SpeechToText
    fake_model = MagicMock()
    fake_model.transcribe.return_value = ([], MagicMock())
    stt = SpeechToText(model_loader=lambda: fake_model)
    assert stt.transcribe(b"\x00\x01") == ""

def test_text_to_speech_synthesize_calls_underlying_model(monkeypatch):
    from daemon.models import TextToSpeech
    fake_model = MagicMock()
    fake_model.create.return_value = (b"\x00\x01\x02", 24000)
    tts = TextToSpeech(model_loader=lambda: fake_model)
    result = tts.synthesize("hello")
    assert result == b"\x00\x01\x02"
    fake_model.create.assert_called_once()

def test_models_lazy_load_only_on_first_real_call():
    from daemon.models import SpeechToText
    load_count = {"n": 0}
    def loader():
        load_count["n"] += 1
        fake_model = MagicMock()
        fake_model.transcribe.return_value = ([], MagicMock())
        return fake_model
    stt = SpeechToText(model_loader=loader)
    assert load_count["n"] == 0  # constructing SpeechToText must not load the model
    stt.transcribe(b"\x00")
    assert load_count["n"] == 1
    stt.transcribe(b"\x00")
    assert load_count["n"] == 1  # second call reuses the already-loaded model
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd daemon && python3 -m pytest tests/test_models.py -v`
Expected: `ModuleNotFoundError` — `models.py` doesn't exist yet.

- [ ] **Step 3: Implement `models.py`**

```python
# daemon/models.py
"""
Thin wrappers around faster-whisper and kokoro, lazy-loading real model
weights only on first real transcribe/synthesize call -- constructing
SpeechToText/TextToSpeech (e.g. at daemon startup) must stay fast and
never require model weights to be present just to import this module,
which is what keeps voice_engine.py's own import graph testable without
real weights (see tests/test_models.py's injected model_loader).
"""
import logging
from typing import Callable, Optional

log = logging.getLogger("voice_engine.models")

WHISPER_MODEL_SIZE = "base"  # CPU-appropriate; this sandbox has no GPU
KOKORO_VOICE = "af_heart"


def _load_whisper_model():
    from faster_whisper import WhisperModel
    log.info(f"loading faster-whisper model '{WHISPER_MODEL_SIZE}' (CPU inference)...")
    return WhisperModel(WHISPER_MODEL_SIZE, device="cpu", compute_type="int8")


def _load_kokoro_model():
    from kokoro import KPipeline
    log.info("loading Kokoro-82M TTS pipeline (CPU inference)...")
    return KPipeline(lang_code="a")


class SpeechToText:
    def __init__(self, model_loader: Optional[Callable] = None):
        self._loader = model_loader or _load_whisper_model
        self._model = None

    def _ensure_loaded(self):
        if self._model is None:
            self._model = self._loader()
        return self._model

    def transcribe(self, pcm_bytes: bytes) -> str:
        import numpy as np
        model = self._ensure_loaded()
        audio = np.frombuffer(pcm_bytes, dtype=np.int16).astype(np.float32) / 32768.0
        segments, _info = model.transcribe(audio, language="en")
        return " ".join(s.text.strip() for s in segments).strip()


class TextToSpeech:
    def __init__(self, model_loader: Optional[Callable] = None):
        self._loader = model_loader or _load_kokoro_model
        self._model = None

    def _ensure_loaded(self):
        if self._model is None:
            self._model = self._loader()
        return self._model

    def synthesize(self, text: str) -> bytes:
        model = self._ensure_loaded()
        audio, _sample_rate = model.create(text, voice=KOKORO_VOICE)
        return audio
```

(Note: the real `faster-whisper`/`kokoro` API call shapes above are written from their documented interfaces as of this plan's writing — if the actual installed package version's real method signatures differ, adjust to match reality and note the discrepancy in your report; this is exactly the kind of thing that needs live verification against the real installed package, not just trusting written-from-memory API shapes.)

- [ ] **Step 4: Run tests to verify they pass**

`pytest` tests use injected fakes, so they don't need real packages installed. Run: `cd daemon && python3 -m pytest tests/test_models.py -v`.
Expected: all 4 tests pass without `faster-whisper`/`kokoro` installed.

- [ ] **Step 5: Install real dependencies and verify they actually load**

Run: `cd daemon && pip install -r requirements.txt`. This downloads real packages (and on first real use, real model weights from Hugging Face — confirmed reachable earlier in this session). Write a small one-off script (not part of the test suite) that constructs a real `SpeechToText`/`TextToSpeech` and calls `.transcribe()`/`.synthesize()` against a trivial real input (e.g. a short synthetic sine-wave PCM buffer for STT — won't produce meaningful text but proves the model loads and runs without crashing; a short real string for TTS, saving the output to a `.wav` file via `soundfile` so its existence/non-zero size can be checked). Document the exact commands, real output, and file size in your report. If model downloads are impractically slow/large for this sandbox, document that clearly and explain what was and wasn't verified — don't claim a check that didn't happen.

- [ ] **Step 6: Wire real dispatch into `voice_engine.py`**

Update `handle_connection` to dispatch `audio_chunk`/`speak` message types as described in this task's Interfaces section, using `UtteranceEndDetector` (Task 1) to decide when to call `SpeechToText.transcribe`, and `TextToSpeech.synthesize` for `speak` messages, writing responses back over the same connection.

- [ ] **Step 7: Run all daemon tests, commit**

Run: `cd daemon && python3 -m pytest -v`.

```bash
git add daemon/
git commit -m "feat: wire real Faster-Whisper STT and Kokoro-82M TTS into the voice daemon"
```

---

## Task 3: `src/core/audio-client.ts` — Unix socket bridge to the event bus

**Files:**
- Create: `src/core/audio-client.ts`
- Test: `tests/index.test.ts`

**Interfaces:**
- Consumes: `EventBus.getInstance()` (existing, `src/core/event-bus.ts`).
- Produces: `export function startAudioClient(socketPath: string): {stop: () => void}` — connects to the daemon's Unix socket (Node's `net.createConnection({path: socketPath})`); on a `{"type":"transcript","text":"..."}` line, publishes `voice:transcript` with `{text}`; subscribes to `voice:reply` on the bus and, when fired, writes `{"type":"speak","text":...}\n` to the socket; on `{"type":"audio_chunk",...}` lines received while expecting a spoken reply, publishes `voice:audio-chunk` with the raw base64 payload (for whatever eventually plays it back — out of this plan's scope to consume, just publish it honestly); on connection failure/drop, publishes `voice:error` with a real error message, matches the spec's Error Handling section exactly.

- [ ] **Step 1: Read `src/core/event-bus.ts`'s real `subscribe`/`publish` signatures and `src/core/filesystem-watcher.ts` for this codebase's established Node-side socket/stream handling conventions (error handling, cleanup) before writing anything.**

- [ ] **Step 2: Write the failing tests**

Match `tests/index.test.ts`'s real `registerTest` convention. Test against a REAL temp-path Unix socket (matching the spec's own testing guidance: "tested against a mocked or temp-path-based real Unix socket") using Node's `net.createServer({path: ...})` in the test itself as a fake daemon:

```typescript
// category: "AudioClient"
registerTest("AudioClient", "publishes voice:transcript when the daemon sends a transcript message", async () => {
  const os = await import("os");
  const path = await import("path");
  const net = await import("net");
  const { EventBus } = await import("../src/core/event-bus.js");
  const { startAudioClient } = await import("../src/core/audio-client.js");

  const socketPath = path.join(os.tmpdir(), `jarvis-voice-test-${Date.now()}.sock`);
  const fakeServer = net.createServer((conn) => {
    conn.write(JSON.stringify({ type: "transcript", text: "hello from the daemon" }) + "\n");
  });
  await new Promise<void>((resolve) => fakeServer.listen(socketPath, resolve));

  const bus = EventBus.getInstance();
  let received: any = null;
  const unsubscribe = bus.subscribe("voice:transcript", (payload) => { received = payload; });

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

registerTest("AudioClient", "publishes voice:error when the socket connection fails", async () => {
  const { EventBus } = await import("../src/core/event-bus.js");
  const { startAudioClient } = await import("../src/core/audio-client.js");

  const bus = EventBus.getInstance();
  let received: any = null;
  const unsubscribe = bus.subscribe("voice:error", (payload) => { received = payload; });

  const client = startAudioClient("/nonexistent/path/that/cannot/possibly/exist.sock");
  try {
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (!received) throw new Error("AudioClient: expected a voice:error publish on connection failure");
  } finally {
    unsubscribe();
    client.stop();
  }
});

registerTest("AudioClient", "forwards a voice:reply bus event to the daemon as a speak message", async () => {
  const os = await import("os");
  const path = await import("path");
  const net = await import("net");
  const { EventBus } = await import("../src/core/event-bus.js");
  const { startAudioClient } = await import("../src/core/audio-client.js");

  const socketPath = path.join(os.tmpdir(), `jarvis-voice-test-${Date.now()}.sock`);
  let receivedByDaemon = "";
  const fakeServer = net.createServer((conn) => {
    conn.on("data", (data) => { receivedByDaemon += data.toString(); });
  });
  await new Promise<void>((resolve) => fakeServer.listen(socketPath, resolve));

  const bus = EventBus.getInstance();
  const client = startAudioClient(socketPath);
  try {
    await new Promise((resolve) => setTimeout(resolve, 200));
    bus.publish("voice:reply", { text: "here is my answer" });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const parsed = JSON.parse(receivedByDaemon.trim());
    if (parsed.type !== "speak" || parsed.text !== "here is my answer") {
      throw new Error(`AudioClient: expected a real "speak" message forwarded to the daemon, got: ${receivedByDaemon}`);
    }
  } finally {
    client.stop();
    fakeServer.close();
  }
});
```

- [ ] **Step 3: Implement**

```typescript
// src/core/audio-client.ts
import * as net from "net";
import * as readline from "readline";
import { EventBus } from "./event-bus.js";
import { ObservationPlatform } from "../kernel/observation.js";

const observation = ObservationPlatform.getInstance();

export function startAudioClient(socketPath: string): { stop: () => void } {
  const bus = EventBus.getInstance();
  let socket: net.Socket | null = null;
  let stopped = false;

  const socketConn = net.createConnection({ path: socketPath });
  socket = socketConn;

  const rl = readline.createInterface({ input: socketConn });
  rl.on("line", (line) => {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      observation.logTelemetry("warn", "AudioClient", `Malformed line from voice daemon, ignoring: ${line.slice(0, 200)}`);
      return;
    }
    if (msg.type === "transcript") {
      bus.publish("voice:transcript", { text: msg.text });
    } else if (msg.type === "audio_chunk") {
      bus.publish("voice:audio-chunk", { data: msg.data });
    }
  });

  socketConn.on("error", (err: any) => {
    if (stopped) return;
    observation.logTelemetry("warn", "AudioClient", `Voice daemon socket error: ${err.message}`);
    bus.publish("voice:error", { message: err.message });
  });

  socketConn.on("close", () => {
    if (stopped) return;
    bus.publish("voice:error", { message: "Voice daemon connection closed unexpectedly" });
  });

  const unsubscribeReply = bus.subscribe("voice:reply", (payload: any) => {
    if (stopped || !socketConn.writable) return;
    socketConn.write(JSON.stringify({ type: "speak", text: payload.text }) + "\n");
  });

  return {
    stop: () => {
      stopped = true;
      unsubscribeReply();
      rl.close();
      socketConn.destroy();
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Export the standard env vars. Run `npx tsc --noEmit && npm test`.

- [ ] **Step 5: Commit**

```bash
git add src/core/audio-client.ts tests/index.test.ts
git commit -m "feat: add audio-client.ts bridging the voice daemon's Unix socket to the event bus"
```

---

## Task 4: Voice-session handler

**Files:**
- Create: `src/interaction/voice-session.ts`
- Test: `tests/index.test.ts`

**Interfaces:**
- Consumes: `EventBus.getInstance()`, `getCognitionRouter()`/`getAi()` (`src/runtime/clients.js`), `executeTool` (`src/capabilities/tools.js`), `toGroqTools`/`getAllToolDeclarations` (existing).
- Produces: `export function startVoiceSession(): {stop: () => void}` — subscribes to `voice:transcript`; on each transcript, runs ONE turn through the existing local pipeline (reusing `/api/chat`'s Groq/CognitionRouter tool-calling pattern: build messages, call `cognitionRouter.generateWithFallback`, execute any tool calls via `executeTool`, loop up to a bounded number of times exactly like `/api/chat` already does), then publishes `voice:reply` with the final text. On an empty/no-op transcript, does nothing (no publish). On a pipeline failure, publishes `voice:reply` with an honest, clearly-spoken error message — never fabricates a plausible-sounding answer.

- [ ] **Step 1: Read `/api/chat`'s Groq/CognitionRouter tool-calling branch in `server.ts` completely first — this is the exact pattern to reuse, not reinvent.**

- [ ] **Step 2: Write the failing tests**

Use dependency injection for the router/tool-execution (matching this session's established DI pattern):

```typescript
// category: "VoiceSession"
registerTest("VoiceSession", "a real transcript produces a real voice:reply", async () => {
  const { EventBus } = await import("../src/core/event-bus.js");
  const voiceSessionModule = await import("../src/interaction/voice-session.js");

  const bus = EventBus.getInstance();
  let reply: any = null;
  const unsubscribe = bus.subscribe("voice:reply", (payload) => { reply = payload; });

  const fakeRouter = {
    generateWithFallback: async () => ({
      choices: [{ message: { content: "Here's my spoken answer.", tool_calls: undefined } }],
    }),
  } as any;

  const handle = voiceSessionModule.startVoiceSession({ router: fakeRouter, username: "voice_test_user" } as any);
  try {
    bus.publish("voice:transcript", { text: "what's the weather like" });
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (!reply || !reply.text.includes("spoken answer")) {
      throw new Error(`VoiceSession: expected a real voice:reply, got: ${JSON.stringify(reply)}`);
    }
  } finally {
    unsubscribe();
    handle.stop();
  }
});

registerTest("VoiceSession", "an empty transcript produces no reply", async () => {
  const { EventBus } = await import("../src/core/event-bus.js");
  const voiceSessionModule = await import("../src/interaction/voice-session.js");

  const bus = EventBus.getInstance();
  let replyCount = 0;
  const unsubscribe = bus.subscribe("voice:reply", () => { replyCount++; });

  const handle = voiceSessionModule.startVoiceSession({ router: null, username: "voice_test_user" } as any);
  try {
    bus.publish("voice:transcript", { text: "" });
    await new Promise((resolve) => setTimeout(resolve, 200));
    if (replyCount !== 0) throw new Error(`VoiceSession: expected no reply for an empty transcript, got ${replyCount}`);
  } finally {
    unsubscribe();
    handle.stop();
  }
});

registerTest("VoiceSession", "a pipeline failure produces an honest spoken error, never a fabricated answer", async () => {
  const { EventBus } = await import("../src/core/event-bus.js");
  const voiceSessionModule = await import("../src/interaction/voice-session.js");

  const bus = EventBus.getInstance();
  let reply: any = null;
  const unsubscribe = bus.subscribe("voice:reply", (payload) => { reply = payload; });

  const throwingRouter = { generateWithFallback: async () => { throw new Error("simulated failure"); } } as any;
  const handle = voiceSessionModule.startVoiceSession({ router: throwingRouter, username: "voice_test_user" } as any);
  try {
    bus.publish("voice:transcript", { text: "do something" });
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (!reply || !reply.text) throw new Error("VoiceSession: expected an honest error reply, got none");
  } finally {
    unsubscribe();
    handle.stop();
  }
});
```

Note: `startVoiceSession`'s real signature (per the Interfaces section) takes no arguments in production (reads the real shared `cognitionRouter`/username-per-session state) — the test sketch above assumes an optional deps/override parameter for testability, matching this session's established DI pattern; design the real function signature to support this cleanly (e.g. `startVoiceSession(deps?: Partial<VoiceSessionDeps>): {stop: () => void}`), and adjust these test sketches to match whatever you actually build, as long as the described behaviors are genuinely exercised.

- [ ] **Step 3: Implement**, reusing `/api/chat`'s exact tool-calling loop shape (message building, `executeTool` dispatch, bounded retry loop, final-text extraction) — do not duplicate Gemini Live's bespoke `functionResponse`/`thought_signature` handling, this reuses the Groq/CognitionRouter branch's simpler OpenAI-compatible shape exactly as the spec directs.

- [ ] **Step 4: Run tests to verify they pass**

Export the standard env vars. Run `npx tsc --noEmit && npm test`.

- [ ] **Step 5: Commit**

```bash
git add src/interaction/voice-session.ts tests/index.test.ts
git commit -m "feat: add the voice-session handler, reusing the existing local tool-calling pipeline"
```

---

## Task 5: `server.ts` — remove `/ws/voice`/Gemini Live wiring, wire in the new pipeline; delete `live-voice.ts`

**Files:**
- Modify: `src/server.ts`
- Delete: `src/interaction/live-voice.ts`
- Test: `tests/index.test.ts` (remove/update any test that specifically exercised the old `/ws/voice` Gemini Live behavior — check first, don't blindly delete real coverage)

**Interfaces:**
- Consumes: `startAudioClient` (Task 3), `startVoiceSession` (Task 4).

- [ ] **Step 1: Read the current `/ws/voice` route, `voiceWss` construction, and every `live-voice.ts` import site in `server.ts` completely first.**

- [ ] **Step 2: Remove the old wiring**

Remove the `/ws/voice` upgrade-dispatcher branch, `voiceWss`'s construction (if nothing else needs it — check first), and the `import * as liveVoice from "./interaction/live-voice.js"` line and every call site.

- [ ] **Step 3: Wire in the new pipeline at startup**

```typescript
const audioClient = startAudioClient(process.env.VOICE_DAEMON_SOCKET || "/tmp/jarvis-voice/voice.sock");
const voiceSession = startVoiceSession();
```

placed alongside the other startup wiring (`startFilesystemWatcher`, `startLiveAnalysis`, etc.).

- [ ] **Step 4: Delete `src/interaction/live-voice.ts`**

```bash
git rm src/interaction/live-voice.ts
```

- [ ] **Step 5: Typecheck — this is the real completion gate for this task**

Run: `npx tsc --noEmit`. Every remaining error must be traced to a specific, understood cause (a caller of something `live-voice.ts` used to export) and fixed as part of this task, not deferred.

- [ ] **Step 6: Run tests, fix any that referenced the removed `/ws/voice` Gemini behavior**

Export the standard env vars. Run `npm test`. If an existing `HTTP Boundary` test specifically exercised `/ws/voice`'s old ticket/Gemini-Live semantics, either update it to test the new pipeline's real behavior or remove it with a clear justification in your report — don't silently delete real coverage without explaining why it's no longer applicable.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: replace /ws/voice's Gemini Live wiring with the local voice daemon pipeline"
```

---

## Task 5b: `src/interaction/static/index.html` — repoint the frontend voice UI

> Added after Task 5's review surfaced a real gap: this file's frontend JS still calls `POST /api/voice-ticket` and opens `ws://.../ws/voice?ticket=...` — both removed by Task 5. Left as-is, the browser's voice UI button silently breaks (404 on ticket fetch, then an immediately-closed WS handshake). Not covered by any other task in this plan, so it's inserted here, before the final cleanup sweep, rather than left as a known-broken follow-up.

**Files:**
- Modify: `src/interaction/static/index.html`

**Interfaces:**
- Consumes: nothing new server-side — the new voice pipeline (Tasks 1-5) is entirely server-driven (Unix socket daemon → event bus → tool-calling pipeline), with no client-initiated ticket/WebSocket handshake analogous to the old Gemini Live flow. The browser no longer needs to open its own voice WebSocket at all.

- [ ] **Step 1: Read the current frontend voice UI code completely first**

Find and read every place in `src/interaction/static/index.html` that references `/api/voice-ticket`, `/ws/voice`, or any Gemini-Live-specific client-side audio-streaming logic (microphone capture, PCM chunk sending, ticket fetch-then-connect sequencing). Understand exactly what UI element (e.g. a mic button) triggers this flow and what visual/state feedback it currently gives the user (recording indicator, error states).

- [ ] **Step 2: Decide the real fix**

The new pipeline's voice loop runs entirely server-side against the daemon's Unix socket — there is no browser-facing WebSocket for voice audio anymore (unlike `/ws/events`, which remains for general event-bus streaming to the browser, or unlike the old `/ws/voice`). Two honest options, pick based on what you find in Step 1:

(a) If the frontend's voice button was for browser-microphone capture streamed to the server (the old Gemini Live pattern), and the new architecture instead expects audio input at the daemon's Unix socket directly (e.g. from a local microphone process on the same machine as the daemon, not from the browser tab) — then the browser-side voice button's old flow is fundamentally incompatible with the new architecture. In this case, remove the broken ticket-fetch/WebSocket-connect JS and either (i) remove the mic button/UI entirely with a comment explaining voice input is now handled by the local daemon directly (not through the browser), or (ii) if `voice:transcript`/`voice:reply` events are also published on the existing `/ws/events` bus (check `src/core/event-bus.ts`'s real topic list and whether `/ws/events`'s server-side handler forwards ALL bus topics to connected browser clients or only a curated subset), wire the UI to passively display transcripts/replies as they occur via `/ws/events` instead of trying to initiate voice sessions itself.

(b) If investigation reveals a different, real, working browser-to-daemon path already exists that Task 5 didn't remove, use that instead.

Whichever you choose, the concrete, non-negotiable requirement is: **no remaining frontend code may call the removed `/api/voice-ticket` endpoint or attempt to open `/ws/voice`** — every reference must be either removed or repointed at something real that exists after Task 5's changes.

- [ ] **Step 3: Implement the fix**

Make the HTML/JS change per your Step 2 decision. Keep the diff scoped to the voice UI — don't refactor unrelated parts of `index.html`.

- [ ] **Step 4: Manual verification**

Since this is frontend-only HTML/JS with no automated test harness in this codebase for browser-side code, verify by reading the resulting code path once fully (from button click through to whatever it now does) and confirming no reference to the removed endpoints remains: `grep -n "voice-ticket\|/ws/voice" src/interaction/static/index.html` should return nothing (or only a comment explaining the old behavior was removed, if you choose to leave one). Document in your report exactly what you changed and why, including a plain-English description of what the voice UI does now versus what it did before, since a future engineer (or the project owner) will want to know if the browser button was removed versus rewired.

- [ ] **Step 5: Run the full test suite to confirm no regression**

Export the standard env vars. Run `npx tsx --env-file=.env tests/index.test.ts` and confirm the pass count matches Task 5's baseline exactly (this task touches no TypeScript, so no test should be affected either way — a changed count here would indicate something unexpected happened).

- [ ] **Step 6: Commit**

```bash
git add src/interaction/static/index.html
git commit -m "fix: repoint the frontend voice UI off the removed ticket/WebSocket flow"
```

---

## Task 6: `docker-compose.yml` — remove whisper-cpp/tts, add voice-daemon

**Files:**
- Modify: `docker-compose.yml`

- [ ] **Step 1: Read the current `whisper-cpp`, `tts`, and `llama-cpp` service definitions completely first** — `llama-cpp`'s definition is your template for the new service's shape (volumes, restart policy, resource limits if any).

- [ ] **Step 2: Remove `whisper-cpp` and `tts` services**, and remove `whisper-cpp` from the `jarvis-os-api` service's `depends_on` list (found in Task 1's earlier grep at line 47).

- [ ] **Step 3: Add the new `voice-daemon` service**

```yaml
  voice-daemon:
    build:
      context: ./daemon
    container_name: jarvis-voice-daemon
    restart: unless-stopped
    volumes:
      - voice-socket:/tmp/jarvis-voice
```

Add a `Dockerfile` in `daemon/` (Python base image, `pip install -r requirements.txt`, `CMD ["python3", "voice_engine.py"]`) if one doesn't already exist from Task 1/2 — check first. Add `voice-socket` to the top-level `volumes:` section, and mount the same `voice-socket` volume into `jarvis-os-api`'s service definition at the same path so `audio-client.ts` can reach the socket. Add `voice-daemon` to `jarvis-os-api`'s `depends_on`.

- [ ] **Step 4: Validate the compose file**

Run: `docker compose config` (or `docker-compose config`) to confirm the YAML is syntactically valid and resolves correctly — this doesn't require actually starting containers.

- [ ] **Step 5: Commit**

```bash
git add docker-compose.yml daemon/Dockerfile
git commit -m "feat: replace whisper-cpp/tts services with the voice-daemon in docker-compose.yml"
```

---

## Task 7: `src/interaction/whisper.ts` — repoint `/api/voice-input`'s fallback

**Files:**
- Modify: `src/interaction/whisper.ts`
- Modify: `src/server.ts` (wherever `/api/voice-input` calls `whisper.transcribeAudio`)
- Test: `tests/index.test.ts`

- [ ] **Step 1: Read `whisper.ts`'s current `transcribeAudio` and every real caller in `server.ts` completely first.**

- [ ] **Step 2: Decide and implement the real fix**

The old `WHISPER_URL`-based HTTP call is gone (whisper-cpp service removed in Task 6). The new daemon does STT via the Unix socket protocol, not a synchronous HTTP endpoint — so `/api/voice-input`'s fallback either needs a new one-shot request/response path against the daemon (send one `audio_chunk` + an explicit "transcribe now" control message, wait for the `transcript` reply on that same connection) or an explicit, honest removal of this fallback if it's genuinely redundant with the new always-on daemon pipeline. Read the actual `/api/voice-input` call site to judge which is correct — if it's a distinct, still-needed one-shot HTTP upload path (not the continuous voice-session flow), implement a small one-shot socket request/response function in `audio-client.ts` or a new helper; if it's now genuinely dead code superseded by the continuous pipeline, remove it and document why in your report rather than leaving a silently-broken fallback.

- [ ] **Step 3: Typecheck, run tests, commit**

Export the standard env vars. Run `npx tsc --noEmit && npm test`.

```bash
git add -A
git commit -m "fix: repoint /api/voice-input's transcription fallback at the local voice daemon"
```

---

## Task 8: `src/interaction/tts.ts` — repoint `speak_text`/notifications at Kokoro

**Files:**
- Modify: `src/interaction/tts.ts`
- Test: `tests/index.test.ts`

- [ ] **Step 1: Read `tts.ts`'s current `synthesizeSpeech` and every real caller (`speak_text` tool in `tools.ts`, any notification-related TTS call) completely first.**

- [ ] **Step 2: Implement the real fix**

Same shape as Task 7: the old `TTS_URL`-based HTTP call is gone (tts service removed in Task 6). Implement a one-shot socket request against the daemon (send `{"type":"speak","text":...}`, collect the `audio_chunk` response(s) until `speak_done`, return the concatenated PCM bytes) so `synthesizeSpeech`'s existing callers keep working with the same function signature/return shape they already expect, just backed by the new daemon instead of the removed HTTP service.

- [ ] **Step 3: Typecheck, run tests, commit**

Export the standard env vars. Run `npx tsc --noEmit && npm test`.

```bash
git add -A
git commit -m "fix: repoint speak_text/TTS notifications at the local voice daemon's Kokoro synthesis"
```

---

## Task 9: Final cleanup and verification

- [ ] **Step 1: Full sweep for stale references**

Run: `grep -rn "whisper-cpp\|WHISPER_URL\|TTS_URL\|openai-edge-tts\|live-voice\|ai\.live\.connect" src/ docker-compose.yml --include="*.ts"` — every remaining hit should be either historical/comparative prose in a comment, or something explicitly and deliberately out of scope (verify each one, don't assume).

- [ ] **Step 2: Confirm `tsc --noEmit` is fully clean, `npm test` passes, `cd daemon && python3 -m pytest` passes.**

- [ ] **Step 3: Confirm the architectural boundary held** — grep the whole `daemon/` directory for any LLM-client-shaped import (`groq`, `cognition-router`, any HTTP call to an LLM endpoint) — there should be none. The daemon does STT/TTS only.

- [ ] **Step 4: If Docker is available in this environment, attempt a real `docker compose build voice-daemon`** to confirm the Dockerfile actually builds (even if you can't fully run the multi-container stack) — document the result plainly, including any real failure, rather than skipping this check.

- [ ] **Step 5: Update the design spec's own status note if anything discovered during implementation contradicts what it originally said** (matching this session's established practice of correcting specs after real implementation reveals something the design-time research got wrong), commit.
