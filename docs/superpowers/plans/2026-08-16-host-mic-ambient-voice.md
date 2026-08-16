# Host-Mic Ambient Voice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the just-merged browser-based ambient wake-word engine with a server-side one — a real mic/speaker attached to the Docker host, wake-word detection via openWakeWord's official Python package inside `voice-daemon`, turns dispatched through the existing cognition-router/tools/memory pipeline under one fixed configured account, replies spoken back through the same physical device. No browser tab involved at any point.

**Architecture:** `voice-daemon` (Python) gains a background asyncio task that reads a real ALSA mic device, runs openWakeWord, captures the resulting utterance with the daemon's existing `UtteranceEndDetector`, transcribes it with the daemon's existing STT, and pushes the transcript up a new persistent Unix-socket connection Node opens at boot. Node dispatches that transcript through the existing `voice-session.ts` turn machinery (unchanged) under one fixed account, and sends the reply text back down the same connection for the daemon to synthesize and play locally.

**Tech Stack:** Python (`asyncio`, `openwakeword`, `sounddevice`), TypeScript/Node (`net`, existing `EventBus`), Docker Compose (ALSA device passthrough).

**Spec:** `docs/superpowers/specs/2026-08-16-host-mic-ambient-voice-design.md`

## Global Constraints

- The daemon gains zero DB/account/business-logic access. It only ever produces transcript text (unchanged) and now also drives playback of text handed to it — never touches usernames, capabilities, memory, or the cognition router.
- No change to click-to-talk (`/api/voice-input`, `whisper.ts`/`tts.ts`) or to the existing per-session daemon protocol messages (`audio_chunk`, `speak`, `transcript`, `speak_done`, `audio_data`, `transcribe`, `queued`) — all stay exactly as they are, still used by `transcribeOverSocket`/`synthesizeOverSocket`/`startAudioClient`.
- PR #154's browser wake-word engine (`openwakeword-engine.js`, `wake-word.js`, both vendor directories, the ambient toggle UI, `/ws/voice-stream`, `/api/voice-stream-ticket`, `voice-stream-ws.ts`, the `voice.ambient` capability) is removed entirely, not kept as a fallback.
- New host-mic subsystem defaults to off (`AMBIENT_LISTENING_ENABLED` unset/false) and must never prevent the daemon or API from booting cleanly when off or when no mic is attached.
- Kokoro's TTS output is fixed 24kHz mono 16-bit PCM (`daemon/models.py`'s `TextToSpeech.synthesize`) — every playback path must use that exact sample rate, not assume/guess one.

---

### Task 1: Daemon — `speak_local` handling + injectable `AudioPlayer`

**Files:**
- Modify: `daemon/models.py` (add `AudioPlayer` class + `KOKORO_SAMPLE_RATE` constant)
- Modify: `daemon/voice_engine.py` (add `_handle_speak_local`, dispatch case, module-level `_player` instance)
- Test: `daemon/tests/test_voice_engine.py` (add test function)
- Test: `daemon/tests/test_models.py` (add test function)

**Interfaces:**
- Produces: `models.AudioPlayer(player_loader: Optional[Callable] = None)` with method `play(pcm_bytes: bytes, sample_rate: int) -> None`. Real `player_loader` returns a callable `sd.play`-shaped object (lazily imports `sounddevice`, mirroring `_load_whisper_model`/`_load_kokoro_model`'s lazy-import pattern so importing `models.py` never requires `sounddevice`/PortAudio to be present).
- Produces: `models.KOKORO_SAMPLE_RATE = 24000` (currently only documented in comments; making it a real constant, matching how `src/interaction/tts.ts`'s `KOKORO_SAMPLE_RATE` already does on the Node side).
- Consumes (Task 3): none from this task's own perspective — `voice_engine.py`'s new `_handle_speak_local` is a self-contained addition to the existing per-connection dispatch loop.

- [ ] **Step 1: Write the failing test for `AudioPlayer`**

```python
# daemon/tests/test_models.py -- add at the end of the file
def test_audio_player_calls_the_injected_backend_with_the_right_sample_rate():
    import numpy as np

    calls = []

    # Matches the real sounddevice-shaped call AudioPlayer.play() makes
    # below: backend.play(audio_array, samplerate=..., device=...) followed
    # by backend.wait() -- NOT a (pcm_bytes, sample_rate) positional shape.
    class FakeBackend:
        def play(self, data, samplerate=None, device=None):
            calls.append((data, samplerate, device))

        def wait(self):
            calls.append("waited")

    player = models.AudioPlayer(player_loader=lambda: FakeBackend())
    player.play(b"\x01\x00\x02\x00", 24000)

    assert len(calls) == 2, f"expected one play() call and one wait() call, got: {calls}"
    data, samplerate, device = calls[0]
    assert np.array_equal(data, np.array([1, 2], dtype=np.int16)), f"expected the PCM bytes decoded as int16, got: {data}"
    assert samplerate == 24000
    assert calls[1] == "waited"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd daemon && python3 -m pytest tests/test_models.py::test_audio_player_calls_the_injected_backend_with_the_right_sample_rate -v`
Expected: FAIL with `AttributeError: module 'models' has no attribute 'AudioPlayer'`

- [ ] **Step 3: Implement `AudioPlayer` in `daemon/models.py`**

Add near the top, alongside the other module constants:

```python
KOKORO_SAMPLE_RATE = 24000  # Kokoro's fixed TTS output sample rate -- see TextToSpeech.synthesize below.


def _load_audio_player_backend():
    import sounddevice as sd
    return sd
```

Add as a new class, after `TextToSpeech`:

```python
class AudioPlayer:
    """Plays raw int16 PCM directly out a host audio device -- used only by
    the ambient host-mic path (Task 3), which has no caller waiting to
    receive bytes back over the socket, unlike _handle_speak's existing
    stream-back-to-caller behavior. Lazily imports sounddevice (same
    reasoning as _load_whisper_model/_load_kokoro_model above) so importing
    this module never requires PortAudio to be present -- real playback
    only happens if something actually calls play()."""

    def __init__(self, player_loader: Optional[Callable] = None):
        self._loader = player_loader or _load_audio_player_backend
        self._backend = None
        self._load_lock = threading.Lock()

    def _ensure_loaded(self):
        if self._backend is None:
            with self._load_lock:
                if self._backend is None:
                    self._backend = self._loader()
        return self._backend

    def play(self, pcm_bytes: bytes, sample_rate: int) -> None:
        import numpy as np
        backend = self._ensure_loaded()
        audio = np.frombuffer(pcm_bytes, dtype=np.int16)
        backend.play(audio, samplerate=sample_rate, device=_AMBIENT_SPEAKER_DEVICE)
        backend.wait()
```

`_AMBIENT_SPEAKER_DEVICE` is read from the environment at module scope, alongside `WHISPER_MODEL_SIZE`/`KOKORO_VOICE`:

```python
import os
_AMBIENT_SPEAKER_DEVICE = os.environ.get("AMBIENT_SPEAKER_DEVICE") or None  # None -> sounddevice's system default output device
```

Real `sounddevice.play(data, samplerate, device)` accepts `device=None` for "use the system default" — verify this against the actually-installed `sounddevice` version during Task 2 (this is exactly the kind of assumed-API-shape risk `TextToSpeech`'s own docstring above already documents having hit once for Kokoro's real API).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd daemon && python3 -m pytest tests/test_models.py::test_audio_player_calls_the_injected_backend_with_the_right_sample_rate -v`
Expected: PASS

- [ ] **Step 5: Write the failing test for `speak_local` dispatch**

```python
# daemon/tests/test_voice_engine.py -- add at the end of the file
def test_speak_local_synthesizes_and_plays_without_streaming_audio_chunks_back(monkeypatch):
    played = []

    def fake_synthesize(text: str) -> bytes:
        return f"pcm-for-{text}".encode()

    class FakePlayer:
        def play(self, pcm_bytes, sample_rate):
            played.append((pcm_bytes, sample_rate))

    monkeypatch.setattr(voice_engine._tts, "synthesize", fake_synthesize)
    monkeypatch.setattr(voice_engine, "_player", FakePlayer())

    async def scenario():
        sock_path = tempfile.mktemp(suffix=".sock")
        voice_engine._inference_queue = voice_engine.InferenceQueue()
        voice_engine._inference_queue.start()
        server = await asyncio.start_unix_server(voice_engine.handle_connection, path=sock_path)
        try:
            async with server:
                asyncio.ensure_future(server.serve_forever())
                reader, writer = await asyncio.open_unix_connection(sock_path)
                try:
                    writer.write((json.dumps({"type": "speak_local", "text": "hello sir"}) + "\n").encode())
                    await writer.drain()

                    line = await asyncio.wait_for(reader.readline(), timeout=5)
                    msg = json.loads(line.decode())
                    assert msg == {"type": "speak_local_done"}, (
                        f"speak_local must send exactly one speak_local_done, no audio_chunk frames, got: {msg}"
                    )
                    assert played == [(b"pcm-for-hello sir", voice_engine.KOKORO_SAMPLE_RATE)]
                finally:
                    writer.close()
        finally:
            if os.path.exists(sock_path):
                os.remove(sock_path)

    _run(scenario())
```

- [ ] **Step 6: Run test to verify it fails**

Run: `cd daemon && python3 -m pytest tests/test_voice_engine.py::test_speak_local_synthesizes_and_plays_without_streaming_audio_chunks_back -v`
Expected: FAIL — no response arrives (unknown message type is just logged, per the existing `else: log.info(...)` branch), so the `reader.readline()` call times out.

- [ ] **Step 7: Implement `_handle_speak_local` and wire it into the dispatch loop**

In `daemon/voice_engine.py`, add near the top (after the existing `from models import SpeechToText, TextToSpeech` line):

```python
from models import AudioPlayer, SpeechToText, TextToSpeech, KOKORO_SAMPLE_RATE
```

Add a module-level instance alongside `_stt`/`_tts`:

```python
_player = AudioPlayer()
```

Add the handler, right after `_handle_speak`:

```python
async def _handle_speak_local(writer: asyncio.StreamWriter, msg: dict, peer: str) -> None:
    """Synthesizes and plays text DIRECTLY out the host speaker -- unlike
    _handle_speak above, there is no caller waiting to receive audio_chunk
    frames back; this is the ambient host-mic path's reply mechanism (Task
    3), where the daemon itself owns playback. Still goes through
    _inference_queue (Kokoro synthesis is exactly as slow/synchronous here
    as it is for _handle_speak) but AudioPlayer.play() blocks on real
    playback duration too -- submitted as its own inference-queue job so a
    long reply's PLAYBACK time doesn't hold the queue open for OTHER
    connections' STT/TTS calls, only the synthesis step does."""
    text = msg.get("text", "")
    future, position = await _inference_queue.submit(_tts.synthesize, text)
    if position > 0:
        await _write_message(writer, {"type": "queued", "position": position})
    try:
        audio_bytes = await future
    except Exception:
        log.exception(f"TTS synthesis failed for {peer} (speak_local)")
        return
    try:
        await asyncio.to_thread(_player.play, audio_bytes, KOKORO_SAMPLE_RATE)
    except Exception:
        log.exception(f"Local playback failed for {peer} (speak_local)")
        return
    await _write_message(writer, {"type": "speak_local_done"})
```

Add the dispatch case in `handle_connection`'s message loop, alongside the existing `elif msg_type == "speak":` branch:

```python
            elif msg_type == "speak_local":
                await _handle_speak_local(writer, msg, peer)
```

- [ ] **Step 8: Run test to verify it passes**

Run: `cd daemon && python3 -m pytest tests/test_voice_engine.py::test_speak_local_synthesizes_and_plays_without_streaming_audio_chunks_back -v`
Expected: PASS

- [ ] **Step 9: Run the full daemon test suite**

Run: `cd daemon && python3 -m pytest -v`
Expected: All tests pass, including the two new ones and every pre-existing test unchanged.

- [ ] **Step 10: Commit**

```bash
git add daemon/models.py daemon/voice_engine.py daemon/tests/test_models.py daemon/tests/test_voice_engine.py
git commit -m "feat: add speak_local (synthesize + play directly on the host) to the voice daemon"
```

---

### Task 2: Docker — ALSA device passthrough + new Python deps

**Files:**
- Modify: `daemon/requirements.txt`
- Modify: `daemon/Dockerfile`
- Modify: `docker-compose.yml`

**Interfaces:**
- Produces: `openwakeword` and `sounddevice` importable inside the `voice-daemon` container; `AMBIENT_MIC_DEVICE`/`AMBIENT_SPEAKER_DEVICE`/`AMBIENT_LISTENING_ENABLED`/`AMBIENT_WAKE_WORD_THRESHOLD` environment variables reaching the container.
- Consumes: nothing from Task 1 — this task is infrastructure-only and can be done independently of it, but is sequenced after it so Task 3 (which needs both) has both ready.

- [ ] **Step 1: Add new dependencies to `daemon/requirements.txt`**

Add these two lines (keep the existing pinned deps and their comment block unchanged above them):

```
openwakeword==0.6.0
sounddevice>=0.4.6
```

`openwakeword==0.6.0` is pinned per this file's existing convention (see the comment above `kokoro==0.9.4`) — **verify during this step that this version actually resolves** (`pip index versions openwakeword` or attempt the install below); if it doesn't, pin whatever the real latest version is instead. This mirrors exactly how `kokoro`'s own pin was arrived at (a real installed-version check, not a guess left unverified).

- [ ] **Step 2: Add PortAudio's runtime library to `daemon/Dockerfile`**

`sounddevice` is a thin ctypes wrapper around PortAudio — it needs `libportaudio2` present at runtime (not just at pip-install time). Add it to the existing `apt-get install` line:

```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends \
    espeak-ng \
    libportaudio2 \
    && rm -rf /var/lib/apt/lists/*
```

- [ ] **Step 3: Add device passthrough and ambient env vars to `docker-compose.yml`'s `voice-daemon` service**

Add a `devices:` block and `group_add:` (for ALSA permission — the container's default user needs to be in the host's `audio` group to open `/dev/snd/*`), plus the new env vars, to the existing `voice-daemon:` service definition:

```yaml
  voice-daemon:
    build:
      context: ./daemon
    container_name: jarvis-voice-daemon
    restart: unless-stopped
    # Passes the host's real ALSA audio devices through to the container --
    # required for the ambient host-mic listener (Task 3) to reach a
    # physical mic/speaker at all. Absent or empty on a host with no
    # AMBIENT_LISTENING_ENABLED intent -- see that env var below, which
    # gates whether the daemon even tries to open a device, so a host with
    # no `/dev/snd` (e.g. a cloud VM) still boots cleanly with ambient
    # listening simply never turned on.
    devices:
      - "/dev/snd:/dev/snd"
    # The container's default user must belong to the host's `audio` GID to
    # open /dev/snd/* -- exact GID varies per host (verify with `getent
    # group audio` on the real deploy host and adjust if it isn't 29, the
    # common Debian/Ubuntu default).
    group_add:
      - "29"
    environment:
      - AMBIENT_LISTENING_ENABLED=${AMBIENT_LISTENING_ENABLED:-false}
      - AMBIENT_MIC_DEVICE=${AMBIENT_MIC_DEVICE:-}
      - AMBIENT_SPEAKER_DEVICE=${AMBIENT_SPEAKER_DEVICE:-}
      - AMBIENT_WAKE_WORD_THRESHOLD=${AMBIENT_WAKE_WORD_THRESHOLD:-0.5}
    volumes:
      - voice-socket:/tmp/jarvis-voice
      - voice-model-cache:/root/.cache/huggingface
    healthcheck:
      test: ["CMD-SHELL", "test -S /tmp/jarvis-voice/voice.sock || exit 1"]
      interval: 5s
      timeout: 3s
      start_period: 90s
      retries: 5
```

(Only the `devices`, `group_add`, and `environment` blocks are new — `volumes`/`healthcheck`/everything else stays exactly as it already is; shown in full here only so the whole service definition is unambiguous.)

- [ ] **Step 4: Verify the image builds and the new deps import**

Run: `docker compose build voice-daemon`
Expected: build succeeds.

Run: `docker compose run --rm voice-daemon python3 -c "import openwakeword, sounddevice; print('ok')"`
Expected: prints `ok`. If `openwakeword` or `sounddevice` fail to import, fix the pin/apt package before continuing — this is the real, automatable check for this task, standing in for a live-mic check that genuinely can't run in this environment.

- [ ] **Step 5: Commit**

```bash
git add daemon/requirements.txt daemon/Dockerfile docker-compose.yml
git commit -m "build: add openwakeword/sounddevice deps and ALSA device passthrough for ambient listening"
```

---

### Task 3: Daemon — `ambient_listener.py` (wake-word + utterance capture + dispatch)

**Files:**
- Create: `daemon/ambient_listener.py`
- Modify: `daemon/voice_engine.py` — start the listener as a background task in `main()`; add the `hello_ambient` dispatch case (identifies which connection is the Node ambient client, so `ambient_transcript` has somewhere to be written) and the corresponding `_ambient_writer` cleanup in `handle_connection`'s `finally` block; wrap Task 1's `_handle_speak_local` in a `finally: turn_complete()` so a wake-word-triggered turn always re-arms once its reply is done (or fails) — without this, `AmbientListener._turn_in_progress` would stay `True` forever after the first trigger.
- Test: `daemon/tests/test_ambient_listener.py`

**Interfaces:**
- Consumes: `protocol.UtteranceEndDetector` (unchanged, existing), the module-level `_stt` instance from `voice_engine.py` (`_stt.transcribe`). Task 1's `AudioPlayer`/`_player` is not used here — that's the reply path, not detection — but Task 1's `_handle_speak_local` IS modified by this task (see above).
- Produces: `AmbientListener` class with `async def run(self) -> None` (runs until cancelled), `def turn_complete(self) -> None`, and constructor `AmbientListener(frame_queue: asyncio.Queue, wake_word_predict: Callable[[np.ndarray], float], transcribe: Callable[[bytes], str], on_transcript: Callable[[str], Awaitable[None]], threshold: float, silence_frames_threshold: int = 15)`. `frame_queue` yields raw int16 PCM chunks of exactly `CHUNK_SAMPLES` (1280) samples — the real production queue is filled by `start_mic_capture()` (see Step 5), tests fill it directly with a plain `asyncio.Queue`.
- Produces: `start_mic_capture(device: Optional[str], sample_rate: int = 16000, chunk_samples: int = 1280) -> asyncio.Queue` — the untestable-without-hardware sounddevice wiring, kept as small and isolated as possible so `AmbientListener` itself never touches sounddevice directly.
- Produces (for Task 4, Node side, to rely on): the daemon accepts a `{"type": "hello_ambient"}` message on any connection, marking that connection as the one `ambient_transcript` messages get written to. Node is always the one connecting TO the daemon (the daemon is always the Unix-socket server, per every existing connection in this codebase — `startAudioClient`/`transcribeOverSocket`/`synthesizeOverSocket` all connect FROM Node TO the daemon) — this task doesn't open any outbound connection itself.

- [ ] **Step 1: Write the failing test for wake-word-triggered utterance capture and dispatch**

```python
# daemon/tests/test_ambient_listener.py
import asyncio
import os
import sys

import numpy as np

_DAEMON_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _DAEMON_DIR not in sys.path:
    sys.path.insert(0, _DAEMON_DIR)

from ambient_listener import AmbientListener, CHUNK_SAMPLES  # noqa: E402


def _run(coro):
    return asyncio.run(coro)


def _speech_chunk(rms=2000):
    return np.full(CHUNK_SAMPLES, rms, dtype=np.int16)


def _silent_chunk():
    return np.full(CHUNK_SAMPLES, 0, dtype=np.int16)


def test_wake_word_trigger_captures_the_following_utterance_and_dispatches_its_transcript():
    # Predictor scores exactly one chunk (the 3rd fed in) above threshold --
    # everything before and after scores 0. That 3rd chunk is the wake-word
    # itself and must NOT be included in the captured utterance (matches
    # how a real wake-word engine's trigger chunk is consumed by detection,
    # not by the STT that follows).
    scores = iter([0.0, 0.0, 0.9, 0.0, 0.0])

    def fake_predict(frame):
        return next(scores, 0.0)

    transcribed_pcm = []

    def fake_transcribe(pcm_bytes):
        transcribed_pcm.append(pcm_bytes)
        return "hey jarvis what time is it"

    dispatched = []

    async def fake_on_transcript(text):
        dispatched.append(text)

    async def scenario():
        queue = asyncio.Queue()
        listener = AmbientListener(
            frame_queue=queue,
            wake_word_predict=fake_predict,
            transcribe=fake_transcribe,
            on_transcript=fake_on_transcript,
            threshold=0.5,
            silence_frames_threshold=3,
        )
        run_task = asyncio.ensure_future(listener.run())
        try:
            # Chunks 1-2: below threshold, no trigger yet.
            await queue.put(_silent_chunk().tobytes())
            await queue.put(_silent_chunk().tobytes())
            # Chunk 3: the wake-word trigger itself.
            await queue.put(_speech_chunk().tobytes())
            # Chunks 4-6: the actual utterance being spoken.
            await queue.put(_speech_chunk().tobytes())
            await queue.put(_speech_chunk().tobytes())
            await queue.put(_speech_chunk().tobytes())
            # Chunks 7-9: silence past silence_frames_threshold (3) ends the utterance.
            await queue.put(_silent_chunk().tobytes())
            await queue.put(_silent_chunk().tobytes())
            await queue.put(_silent_chunk().tobytes())

            for _ in range(200):
                if dispatched:
                    break
                await asyncio.sleep(0.01)

            assert dispatched == ["hey jarvis what time is it"]
            # Exactly the 3 speech chunks captured post-trigger -- not the
            # trigger chunk itself, not the trailing silence.
            expected_len = 3 * CHUNK_SAMPLES * 2  # int16 = 2 bytes/sample
            assert len(transcribed_pcm) == 1
            assert len(transcribed_pcm[0]) == expected_len
        finally:
            run_task.cancel()
            try:
                await run_task
            except asyncio.CancelledError:
                pass

    _run(scenario())


def test_no_trigger_below_threshold_never_dispatches():
    def fake_predict(frame):
        return 0.1  # always below threshold

    def fake_transcribe(pcm_bytes):
        raise AssertionError("transcribe must not be called when the wake word never triggers")

    dispatched = []

    async def fake_on_transcript(text):
        dispatched.append(text)

    async def scenario():
        queue = asyncio.Queue()
        listener = AmbientListener(
            frame_queue=queue,
            wake_word_predict=fake_predict,
            transcribe=fake_transcribe,
            on_transcript=fake_on_transcript,
            threshold=0.5,
        )
        run_task = asyncio.ensure_future(listener.run())
        try:
            for _ in range(10):
                await queue.put(_speech_chunk().tobytes())
            await asyncio.sleep(0.2)
            assert dispatched == []
        finally:
            run_task.cancel()
            try:
                await run_task
            except asyncio.CancelledError:
                pass

    _run(scenario())
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd daemon && python3 -m pytest tests/test_ambient_listener.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'ambient_listener'`

- [ ] **Step 3: Implement `AmbientListener`**

```python
# daemon/ambient_listener.py
"""Continuous host-mic wake-word listening: reads raw PCM frames from an
injectable queue, scores each through an injectable wake-word predictor,
and on a trigger, captures the following utterance using the SAME
UtteranceEndDetector state machine voice_engine.py already uses for the
per-session streaming path (protocol.py) -- just fed from the live mic
queue instead of socket messages. On utterance end, transcribes it
(reusing voice_engine.py's existing STT) and calls on_transcript(text).

Deliberately knows nothing about sockets, Node, or usernames -- see this
plan's Global Constraints. It only ever produces plain transcript text.
"""
import asyncio
import logging
from typing import Awaitable, Callable, Optional

import numpy as np

from protocol import UtteranceEndDetector

log = logging.getLogger("voice_engine.ambient_listener")

CHUNK_SAMPLES = 1280  # 80ms @ 16kHz -- matches openWakeWord's own required input chunk size
SAMPLE_RATE = 16000
SILENCE_RMS_THRESHOLD = 500  # matches voice_engine.SILENCE_RMS_THRESHOLD exactly


def _is_speech_frame(pcm_bytes: bytes) -> bool:
    if not pcm_bytes:
        return False
    audio = np.frombuffer(pcm_bytes, dtype=np.int16)
    if audio.size == 0:
        return False
    rms = float(np.sqrt(np.mean(audio.astype(np.float64) ** 2)))
    return rms > SILENCE_RMS_THRESHOLD


class AmbientListener:
    def __init__(
        self,
        frame_queue: "asyncio.Queue[bytes]",
        wake_word_predict: Callable[[np.ndarray], float],
        transcribe: Callable[[bytes], str],
        on_transcript: Callable[[str], Awaitable[None]],
        threshold: float,
        silence_frames_threshold: int = 15,
    ):
        self.frame_queue = frame_queue
        self.wake_word_predict = wake_word_predict
        self.transcribe = transcribe
        self.on_transcript = on_transcript
        self.threshold = threshold
        self.silence_frames_threshold = silence_frames_threshold
        # True from the instant a wake word triggers until the resulting
        # turn's transcript has been dispatched -- guards against a second
        # trigger (or the tail of the reply itself, once mic capture and
        # playback coexist) starting a second capture mid-turn.
        self._turn_in_progress = False

    async def run(self) -> None:
        detector: Optional[UtteranceEndDetector] = None
        utterance_buffer = bytearray()

        while True:
            pcm_bytes = await self.frame_queue.get()

            if self._turn_in_progress:
                continue  # drop frames while a turn is in flight -- see the guard above

            if detector is None:
                # Not yet triggered -- score every frame for the wake word.
                frame = np.frombuffer(pcm_bytes, dtype=np.int16)
                try:
                    score = self.wake_word_predict(frame)
                except Exception:
                    log.exception("wake-word predictor raised; treating this frame as no-trigger")
                    score = 0.0
                if score >= self.threshold:
                    log.info(f"wake word triggered (score={score:.3f})")
                    detector = UtteranceEndDetector(silence_frames_threshold=self.silence_frames_threshold)
                    utterance_buffer = bytearray()
                continue

            # Triggered -- capture the utterance itself.
            utterance_ended = detector.feed(_is_speech_frame(pcm_bytes))
            if not utterance_ended:
                utterance_buffer.extend(pcm_bytes)
                continue

            pcm_for_utterance = bytes(utterance_buffer)
            detector = None
            utterance_buffer = bytearray()

            if not pcm_for_utterance:
                continue  # trigger with no real speech after it -- nothing to transcribe

            self._turn_in_progress = True
            try:
                text = await asyncio.to_thread(self.transcribe, pcm_for_utterance)
                text = text.strip()
                if text:
                    await self.on_transcript(text)
                else:
                    self._turn_in_progress = False
            except Exception:
                log.exception("ambient utterance transcription failed")
                self._turn_in_progress = False

    def turn_complete(self) -> None:
        """Called once the reply for the current turn has finished (Task 6
        wires this to the daemon receiving speak_local_done back from
        itself) -- re-arms wake-word detection for the next trigger."""
        self._turn_in_progress = False
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd daemon && python3 -m pytest tests/test_ambient_listener.py -v`
Expected: PASS

- [ ] **Step 5: Implement `start_mic_capture` (the real, untestable-without-hardware sounddevice wiring)**

Append to `daemon/ambient_listener.py`:

```python
def start_mic_capture(device: Optional[str], sample_rate: int = SAMPLE_RATE, chunk_samples: int = CHUNK_SAMPLES) -> "asyncio.Queue[bytes]":
    """Opens a real ALSA input stream and pushes each CHUNK_SAMPLES-sized
    int16 PCM block onto the returned queue. sounddevice's InputStream
    callback runs on its own C-managed thread (not the asyncio event loop),
    so loop.call_soon_threadsafe is required to safely hand data back --
    calling queue.put_nowait directly from that callback thread would
    corrupt asyncio's internal state. Verify sounddevice's real
    InputStream(callback=...) signature against the actually-installed
    version during this step (same caution as models.py's TextToSpeech
    docstring already documents for Kokoro's real API) -- this is written
    against sounddevice's documented callback shape
    (indata, frames, time, status), not independently verified here.
    """
    import sounddevice as sd

    loop = asyncio.get_running_loop()
    queue: "asyncio.Queue[bytes]" = asyncio.Queue()

    def callback(indata, frames, time_info, status):
        if status:
            log.warning(f"sounddevice input status: {status}")
        pcm_bytes = bytes(indata)
        loop.call_soon_threadsafe(queue.put_nowait, pcm_bytes)

    stream = sd.InputStream(
        device=device,
        channels=1,
        samplerate=sample_rate,
        blocksize=chunk_samples,
        dtype="int16",
        callback=callback,
    )
    stream.start()
    return queue
```

- [ ] **Step 6: Wire `AmbientListener` into `voice_engine.py`'s `main()`, gated by `AMBIENT_LISTENING_ENABLED`**

In `daemon/voice_engine.py`, add near the top-level config constants:

```python
AMBIENT_LISTENING_ENABLED = os.environ.get("AMBIENT_LISTENING_ENABLED", "false").lower() == "true"
AMBIENT_MIC_DEVICE = os.environ.get("AMBIENT_MIC_DEVICE") or None
AMBIENT_WAKE_WORD_THRESHOLD = float(os.environ.get("AMBIENT_WAKE_WORD_THRESHOLD", "0.5"))
```

Add the import:

```python
from ambient_listener import AmbientListener, start_mic_capture
```

Add a module-level holder for the current ambient connection's writer, plus the transcript-dispatch plumbing, right after `_active_writers`:

```python
# Set by handle_connection when the Node ambient client's persistent
# connection identifies itself via a "hello_ambient" message (see the new
# dispatch case below and Task 4's ambient-daemon-client.ts, which sends
# it immediately on connect) -- None until Node connects, and cleared back
# to None in handle_connection's own finally block when THAT connection
# closes. AmbientListener's on_transcript callback below writes to
# whichever writer this currently points at; if it's None when a wake word
# fires (Node hasn't connected yet, or dropped), the transcript is logged
# and discarded rather than crashing the listener.
_ambient_writer: Optional[asyncio.StreamWriter] = None
_ambient_listener: Optional["AmbientListener"] = None


async def _dispatch_ambient_transcript(text: str) -> None:
    if _ambient_writer is None or _ambient_writer.is_closing():
        log.warning(f"ambient wake word fired but no Node ambient connection is active; discarding transcript: {text!r}")
        if _ambient_listener is not None:
            _ambient_listener.turn_complete()
        return
    await _write_message(_ambient_writer, {"type": "ambient_transcript", "text": text})
```

Add the `hello_ambient` dispatch case to `handle_connection`'s existing message-type `if`/`elif` chain, alongside `speak_local`:

```python
            elif msg_type == "hello_ambient":
                global _ambient_writer
                _ambient_writer = writer
                log.info(f"ambient connection identified: {peer}")
```

`handle_connection` already has a `finally` block (clearing `_active_writers`, closing the socket) — extend it to also clear `_ambient_writer` if the closing connection was the ambient one, so `_dispatch_ambient_transcript`'s guard sees `None` immediately rather than relying only on `is_closing()`:

```python
    finally:
        _active_writers.discard(writer)
        global _ambient_writer
        if _ambient_writer is writer:
            _ambient_writer = None
        try:
            writer.close()
            await writer.wait_closed()
        except (ConnectionResetError, BrokenPipeError):
            pass
        log.info(f"connection closed: {peer}")
```

(Only the new `global _ambient_writer` / `if _ambient_writer is writer: ...` lines are added — the rest of this `finally` block is shown in full only so the insertion point is unambiguous; nothing else in it changes.)

Now fix Task 1's `_handle_speak_local` so a wake-word-triggered turn actually re-arms once its reply is done (or fails) -- without this, `AmbientListener._turn_in_progress` would stay `True` forever after the first trigger, since nothing currently calls `turn_complete()`. Replace `_handle_speak_local` (written in Task 1) with:

```python
async def _handle_speak_local(writer: asyncio.StreamWriter, msg: dict, peer: str) -> None:
    """Synthesizes and plays text DIRECTLY out the host speaker -- unlike
    _handle_speak above, there is no caller waiting to receive audio_chunk
    frames back; this is the ambient host-mic path's reply mechanism. The
    finally block re-arms AmbientListener regardless of success/failure --
    only the ambient connection ever sends speak_local (Task 4's
    ambient-daemon-client.ts), so it's always correct to call
    turn_complete() once this handler is done, whichever way it ends."""
    text = msg.get("text", "")
    try:
        future, position = await _inference_queue.submit(_tts.synthesize, text)
        if position > 0:
            await _write_message(writer, {"type": "queued", "position": position})
        try:
            audio_bytes = await future
        except Exception:
            log.exception(f"TTS synthesis failed for {peer} (speak_local)")
            return
        try:
            await asyncio.to_thread(_player.play, audio_bytes, KOKORO_SAMPLE_RATE)
        except Exception:
            log.exception(f"Local playback failed for {peer} (speak_local)")
            return
        await _write_message(writer, {"type": "speak_local_done"})
    finally:
        if _ambient_listener is not None:
            _ambient_listener.turn_complete()
```

In `main()`, right after the existing `asyncio.create_task(_warm_models())` line:

```python
    if AMBIENT_LISTENING_ENABLED:
        global _ambient_listener
        try:
            frame_queue = start_mic_capture(AMBIENT_MIC_DEVICE)
            _ambient_listener = AmbientListener(
                frame_queue=frame_queue,
                wake_word_predict=_make_wake_word_predictor(),
                transcribe=_stt.transcribe,
                on_transcript=_dispatch_ambient_transcript,
                threshold=AMBIENT_WAKE_WORD_THRESHOLD,
            )
            asyncio.create_task(_ambient_listener.run())
            log.info(f"ambient host-mic listening enabled (device={AMBIENT_MIC_DEVICE or 'default'})")
        except Exception:
            log.exception(
                "failed to start ambient host-mic listening -- AMBIENT_LISTENING_ENABLED is true but the "
                "mic device could not be opened; the rest of the daemon (click-to-talk STT/TTS) is unaffected"
            )
    else:
        log.info("ambient host-mic listening disabled (AMBIENT_LISTENING_ENABLED is not 'true')")
```

Add `_make_wake_word_predictor`, right above `main()`:

```python
def _make_wake_word_predictor() -> Callable[[np.ndarray], float]:
    """Real openWakeWord adapter -- wraps openwakeword.Model's predict()
    call behind AmbientListener's simple `frame -> float` interface.
    openWakeWord's real Model.predict(frame) takes a 1D int16 numpy array
    of exactly CHUNK_SAMPLES (1280) samples and returns a dict of
    {model_name: score} -- verify this against the actually-installed
    openwakeword==0.6.0 (Task 2) before relying on it; if the real
    installed API differs, this is the one function that needs to change,
    everything else in this file is decoupled from openWakeWord's exact
    shape by AmbientListener's injectable interface.
    """
    from openwakeword.model import Model
    model = Model(wakeword_models=["hey_jarvis"])

    def predict(frame: np.ndarray) -> float:
        prediction = model.predict(frame)
        return float(prediction.get("hey_jarvis", 0.0))

    return predict
```

Add `from typing import Callable` to the existing `from typing import Set` import line (`from typing import Callable, Set`).

- [ ] **Step 7: Run the full daemon test suite**

Run: `cd daemon && python3 -m pytest -v`
Expected: All tests pass, including both new `test_ambient_listener.py` tests.

- [ ] **Step 8: Commit**

```bash
git add daemon/ambient_listener.py daemon/voice_engine.py daemon/tests/test_ambient_listener.py
git commit -m "feat: add server-side wake-word listening (openWakeWord) to the voice daemon"
```

---

### Task 4: Node — `src/core/ambient-daemon-client.ts` (persistent connection module)

**Files:**
- Create: `src/core/ambient-daemon-client.ts`
- Test: `tests/index.test.ts` (new `AmbientDaemonClient` category)

**Interfaces:**
- Consumes: `EventBus.getInstance()` (existing), `bus.publish("voice:transcript", {text, sessionId, username})` / `bus.subscribe("voice:reply", ...)` (existing, unchanged contract from `voice-session.ts`); the daemon's `hello_ambient`/`ambient_transcript`/`speak_local` message types (Task 3) — this module sends the first and last, and reads the middle one.
- Produces: `startAmbientDaemonClient(socketPath: string, defaultUsername: string): { stop: () => void }` — exported for Task 5 to call from `server.ts`.
- Produces (internal constant, exported for the test file to assert against): `AMBIENT_SESSION_ID = "ambient-host"`.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/index.test.ts -- add a new category, after the VoiceSessionManager tests
registerTest("AmbientDaemonClient", "an ambient_transcript message triggers a real turn and the reply is sent back as speak_local", async () => {
  const net = await import("net");
  const os = await import("os");
  const path = await import("path");
  const { EventBus } = await import("../src/core/event-bus.js");
  const { startAmbientDaemonClient, AMBIENT_SESSION_ID } = await import("../src/core/ambient-daemon-client.js");
  const { startVoiceSession } = await import("../src/interaction/voice-session.js");

  const sockPath = path.join(os.tmpdir(), `ambient-test-${Date.now()}.sock`);
  const server = net.createServer((socket) => {
    socket.on("data", (data) => {
      const lines = data.toString("utf-8").split("\n").filter(Boolean);
      for (const line of lines) {
        const msg = JSON.parse(line);
        (server as any)._received = (server as any)._received || [];
        (server as any)._received.push(msg);
      }
    });
    (server as any)._socket = socket;
  });
  await new Promise<void>((resolve) => server.listen(sockPath, resolve));

  const bus = EventBus.getInstance();
  const voiceSession = startVoiceSession({
    router: {
      generateWithFallback: async () => ({
        choices: [{ message: { content: "Hello, sir.", tool_calls: [] } }],
      }),
    } as any,
    getAllToolDeclarations: () => [],
    toGroqTools: () => [],
    executeTool: (async () => ({ ok: true, output: "" })) as any,
    appendMessage: (async () => {}) as any,
    recall: (async () => []) as any,
    remember: (async () => {}) as any,
    reflectAndLearn: (async () => {}) as any,
    extractAndStore: (async () => {}) as any,
    extractSelfReflection: (async () => {}) as any,
    extractRapportSignal: (async () => {}) as any,
  });

  const client = startAmbientDaemonClient(sockPath, "alice");
  try {
    await new Promise((resolve) => setTimeout(resolve, 300)); // let the client connect

    const clientSocket = (server as any)._socket as import("net").Socket;
    clientSocket.write(JSON.stringify({ type: "ambient_transcript", text: "what's the time" }) + "\n");

    let received: any[] = [];
    for (let i = 0; i < 50; i++) {
      received = (server as any)._received || [];
      if (received.some((m) => m.type === "speak_local")) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const speakLocal = received.find((m) => m.type === "speak_local");
    if (!speakLocal) {
      throw new Error(`AmbientDaemonClient: expected a speak_local message, got: ${JSON.stringify(received)}`);
    }
    if (speakLocal.text !== "Hello, sir.") {
      throw new Error(`AmbientDaemonClient: expected the real turn's reply text, got: ${speakLocal.text}`);
    }
    if (AMBIENT_SESSION_ID !== "ambient-host") {
      throw new Error(`AmbientDaemonClient: expected AMBIENT_SESSION_ID to be "ambient-host", got: ${AMBIENT_SESSION_ID}`);
    }
  } finally {
    client.stop();
    voiceSession.stop();
    server.close();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsc --noEmit && npm test 2>&1 | grep AmbientDaemonClient`
Expected: FAIL — `Cannot find module '../src/core/ambient-daemon-client.js'`

- [ ] **Step 3: Implement `src/core/ambient-daemon-client.ts`**

```typescript
import * as net from "net";
import * as readline from "readline";
import { EventBus } from "./event-bus.js";
import { ObservationPlatform } from "../kernel/observation.js";

const observation = ObservationPlatform.getInstance();

// Fixed sessionId every host-mic turn is dispatched under -- there is no
// browser session/login for this path (see this plan's spec), just one
// persistent connection Node opens to the daemon at boot. Reusing
// voice-session.ts's existing voice:transcript/voice:reply contract
// completely unchanged (it only requires sessionId+username to be
// non-empty strings, never checks a session registry) is what lets this
// module add zero new code to the turn-execution pipeline itself.
export const AMBIENT_SESSION_ID = "ambient-host";

const INITIAL_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 30000;

/**
 * Opens ONE persistent connection to the voice daemon, at boot -- not
 * per-browser-session like startAudioClient (src/core/audio-client.ts).
 * On the daemon's "ambient_transcript" message, publishes voice:transcript
 * under AMBIENT_SESSION_ID + defaultUsername, reusing voice-session.ts's
 * existing turn machinery completely unchanged. On the matching
 * voice:reply, sends "speak_local" back down the same connection so the
 * daemon synthesizes and plays the reply directly on the host speaker --
 * unlike startAudioClient's "speak", there is no audio_chunk stream-back
 * expected for this message type (see daemon/voice_engine.py's
 * _handle_speak_local).
 *
 * Deliberately a separate, small reconnect implementation rather than a
 * shared abstraction with startAudioClient -- the two differ enough
 * (fixed vs. per-caller sessionId, "speak_local" vs. "speak", no
 * sendAudioChunk/audio_chunk handling at all) that forcing one shared
 * function would need its own branching special-case, and this codebase
 * already tolerates near-duplicate connection-lifecycle code for exactly
 * this reason (transcribeOverSocket/synthesizeOverSocket in the same
 * file as startAudioClient).
 */
export function startAmbientDaemonClient(socketPath: string, defaultUsername: string): { stop: () => void } {
  const bus = EventBus.getInstance();
  let stopped = false;
  let socket: net.Socket | null = null;
  let rl: readline.Interface | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let backoffMs = INITIAL_RECONNECT_DELAY_MS;

  const unsubscribeReply = bus.subscribe("voice:reply", (payload: any) => {
    if (stopped || !socket || !socket.writable || payload.sessionId !== AMBIENT_SESSION_ID) return;
    socket.write(JSON.stringify({ type: "speak_local", text: payload.text }) + "\n");
  });

  const scheduleReconnect = () => {
    if (stopped) return;
    const delay = backoffMs;
    backoffMs = Math.min(backoffMs * 2, MAX_RECONNECT_DELAY_MS);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
    reconnectTimer.unref();
  };

  const connect = () => {
    if (stopped) return;
    if (!defaultUsername) {
      observation.logTelemetry(
        "warn",
        "AmbientDaemonClient",
        "AMBIENT_DEFAULT_USERNAME is not set -- ambient host-mic listening will connect but every wake-word turn will be dropped by voice-session.ts's own missing-username guard."
      );
    }

    let errorReported = false;
    const newSocket = net.createConnection({ path: socketPath });
    socket = newSocket;

    const newRl = readline.createInterface({ input: newSocket });
    rl = newRl;
    newRl.on("error", () => {});
    newRl.on("line", (line) => {
      if (!line.trim()) return;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        observation.logTelemetry("warn", "AmbientDaemonClient", `Malformed line from voice daemon, ignoring: ${line.slice(0, 200)}`);
        return;
      }
      if (msg.type === "ambient_transcript" && defaultUsername) {
        bus.publish("voice:transcript", { text: msg.text, sessionId: AMBIENT_SESSION_ID, username: defaultUsername });
      }
      // "speak_local_done" carries no state this module needs to react to
      // -- the daemon's own AmbientListener.turn_complete() (Task 3) is
      // what actually re-arms wake-word detection, triggered daemon-side
      // once it writes that message, not by anything Node does with it.
    });

    newSocket.on("connect", () => {
      backoffMs = INITIAL_RECONNECT_DELAY_MS;
      // Identifies this connection to the daemon as THE ambient one (see
      // daemon/voice_engine.py's "hello_ambient" dispatch case, Task 3) --
      // without this, the daemon has no way to know which of its several
      // simultaneous connections (per-session ones, one-shot
      // transcribe/synthesize ones, and this one) should receive
      // ambient_transcript pushes.
      newSocket.write(JSON.stringify({ type: "hello_ambient" }) + "\n");
    });

    newSocket.on("error", (err: any) => {
      if (stopped || errorReported) return;
      errorReported = true;
      observation.logTelemetry("warn", "AmbientDaemonClient", `Voice daemon socket error: ${err.message || err}`);
    });

    newSocket.on("close", () => {
      newRl.close();
      if (stopped) return;
      scheduleReconnect();
    });
  };

  connect();

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
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsc --noEmit && npm test 2>&1 | grep AmbientDaemonClient`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/ambient-daemon-client.ts tests/index.test.ts
git commit -m "feat: add the persistent Node<->daemon ambient connection module"
```

---

### Task 5: Node — wire into `server.ts`, remove the browser-ambient WS/route/capability plumbing

**Files:**
- Modify: `src/server.ts`
- Modify: `src/kernel/security.ts`
- Delete: `src/interaction/voice-stream-ws.ts`
- Modify: `tests/index.test.ts` (remove the `VoiceStreamWs` category, add a boot-smoke-test)

**Interfaces:**
- Consumes: `startAmbientDaemonClient` from Task 4.
- Produces: nothing new for later tasks — this is the final wiring task for the Node side.

- [ ] **Step 1: Remove the browser-ambient WS/ticket plumbing from `src/server.ts`**

Remove the import (line 71): `import { handleVoiceStreamConnection } from "./interaction/voice-stream-ws.js";`

Remove the module-level declaration (line 79): `let voiceStreamWss: WebSocketServer | undefined;`

Remove the ticket helpers and route (the `VOICE_STREAM_TICKET_TTL_MS`/`voiceStreamTickets`/`issueVoiceStreamTicket`/`consumeVoiceStreamTicket` block and the `app.post("/api/voice-stream-ticket", ...)` route immediately below it — everything currently at lines 1430-1454).

Remove the `voiceStreamWss` construction and its `"connection"` handler (currently lines 1554-1580, the `DEFAULT_VOICE_DAEMON_SOCKET`/`voiceStreamWss = new WebSocketServer(...)`/`voiceStreamWss.on("connection", ...)` block) — but **keep** the `DEFAULT_VOICE_DAEMON_SOCKET` constant itself, renamed and moved to where the new ambient client needs it (see Step 2 below).

Remove the `/ws/voice-stream` branch from the `httpServer.on("upgrade", ...)` handler, leaving only the `/ws/events` branch and the `else { socket.destroy(); }` fallback:

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
    } else {
      socket.destroy();
    }
  });
```

Remove the `voiceStreamWss` cleanup block from `gracefulShutdown` (the `if (voiceStreamWss) { ... }` block currently at lines 1683-1691), leaving `eventsWss`'s cleanup untouched.

- [ ] **Step 2: Start/stop the new ambient client at boot/shutdown**

Add the import, alongside the existing `startVoiceSession` import:

```typescript
import { startAmbientDaemonClient } from "./core/ambient-daemon-client.js";
```

Add a module-level holder, alongside `let voiceSession: ...`:

```typescript
let ambientDaemonClient: { stop: () => void } | undefined;
```

Replace the removed `DEFAULT_VOICE_DAEMON_SOCKET` constant's old use with this, placed right after the existing `voiceSession = startVoiceSession();` line:

```typescript
  // One persistent connection to the daemon for the host-mic ambient path
  // (see docs/superpowers/specs/2026-08-16-host-mic-ambient-voice-design.md)
  // -- distinct from voiceSession above, which only subscribes to
  // voice:transcript; this is what actually PRODUCES an ambient_transcript
  // in the first place, wired to a fixed configured account rather than a
  // browser login. AMBIENT_DEFAULT_USERNAME unset means ambient listening
  // simply never dispatches a turn (see ambient-daemon-client.ts's own
  // warning) -- not a startup failure, since a host with no ambient mic
  // configured yet is a completely normal, supported state.
  ambientDaemonClient = startAmbientDaemonClient(
    process.env.VOICE_DAEMON_SOCKET || "/tmp/jarvis-voice/voice.sock",
    process.env.AMBIENT_DEFAULT_USERNAME || ""
  );
```

Add its shutdown alongside `voiceSession?.stop?.();` inside `gracefulShutdown`:

```typescript
    ambientDaemonClient?.stop?.();
```

- [ ] **Step 3: Remove `voice.ambient` from `src/kernel/security.ts`**

Remove the `"voice.ambient",` line (and its explanatory comment block above it) from `ALL_CAPABILITIES`, and remove the `"voice.ambient",` line from `DEFAULT_PERSONAL_CAPABILITIES`. Update the comment at the personal-backfill call site that currently reads `(e.g. voice.ambient, added after they registered)` to a generic example that doesn't reference a now-removed capability:

```typescript
  // Backfill any DEFAULT_PERSONAL_CAPABILITIES capability a registered
  // personal user is missing (e.g. a capability added to this list after
  // they registered) -- mirrors the admin backfill above exactly, just
```

- [ ] **Step 4: Delete `src/interaction/voice-stream-ws.ts`**

```bash
rm src/interaction/voice-stream-ws.ts
```

- [ ] **Step 5: Remove the `VoiceStreamWs` test category and add a removal-confirming boot smoke test**

In `tests/index.test.ts`, delete the entire `// ---------- VoiceStreamWs Tests ----------` block (both `registerTest("VoiceStreamWs", ...)` calls, currently lines 6233-6385, up to but not including the `// ---------- OpenWakeWordEngine Tests ----------` comment — Task 6 removes that block separately).

In its place, following this codebase's existing convention for documenting a removed feature in-line (see the `"WS /ws/voice still works..."` comment currently near line 4715), add:

```typescript
// The "VoiceStreamWs" test category that used to live here was removed
// along with src/interaction/voice-stream-ws.ts itself: the browser-based
// ambient wake-word path (PR #154 and its predecessor) is gone entirely,
// replaced by the host-mic ambient listener
// (docs/superpowers/specs/2026-08-16-host-mic-ambient-voice-design.md).
// Its real successor coverage is the "AmbientDaemonClient" category
// (tests/index.test.ts) plus daemon/tests/test_ambient_listener.py and
// daemon/tests/test_voice_engine.py's speak_local test -- there is no
// browser-facing WS route left to test here at all.

registerTest("HTTP Boundary", "/ws/voice-stream and /api/voice-stream-ticket no longer exist", async () => {
  const port = 3021;
  const child = await spawnTestServer(port, { INTERNAL_API_KEY: TEST_ADMIN_API_KEY });
  try {
    const ticketRes = await fetch(`http://127.0.0.1:${port}/api/voice-stream-ticket`, {
      method: "POST",
      headers: { "X-API-Key": TEST_ADMIN_API_KEY },
    });
    if (ticketRes.status !== 404) {
      throw new Error(`Expected /api/voice-stream-ticket to be gone (404), got ${ticketRes.status}`);
    }

    const WebSocketCtor = (await import("ws")).default;
    const ws = new WebSocketCtor(`ws://127.0.0.1:${port}/ws/voice-stream?ticket=anything`);
    const closedCleanly = await new Promise<boolean>((resolve) => {
      ws.on("open", () => resolve(false)); // should never open
      ws.on("close", () => resolve(true));
      ws.on("error", () => resolve(true));
    });
    if (!closedCleanly) {
      throw new Error("Expected /ws/voice-stream to be gone -- the shared upgrade dispatcher should reject/destroy it, not accept a connection");
    }
  } finally {
    await stopTestServer(child);
  }
});
```

- [ ] **Step 6: Run tsc, then the full test suite**

Run: `npx tsc --noEmit`
Expected: clean (confirms every removed import/symbol is actually gone with no dangling reference).

Run: `npm test 2>&1 | tail -40`
Expected: the new `HTTP Boundary` test passes; no test still referencing `VoiceStreamWs`/`voice-stream-ws.js`/`voice.ambient` remains; the same pre-existing environment-only failure baseline as before (no new failures).

- [ ] **Step 7: Commit**

```bash
git add src/server.ts src/kernel/security.ts tests/index.test.ts
git rm src/interaction/voice-stream-ws.ts
git commit -m "refactor: remove the browser-ambient WS/ticket/capability plumbing, wire in the host-mic ambient client"
```

---

### Task 6: Remove the browser wake-word engine (files, UI, CSP, tests)

**Files:**
- Delete: `src/interaction/static/openwakeword-engine.js`, `src/interaction/static/wake-word.js`
- Delete: `src/interaction/static/vendor/openwakeword/`, `src/interaction/static/vendor/onnxruntime-web/`
- Modify: `src/interaction/static/index.html`
- Modify: `src/server.ts` (CSP comment/directive)
- Modify: `tests/index.test.ts` (remove `OpenWakeWordEngine` category)

**Interfaces:**
- Consumes: nothing (pure removal task).
- Produces: nothing (final task in this plan).

- [ ] **Step 1: Delete the engine files and vendor directories**

```bash
rm src/interaction/static/openwakeword-engine.js
rm src/interaction/static/wake-word.js
rm -rf src/interaction/static/vendor/openwakeword
rm -rf src/interaction/static/vendor/onnxruntime-web
```

- [ ] **Step 2: Remove the ambient toggle button, script tags, and toggle function from `index.html`**

Remove the button block (currently lines 712-721 — the `<button onclick="toggleAmbientListening()" ...>` through its closing `</button>`), leaving the mic-toggle button (lines 706-711) and the waveform-bars div (currently line 722 onward) untouched and adjacent.

Remove the script tags and toggle function (currently lines 5402-5443 — the `<!-- Classic (non-module) UMD bundle -->` comment through the closing `</script>` of `toggleAmbientListening`), leaving the preceding `<script>...console.log("🧠 Jarvis OS Web Console compiled successfully.");</script>` block and the trailing `</body>` exactly as they are, now adjacent.

- [ ] **Step 3: Revert the CSP in `src/server.ts` — WASM is no longer needed at all**

Replace the `scriptSrc` line and its preceding comment block (currently the `// 'wasm-unsafe-eval' is required...` comment through the `scriptSrc: [...]` line) with:

```typescript
      scriptSrc: ["'self'", "'unsafe-inline'", "https://unpkg.com"],
```

(No comment needed above it — `'unsafe-inline'`/`https://unpkg.com` are already explained by the broader comment above the whole `app.use(helmet(...))` block; the WASM-specific justification no longer applies to anything in this codebase once the browser wake-word engine is gone.)

- [ ] **Step 4: Remove the `OpenWakeWordEngine` test category**

In `tests/index.test.ts`, delete the entire `// ---------- OpenWakeWordEngine Tests ----------` block (its leading comment plus all 6 `registerTest("OpenWakeWordEngine", ...)` calls, currently lines 6386-568, ending right before `// ---------- HealthWatchdog Tests ----------`).

In its place, add:

```typescript
// The "OpenWakeWordEngine" test category that used to live here was
// removed along with src/interaction/static/openwakeword-engine.js and
// wake-word.js themselves: wake-word detection now runs server-side (see
// daemon/ambient_listener.py and daemon/tests/test_ambient_listener.py),
// not in the browser. There is no browser-side wake-word pipeline left to
// test here at all.
```

- [ ] **Step 5: Run tsc, then the full test suite**

Run: `npx tsc --noEmit`
Expected: clean.

Run: `npm test 2>&1 | tail -40`
Expected: no test references any deleted file; same pre-existing environment-only failure baseline, no new failures; total test count reflects the 6 removed `OpenWakeWordEngine` tests + 2 removed `VoiceStreamWs` tests (Task 5) balanced against the 2 new `AmbientDaemonClient`/`HTTP Boundary` tests and the daemon-side additions (daemon tests run separately via pytest, not counted in this total).

- [ ] **Step 6: Commit**

```bash
git rm src/interaction/static/openwakeword-engine.js src/interaction/static/wake-word.js
git rm -r src/interaction/static/vendor/openwakeword src/interaction/static/vendor/onnxruntime-web
git add src/interaction/static/index.html src/server.ts tests/index.test.ts
git commit -m "refactor: remove the browser-based wake-word engine and its UI, superseded by host-mic ambient listening"
```
