# Voice Engine Async Queueing & Event Loop Protection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the voice daemon's blind `asyncio.Semaphore(1)` (which makes a second concurrent voice request wait with zero feedback) with an explicit async queue that reports queue position immediately, and close a real, previously-unaudited event-loop-blocking bug in the Python gateway's request-proxying path.

**Architecture:** `daemon/voice_engine.py` currently serializes every STT/TTS inference call behind `_inference_lock = asyncio.Semaphore(1)` (line 78) — correct for correctness (neither model is verified safe for concurrent calls) but silent: a queued caller gets no signal until its turn comes. Fix: replace the semaphore with a single-worker `asyncio.Queue`-backed job queue that reports `{"type": "queued", "position": N}` back over the same Unix-socket connection the instant a job can't start immediately, preserving the exact same one-job-at-a-time serialization guarantee. Separately, `src/api.py`'s four async route handlers (`health_check`, `props_check`, `chat_proxy`, `wildcard_api_proxy`) each call `is_node_running()` — a blocking `socket.connect_ex` with up to a 0.5s timeout (`src/api.py:59-66`) — directly on the event loop, unwrapped by `asyncio.to_thread`, unlike every other blocking call in this file (which already learned this lesson: see the `asyncio.to_thread` wrapping around `make_proxy_request`/`proxy_streaming_request` at lines 419, 458, 518, and the live-caught-bug comment at lines 412-419). Fix: wrap those four call sites the same way.

**Tech Stack:** Python asyncio (`daemon/voice_engine.py`, `src/api.py`), the daemon's existing no-pytest-asyncio test convention (`daemon/tests/test_voice_engine.py`, plain `def test_...()` functions driving `asyncio.run()` internally), TypeScript/`ws` (`src/core/audio-client.ts`, `src/server.ts`'s `/ws/events` bridge).

## Global Constraints

- No new Python dependencies. `daemon/requirements.txt` already has `pytest>=8.0.0`; the existing daemon test suite deliberately avoids `pytest-asyncio` (see `daemon/tests/test_voice_engine.py`'s file-level docstring) — new tests in this plan follow the same plain-function-plus-`asyncio.run()` pattern.
- The queue must preserve the existing serialization guarantee exactly: **one** STT/TTS inference call in flight at a time, system-wide, across every connection. This plan changes *how waiting is communicated*, not the underlying one-at-a-time constraint (still correct per `daemon/voice_engine.py:65-77`'s reasoning about model thread-safety and CPU contention).
- `is_node_running()` itself (`src/api.py:59-66`) is not modified — only its four call sites inside `async def` handlers change, to route through `asyncio.to_thread`. Its two call sites inside `supervise_node_server()` (`src/api.py:103, 145`) are already correct as-is (that function runs in a background OS thread, not the event loop) and must not be changed.

---

### Task 1: Replace the STT/TTS semaphore with a position-reporting async queue

**Files:**
- Modify: `daemon/voice_engine.py:58-78` (module-scope state), `:100-121` (`_run_transcription`), `:236-251` (`_handle_speak`), `:320-335` (`main`)
- Test: `daemon/tests/test_voice_engine.py` (new test functions, appended after the existing test)

**Interfaces:**
- Consumes: `_stt.transcribe(pcm_bytes: bytes) -> str` and `_tts.synthesize(text: str) -> bytes` (`daemon/models.py:54, 82` — unchanged), `_write_message(writer, message: dict) -> None` (`daemon/voice_engine.py:95-97` — unchanged).
- Produces: a module-level `_inference_queue: InferenceQueue` instance; `InferenceQueue.start()` (call once, from a running event loop); `InferenceQueue.submit(fn, *args) -> tuple[asyncio.Future, int]` (returns the future to await for the result, and the caller's 0-indexed queue position *at the moment of submission* — `0` means "starts immediately, nothing ahead of it"). A new outbound message type on the wire: `{"type": "queued", "position": N}`, written only when `position > 0`.

- [ ] **Step 1: Write the failing test**

Append to `daemon/tests/test_voice_engine.py`, after the existing test function (following the same `_run`/`_make_pcm` helpers already defined at the top of the file):

```python
def test_second_concurrent_transcription_gets_a_queued_message_with_its_position():
    # Regression test for the fix replacing _inference_lock (a plain
    # semaphore -- silent waiting, no feedback) with InferenceQueue: a
    # second connection's transcribe request, submitted while the first is
    # still "in flight", must get an immediate {"type": "queued",
    # "position": 1} message on ITS OWN connection before the first
    # connection's slow transcribe() call ever returns.
    import threading

    release_first_call = threading.Event()
    call_order = []

    def slow_transcribe(pcm_bytes: bytes) -> str:
        call_order.append("first-call-started")
        release_first_call.wait(timeout=5)
        return "first-transcript"

    def fast_transcribe(pcm_bytes: bytes) -> str:
        call_order.append("second-call-started")
        return "second-transcript"

    async def scenario():
        sock_path = tempfile.mktemp(suffix=".sock")
        server = await asyncio.start_unix_server(voice_engine.handle_connection, path=sock_path)
        try:
            async with server:
                asyncio.ensure_future(server.serve_forever())

                # First connection: sends audio_data + transcribe, but its
                # transcribe() call blocks on release_first_call until this
                # test explicitly frees it below.
                voice_engine._stt.transcribe = slow_transcribe
                reader1, writer1 = await asyncio.open_unix_connection(sock_path)
                speech_chunk = _make_pcm(2000)
                writer1.write((json.dumps({
                    "type": "audio_data",
                    "data": base64.b64encode(speech_chunk).decode(),
                }) + "\n").encode())
                writer1.write((json.dumps({"type": "transcribe"}) + "\n").encode())
                await writer1.drain()

                # Give the first call a moment to actually start (and grab
                # the queue) before the second connection submits.
                deadline = asyncio.get_event_loop().time() + 5
                while "first-call-started" not in call_order and asyncio.get_event_loop().time() < deadline:
                    await asyncio.sleep(0.05)
                assert "first-call-started" in call_order, "first transcribe() never started"

                # Second connection: submitted while the first is still
                # in flight -- must get a "queued" message with position 1
                # immediately, well before release_first_call is ever set.
                voice_engine._stt.transcribe = fast_transcribe
                reader2, writer2 = await asyncio.open_unix_connection(sock_path)
                writer2.write((json.dumps({
                    "type": "audio_data",
                    "data": base64.b64encode(speech_chunk).decode(),
                }) + "\n").encode())
                writer2.write((json.dumps({"type": "transcribe"}) + "\n").encode())
                await writer2.drain()

                queued_line = await asyncio.wait_for(reader2.readline(), timeout=5)
                queued_msg = json.loads(queued_line.decode())
                assert queued_msg == {"type": "queued", "position": 1}, (
                    f"expected an immediate queued/position-1 message on the second "
                    f"connection, got: {queued_msg!r}"
                )
                # The second call must not have started yet -- proves the queue
                # actually serialized it behind the first, not just reported a
                # position while running both concurrently.
                assert "second-call-started" not in call_order

                release_first_call.set()

                line1 = await asyncio.wait_for(reader1.readline(), timeout=5)
                assert json.loads(line1.decode()) == {"type": "transcript", "text": "first-transcript"}

                line2 = await asyncio.wait_for(reader2.readline(), timeout=5)
                assert json.loads(line2.decode()) == {"type": "transcript", "text": "second-transcript"}

                assert call_order == ["first-call-started", "second-call-started"]

                writer1.close()
                writer2.close()
        finally:
            server.close()

    _run(scenario())
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from `daemon/`, with its venv active): `pytest tests/test_voice_engine.py -k test_second_concurrent_transcription -v`
Expected: FAIL — either an `AttributeError`/`AssertionError` on the `{"type": "queued", ...}` assertion (today's code never writes that message type at all; the second connection just blocks silently until the semaphore frees up), or the test hangs until its own 5s timeout and fails there.

- [ ] **Step 3: Implement `InferenceQueue`**

In `daemon/voice_engine.py`, replace the `_inference_lock` definition and its surrounding comment (lines 65-78):

```python
# Model instances are constructed once per daemon process and shared across
# connections -- constructing them is cheap (lazy-loads real weights on
# first real transcribe/synthesize call, per models.py), but loading real
# weights per-connection would be wasteful and slow.
_stt = SpeechToText()
_tts = TextToSpeech()

# Serializes every real model-inference call (STT transcribe + TTS
# synthesize) across ALL connections -- the long-lived streaming connection
# from startAudioClient, plus any number of concurrent one-shot
# transcribeOverSocket/synthesizeOverSocket connections, all share the same
# _stt/_tts instances above. Each inference call runs via asyncio.to_thread,
# so without this, multiple connections could genuinely run inference
# concurrently on separate worker threads -- neither faster-whisper's
# WhisperModel (default num_workers=1) nor Kokoro's KPipeline (which caches
# internal per-voice state on first use) is verified safe for concurrent
# calls, and this is a CPU-only box where concurrent inference would also
# just oversubscribe the CPU and degrade latency for everyone. Acquired
# right before the asyncio.to_thread(...) call and released immediately
# after, never held across unrelated socket I/O.
_inference_lock = asyncio.Semaphore(1)
```

with:

```python
# Model instances are constructed once per daemon process and shared across
# connections -- constructing them is cheap (lazy-loads real weights on
# first real transcribe/synthesize call, per models.py), but loading real
# weights per-connection would be wasteful and slow.
_stt = SpeechToText()
_tts = TextToSpeech()


class InferenceQueue:
    """Single-worker job queue that replaces a plain asyncio.Semaphore(1)
    around every real model-inference call (STT transcribe + TTS
    synthesize). Preserves the exact same guarantee the semaphore gave --
    one inference call in flight at a time, system-wide, across every
    connection (see the removed _inference_lock's comment for why: neither
    faster-whisper's WhisperModel nor Kokoro's KPipeline is verified safe
    for concurrent calls, and this is a CPU-only box). What changes is
    *how waiting is communicated*: a semaphore blocks a second caller
    silently; this queue reports the caller's position the instant it's
    submitted, before the earlier job(s) ahead of it finish.
    """

    def __init__(self) -> None:
        self._queue: asyncio.Queue = asyncio.Queue()
        self._worker_task: asyncio.Task | None = None

    def start(self) -> None:
        """Must be called once, from inside a running event loop (main(),
        below) -- asyncio.create_task requires one, unlike the Queue/lock
        constructors above, which don't."""
        self._worker_task = asyncio.create_task(self._worker())

    async def _worker(self) -> None:
        while True:
            fn, args, future = await self._queue.get()
            try:
                result = await asyncio.to_thread(fn, *args)
                if not future.cancelled():
                    future.set_result(result)
            except Exception as exc:  # noqa: BLE001 -- propagated to the caller via the future, not swallowed
                if not future.cancelled():
                    future.set_exception(exc)
            finally:
                self._queue.task_done()

    async def submit(self, fn, *args) -> tuple[asyncio.Future, int]:
        """Returns (future, position). position is 0 if this job starts
        immediately (nothing else queued/running ahead of it), or the
        number of jobs already queued ahead of it otherwise. Read
        self._queue.qsize() BEFORE put() -- after put(), this job would
        count itself."""
        position = self._queue.qsize()
        future = asyncio.get_running_loop().create_future()
        await self._queue.put((fn, args, future))
        return future, position


_inference_queue = InferenceQueue()
```

- [ ] **Step 4: Wire `_run_transcription` through the queue**

In `daemon/voice_engine.py`, replace `_run_transcription` (lines 100-121):

```python
async def _run_transcription(writer: asyncio.StreamWriter, pcm_for_utterance: bytes, peer: str) -> None:
    if not pcm_for_utterance:
        # Nothing was ever buffered (e.g. a "transcribe" request with no
        # preceding audio_chunk) -- skip the model call entirely rather
        # than feeding faster-whisper an empty array.
        await _write_message(writer, {"type": "transcript", "text": ""})
        return
    try:
        # STT inference is slow (tens of seconds on CPU, per Task 2's live
        # verification) and synchronous -- run it off the event loop so a
        # single transcription doesn't block every other connection
        # (including the accept loop for brand-new ones) for its duration.
        # _inference_lock (see its definition above) serializes this against
        # every other connection's STT/TTS calls -- held only around the
        # actual inference call, not the socket I/O before/after it.
        async with _inference_lock:
            transcript = await asyncio.to_thread(_stt.transcribe, pcm_for_utterance)
    except Exception:
        log.exception(f"STT transcription failed for {peer}")
        return
    await _write_message(writer, {"type": "transcript", "text": transcript})
```

with:

```python
async def _run_transcription(writer: asyncio.StreamWriter, pcm_for_utterance: bytes, peer: str) -> None:
    if not pcm_for_utterance:
        # Nothing was ever buffered (e.g. a "transcribe" request with no
        # preceding audio_chunk) -- skip the model call entirely rather
        # than feeding faster-whisper an empty array.
        await _write_message(writer, {"type": "transcript", "text": ""})
        return
    # STT inference is slow (tens of seconds on CPU, per Task 2's live
    # verification) and synchronous -- _inference_queue's worker runs it off
    # the event loop via asyncio.to_thread, and serializes it against every
    # other connection's STT/TTS calls (see InferenceQueue's own docstring).
    # Unlike the plain semaphore this replaced, a caller behind an
    # in-flight job is told its position immediately instead of just
    # blocking silently.
    future, position = await _inference_queue.submit(_stt.transcribe, pcm_for_utterance)
    if position > 0:
        await _write_message(writer, {"type": "queued", "position": position})
    try:
        transcript = await future
    except Exception:
        log.exception(f"STT transcription failed for {peer}")
        return
    await _write_message(writer, {"type": "transcript", "text": transcript})
```

- [ ] **Step 5: Wire `_handle_speak` through the queue**

In `daemon/voice_engine.py`, replace `_handle_speak` (lines 236-251):

```python
async def _handle_speak(writer: asyncio.StreamWriter, msg: dict, peer: str) -> None:
    text = msg.get("text", "")
    try:
        # Same reasoning as the STT call in _run_transcription: TTS
        # inference is slow and synchronous, so it must not run directly
        # on the event loop, and _inference_lock serializes it against
        # every other connection's STT/TTS calls.
        async with _inference_lock:
            audio_bytes = await asyncio.to_thread(_tts.synthesize, text)
    except Exception:
        log.exception(f"TTS synthesis failed for {peer}")
        return
    for i in range(0, len(audio_bytes), SPEAK_CHUNK_BYTES):
        chunk = audio_bytes[i : i + SPEAK_CHUNK_BYTES]
        await _write_message(writer, {"type": "audio_chunk", "data": encode_audio_chunk(chunk)})
    await _write_message(writer, {"type": "speak_done"})
```

with:

```python
async def _handle_speak(writer: asyncio.StreamWriter, msg: dict, peer: str) -> None:
    text = msg.get("text", "")
    # Same reasoning as the STT call in _run_transcription: TTS inference is
    # slow and synchronous, so it must not run directly on the event loop,
    # and _inference_queue serializes it against every other connection's
    # STT/TTS calls.
    future, position = await _inference_queue.submit(_tts.synthesize, text)
    if position > 0:
        await _write_message(writer, {"type": "queued", "position": position})
    try:
        audio_bytes = await future
    except Exception:
        log.exception(f"TTS synthesis failed for {peer}")
        return
    for i in range(0, len(audio_bytes), SPEAK_CHUNK_BYTES):
        chunk = audio_bytes[i : i + SPEAK_CHUNK_BYTES]
        await _write_message(writer, {"type": "audio_chunk", "data": encode_audio_chunk(chunk)})
    await _write_message(writer, {"type": "speak_done"})
```

- [ ] **Step 6: Start the queue's worker from `main()`**

In `daemon/voice_engine.py`, in `main()` (lines 320-335), replace:

```python
async def main() -> None:
    server = await asyncio.start_unix_server(handle_connection, path=SOCKET_PATH)
```

with:

```python
async def main() -> None:
    # Must start from inside this running event loop -- InferenceQueue.start()
    # calls asyncio.create_task, which requires one (unlike the plain
    # Semaphore/Queue construction this replaced, which didn't).
    _inference_queue.start()
    server = await asyncio.start_unix_server(handle_connection, path=SOCKET_PATH)
```

- [ ] **Step 7: Start the worker in the test scenario too**

The test written in Step 1 calls `voice_engine.handle_connection` directly via `asyncio.start_unix_server`, bypassing `main()` (matching the existing test file's convention — see the pre-existing test's `scenario()`). Since `main()` is what now calls `_inference_queue.start()`, add the same call at the top of the new test's `scenario()` function, before `asyncio.start_unix_server(...)`:

```python
    async def scenario():
        sock_path = tempfile.mktemp(suffix=".sock")
        voice_engine._inference_queue.start()
        server = await asyncio.start_unix_server(voice_engine.handle_connection, path=sock_path)
```

(Insert `voice_engine._inference_queue.start()` as the first line inside `scenario()`, before the `sock_path`/`server` lines already there.)

- [ ] **Step 8: Run the test to verify it passes**

Run: `pytest tests/test_voice_engine.py -v`
Expected: PASS — both the new test and the pre-existing `test_audio_data_plus_transcribe_returns_the_full_clip_despite_a_long_silent_stretch` pass.

- [ ] **Step 9: Commit**

```bash
git add daemon/voice_engine.py daemon/tests/test_voice_engine.py
git commit -m "feat: replace voice daemon's inference semaphore with a position-reporting async queue"
```

---

### Task 2: Forward `queued` status to the browser over the existing `/ws/events` WebSocket

**Files:**
- Modify: `src/core/audio-client.ts:109-128` (the `newRl.on("line", ...)` handler in `startAudioClient`)
- Modify: `src/server.ts:1421` (the `/ws/events` topic-forwarding allowlist)

**Interfaces:**
- Consumes: `EventBus.getInstance().publish(topic, payload)` (`src/core/event-bus.ts:39-49`, unchanged), the daemon's new `{"type": "queued", "position": N}` wire message (Task 1).
- Produces: a new bus topic `"voice:queued"` with payload `{ position: number }`, published from `startAudioClient`'s line handler; added to `/ws/events`'s forwarded-topic allowlist so browser clients connected there receive `{"type": "event", "topic": "voice:queued", "payload": {"position": N}}`.

- [ ] **Step 1: Recognize the new message type in `audio-client.ts`**

In `src/core/audio-client.ts`, in `startAudioClient`'s `newRl.on("line", ...)` handler (lines 109-128), replace:

```typescript
      if (msg.type === "transcript") {
        bus.publish("voice:transcript", { text: msg.text });
      } else if (msg.type === "audio_chunk") {
        bus.publish("voice:audio-chunk", { data: msg.data });
      }
```

with:

```typescript
      if (msg.type === "transcript") {
        bus.publish("voice:transcript", { text: msg.text });
      } else if (msg.type === "audio_chunk") {
        bus.publish("voice:audio-chunk", { data: msg.data });
      } else if (msg.type === "queued") {
        bus.publish("voice:queued", { position: msg.position });
      }
```

- [ ] **Step 2: Forward the new topic over `/ws/events`**

In `src/server.ts`, in the `/ws/events` connection handler, replace the topic list (line 1421):

```typescript
    for (const topic of ["filesystem:changed", "system:anomaly"]) {
```

with:

```typescript
    for (const topic of ["filesystem:changed", "system:anomaly", "voice:queued"]) {
```

- [ ] **Step 3: Manual verification**

This wiring has no existing browser-facing voice UI to assert against in the automated test suite (per `src/server.ts:1486-1496`'s own comment, the voice pipeline "doesn't need an HTTP/WebSocket route" today — this task adds the first one). Verify by hand:

Run: `npm run dev` (starts the server with `tsx watch`), then in a second terminal, connect to `/ws/events` with a valid ticket or `X-API-Key` header (see `src/server.ts:1298-1399` for ticket issuance via `POST /api/events-ticket`) using any WebSocket client (e.g. `wscat -c "ws://127.0.0.1:3000/ws/events?ticket=<ticket>"`).
Expected: with the voice daemon running and a second concurrent voice request submitted while a first is in flight, the WebSocket client receives `{"type":"event","topic":"voice:queued","payload":{"position":1}}`.

- [ ] **Step 4: Commit**

```bash
git add src/core/audio-client.ts src/server.ts
git commit -m "feat: forward voice-queue position to browser clients over /ws/events"
```

---

### Task 3: Offload the remaining blocking call in `src/api.py`'s async handlers

**Files:**
- Modify: `src/api.py:410, 456, 471, 511` (four call sites of `is_node_running()`)
- Test: new file `tests/test_api_gateway.py` (repo root, alongside `requirements.txt`)
- Modify: `requirements.txt` (add `pytest`, `httpx` as test-only additions)

**Interfaces:**
- Consumes: `is_node_running() -> bool` (`src/api.py:59-66`, unchanged — only its call sites move), FastAPI's `app` instance (`src/api.py`, module scope).
- Produces: nothing new exported — this task only changes how four existing call sites invoke an existing function.

**Context:** `make_proxy_request` and `proxy_streaming_request`'s own blocking I/O is already correctly wrapped in `asyncio.to_thread` at every call site (verified: `src/api.py:419, 458, 518` wrap `make_proxy_request`; `proxy_streaming_request` is itself `async def` and wraps its own internal `urllib` calls at lines 322, 326, 331, 348, 349, 353). The one gap: `is_node_running()` — a blocking `socket.connect_ex` with up to a 0.5s timeout (`src/api.py:59-66`) — is called directly, unwrapped, inside four `async def` route handlers (`health_check` line 410, `props_check` line 456, `chat_proxy` line 471, `wildcard_api_proxy` line 511). Every one of these routes runs on every proxied request through the gateway, so this blocks the single event loop for up to 0.5s per request today.

- [ ] **Step 1: Add test dependencies**

In `requirements.txt`, add (it currently only lists `fastapi`, `uvicorn`, `requests`, `python-dotenv`):

```
pytest>=8.0.0
httpx>=0.27.0
```

`httpx` is required because FastAPI's `TestClient`/async test patterns need it as of Starlette's current test-client implementation, and it's not otherwise a dependency of this project.

- [ ] **Step 2: Write the failing test**

Create `tests/test_api_gateway.py`:

```python
"""
Regression coverage for src/api.py's async route handlers not blocking the
event loop. Plain asyncio.run()-driven tests, matching daemon/tests/
test_voice_engine.py's convention (no pytest-asyncio dependency) rather than
using anyio/pytest-asyncio markers, to keep this project's two Python test
suites consistent.
"""
import asyncio
import os
import sys
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

os.environ.setdefault("INTERNAL_API_KEY", "test-only-not-a-real-secret")

import api  # noqa: E402


def _run(coro):
    return asyncio.run(coro)


def test_is_node_running_is_offloaded_via_asyncio_to_thread_in_every_async_handler():
    # Regression test for a real, previously-unaudited gap: is_node_running()
    # does a blocking socket.connect_ex with up to a 0.5s timeout
    # (src/api.py:59-66), and was called directly -- not through
    # asyncio.to_thread, unlike every other blocking call in this file --
    # inside four async route handlers. This asserts asyncio.to_thread is
    # actually used to invoke it, for each of those four handlers, rather
    # than timing real socket calls (which would be slow and flaky).
    calls = []

    real_to_thread = asyncio.to_thread

    async def spying_to_thread(fn, *args, **kwargs):
        calls.append(fn)
        return await real_to_thread(fn, *args, **kwargs)

    class FakeRequest:
        headers = {}
        method = "GET"

        class url:
            path = "/some/path"
            query = ""

        async def body(self):
            return b""

    async def scenario():
        with patch("asyncio.to_thread", side_effect=spying_to_thread), \
             patch("api.is_node_running", return_value=False):
            # Node reported not running, so each handler takes its
            # fallback path -- this test only cares that is_node_running
            # itself was invoked via asyncio.to_thread before that check,
            # not about the fallback response content.
            await api.health_check(FakeRequest())
            await api.props_check(FakeRequest())
            await api.chat_proxy(FakeRequest())
            try:
                await api.wildcard_api_proxy("some/path", FakeRequest())
            except Exception:
                # wildcard_api_proxy's fallback branch may raise on an
                # unrecognized path in this minimal fake-request harness --
                # irrelevant to this test, which only asserts is_node_running
                # was called through asyncio.to_thread before that point.
                pass

    _run(scenario())

    assert calls.count(api.is_node_running) == 4, (
        f"expected is_node_running to be invoked via asyncio.to_thread exactly once per "
        f"handler (health_check, props_check, chat_proxy, wildcard_api_proxy), got "
        f"{calls.count(api.is_node_running)} such calls: {calls!r}"
    )
```

- [ ] **Step 3: Install test dependencies and run to verify it fails**

Run: `pip install -r requirements.txt` (repo root)
Run: `pytest tests/test_api_gateway.py -v`
Expected: FAIL — `assert calls.count(api.is_node_running) == 4` fails with `0` (today's code calls `is_node_running()` directly, never through the patched `asyncio.to_thread`, so the spy never records it).

- [ ] **Step 4: Wrap the four call sites**

In `src/api.py`, in `health_check` (line 410), replace:

```python
    if is_node_running():
        try:
            # make_proxy_request is a blocking urllib call — run it in a
            # worker thread so a slow/hung Express response (e.g. a 100+s
            # local LLM generation, the documented normal case for this
            # project) can't stall the single-worker asyncio event loop and
            # freeze every other concurrent request through this gateway.
            # Live-verified this was a real bug: a slow request in flight
            # made even /api/status hang indefinitely for everyone else.
            return await asyncio.to_thread(make_proxy_request, "/health", "GET", dict(request.headers))
```

with:

```python
    # is_node_running() itself is a blocking socket.connect_ex (up to a
    # 0.5s timeout, see its definition above) — every async handler in this
    # file calls it before deciding whether to proxy, so leaving it
    # unwrapped would block the event loop on every single request through
    # the gateway. asyncio.to_thread here matches how make_proxy_request's
    # own blocking I/O is already handled just below.
    if await asyncio.to_thread(is_node_running):
        try:
            # make_proxy_request is a blocking urllib call — run it in a
            # worker thread so a slow/hung Express response (e.g. a 100+s
            # local LLM generation, the documented normal case for this
            # project) can't stall the single-worker asyncio event loop and
            # freeze every other concurrent request through this gateway.
            # Live-verified this was a real bug: a slow request in flight
            # made even /api/status hang indefinitely for everyone else.
            return await asyncio.to_thread(make_proxy_request, "/health", "GET", dict(request.headers))
```

Apply the equivalent `if await asyncio.to_thread(is_node_running):` replacement (swapping just the `if is_node_running():` line, keeping each function's existing body otherwise unchanged) at the three remaining call sites:
- `props_check`, line 456
- `chat_proxy`, line 471
- `wildcard_api_proxy`, line 511

- [ ] **Step 5: Run the test to verify it passes**

Run: `pytest tests/test_api_gateway.py -v`
Expected: PASS.

- [ ] **Step 6: Run the full Python test suite to confirm no regression**

Run: `pytest tests/test_api_gateway.py daemon/tests/ -v`
Expected: all tests pass (daemon tests are unaffected by this task's changes — run together here only as a combined sanity check since both suites now exist).

- [ ] **Step 7: Commit**

```bash
git add src/api.py requirements.txt tests/test_api_gateway.py
git commit -m "fix: offload is_node_running()'s blocking socket check via asyncio.to_thread"
```
