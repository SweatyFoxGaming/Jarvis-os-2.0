"""
Dispatch-level regression tests for voice_engine.py's handle_connection.

Task 2's convention (see task-2-report.md) deliberately kept coverage of
handle_connection/_handle_audio_chunk/_handle_speak at the models.py/
protocol.py unit level only, since no pytest-asyncio dependency exists in
this project. These tests don't add that dependency either -- they use
plain `def test_...():` functions that drive a real asyncio event loop via
asyncio.run() internally, exactly like the throwaway live-check scripts
Task 2/7 used to manually verify wiring, just turned into committed,
repeatable regression tests. This is specifically for a real bug a live
check caught (a code-review round on Task 7): the one-shot "transcribe"
path was routing its audio through the same "audio_chunk" handler as the
continuous mic-stream flow, so a long silent stretch in a pre-recorded
clip could trip UtteranceEndDetector and hand back a truncated transcript
before the explicit "transcribe" message ever arrived. That's a dispatch-
level interaction (message type -> detector state -> transcript timing)
that no purely-unit-level test of protocol.py or models.py alone could
have caught.
"""
import asyncio
import base64
import json
import os
import sys
import tempfile

# voice_engine.py imports its sibling modules unqualified ("from protocol
# import ...", "from models import ..."), so it must be imported the same
# way its own real entrypoint is (python3 voice_engine.py from inside
# daemon/) -- with the daemon/ directory itself on sys.path, not just its
# parent. This mirrors the throwaway live-check scripts from Task 2/7.
_DAEMON_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _DAEMON_DIR not in sys.path:
    sys.path.insert(0, _DAEMON_DIR)

import voice_engine  # noqa: E402
from ambient_listener import AmbientListener, CHUNK_SAMPLES  # noqa: E402


def _run(coro):
    return asyncio.run(coro)


def _make_pcm(rms_level: int, num_samples: int = 4000) -> bytes:
    """A trivial int16 PCM buffer at a controlled amplitude -- rms_level
    above voice_engine.SILENCE_RMS_THRESHOLD counts as "speech" for
    UtteranceEndDetector purposes, at/near 0 counts as silence."""
    import numpy as np
    samples = np.full(num_samples, rms_level, dtype=np.int16)
    return samples.tobytes()


def test_audio_data_plus_transcribe_returns_the_full_clip_despite_a_long_silent_stretch(monkeypatch):
    # Regression test for the exact bug a code review round caught: sending
    # a pre-recorded clip as "audio_chunk" (rather than "audio_data") let a
    # long silent stretch trip UtteranceEndDetector's silence_frames_threshold
    # (15 by default) and produce a truncated transcript before the
    # explicit "transcribe" message even arrived. "audio_data" must never
    # trigger a transcript on its own, no matter how much silence it
    # contains -- only the explicit "transcribe" message may.
    captured_pcm_lengths = []

    def fake_transcribe(pcm_bytes: bytes) -> str:
        captured_pcm_lengths.append(len(pcm_bytes))
        return f"transcript-of-{len(pcm_bytes)}-bytes"

    monkeypatch.setattr(voice_engine._stt, "transcribe", fake_transcribe)

    async def scenario():
        sock_path = tempfile.mktemp(suffix=".sock")
        # Each test drives its own fresh asyncio event loop via _run()/
        # asyncio.run() -- asyncio.Queue (and the Condition/Future objects
        # it creates internally) binds to whichever loop is running the
        # first time it actually needs to wait, and raises/silently dies if
        # reused from a different loop afterwards. The module-level
        # _inference_queue singleton is fine in production (one process, one
        # asyncio.run(main()) for its whole life) but isn't safe to reuse
        # across these tests' separate event-loop lifetimes, so each
        # scenario gets its own fresh InferenceQueue bound only to its own
        # loop.
        voice_engine._inference_queue = voice_engine.InferenceQueue()
        voice_engine._inference_queue.start()
        server = await asyncio.start_unix_server(voice_engine.handle_connection, path=sock_path)
        try:
            async with server:
                asyncio.ensure_future(server.serve_forever())
                reader, writer = await asyncio.open_unix_connection(sock_path)
                try:
                    speech_chunk = _make_pcm(2000)  # well above SILENCE_RMS_THRESHOLD
                    silent_chunk = _make_pcm(0)     # well below it

                    writer.write((json.dumps({
                        "type": "audio_data",
                        "data": base64.b64encode(speech_chunk).decode(),
                    }) + "\n").encode())
                    # More consecutive silent audio_data messages than
                    # UtteranceEndDetector's default silence_frames_threshold
                    # (15) -- if these were routed through the detector
                    # (the bug), this alone would already have fired a
                    # (truncated) transcript.
                    for _ in range(20):
                        writer.write((json.dumps({
                            "type": "audio_data",
                            "data": base64.b64encode(silent_chunk).decode(),
                        }) + "\n").encode())
                    await writer.drain()

                    # Nothing should have been written back yet -- proves
                    # audio_data never triggers a response on its own.
                    try:
                        premature = await asyncio.wait_for(reader.readline(), timeout=0.3)
                    except asyncio.TimeoutError:
                        premature = b""
                    assert premature == b"", (
                        f"audio_data must never trigger a transcript on its own, got: {premature!r}"
                    )

                    writer.write((json.dumps({"type": "transcribe"}) + "\n").encode())
                    await writer.drain()

                    line = await asyncio.wait_for(reader.readline(), timeout=5)
                    msg = json.loads(line.decode())
                    assert msg["type"] == "transcript"

                    expected_len = len(speech_chunk) + 20 * len(silent_chunk)
                    assert captured_pcm_lengths == [expected_len], (
                        f"expected the FULL clip ({expected_len} bytes) transcribed in one call, "
                        f"got calls with lengths: {captured_pcm_lengths}"
                    )
                    assert msg["text"] == f"transcript-of-{expected_len}-bytes"
                finally:
                    writer.close()
        finally:
            if os.path.exists(sock_path):
                os.remove(sock_path)

    _run(scenario())


def test_audio_chunk_continuous_flow_still_auto_triggers_on_silence(monkeypatch):
    # Confirms the fix didn't break the *other* side: the continuous
    # mic-stream flow ("audio_chunk") must still auto-trigger a transcript
    # from sustained silence, with no explicit "transcribe" message at all.
    def fake_transcribe(pcm_bytes: bytes) -> str:
        return f"transcript-of-{len(pcm_bytes)}-bytes"

    monkeypatch.setattr(voice_engine._stt, "transcribe", fake_transcribe)

    async def scenario():
        sock_path = tempfile.mktemp(suffix=".sock")
        # Each test drives its own fresh asyncio event loop via _run()/
        # asyncio.run() -- asyncio.Queue (and the Condition/Future objects
        # it creates internally) binds to whichever loop is running the
        # first time it actually needs to wait, and raises/silently dies if
        # reused from a different loop afterwards. The module-level
        # _inference_queue singleton is fine in production (one process, one
        # asyncio.run(main()) for its whole life) but isn't safe to reuse
        # across these tests' separate event-loop lifetimes, so each
        # scenario gets its own fresh InferenceQueue bound only to its own
        # loop.
        voice_engine._inference_queue = voice_engine.InferenceQueue()
        voice_engine._inference_queue.start()
        server = await asyncio.start_unix_server(voice_engine.handle_connection, path=sock_path)
        try:
            async with server:
                asyncio.ensure_future(server.serve_forever())
                reader, writer = await asyncio.open_unix_connection(sock_path)
                try:
                    speech_chunk = _make_pcm(2000)
                    silent_chunk = _make_pcm(0)

                    writer.write((json.dumps({
                        "type": "audio_chunk",
                        "data": base64.b64encode(speech_chunk).decode(),
                    }) + "\n").encode())
                    for _ in range(15):  # default silence_frames_threshold
                        writer.write((json.dumps({
                            "type": "audio_chunk",
                            "data": base64.b64encode(silent_chunk).decode(),
                        }) + "\n").encode())
                    await writer.drain()

                    line = await asyncio.wait_for(reader.readline(), timeout=5)
                    msg = json.loads(line.decode())
                    assert msg["type"] == "transcript"
                    expected_len = len(speech_chunk) + 15 * len(silent_chunk)
                    assert msg["text"] == f"transcript-of-{expected_len}-bytes"
                finally:
                    writer.close()
        finally:
            if os.path.exists(sock_path):
                os.remove(sock_path)

    _run(scenario())


def test_audio_chunk_force_flushes_when_utterance_buffer_exceeds_the_cap(monkeypatch):
    # I8 regression test: a streaming connection whose silence detector
    # never fires (e.g. continuous "speech"-level noise, or a misbehaving
    # source) must not grow utterance_buffer unbounded. Sending only
    # "speech"-level audio_chunk messages (never silence, so
    # UtteranceEndDetector.feed() never naturally returns True) past
    # MAX_UTTERANCE_BYTES must still produce a transcript -- the
    # MAX_UTTERANCE_BYTES cap force-flushing on its own, independent of the
    # silence detector.
    captured_pcm_lengths = []

    def fake_transcribe(pcm_bytes: bytes) -> str:
        captured_pcm_lengths.append(len(pcm_bytes))
        return f"transcript-of-{len(pcm_bytes)}-bytes"

    monkeypatch.setattr(voice_engine._stt, "transcribe", fake_transcribe)

    async def scenario():
        sock_path = tempfile.mktemp(suffix=".sock")
        # Each test drives its own fresh asyncio event loop via _run()/
        # asyncio.run() -- asyncio.Queue (and the Condition/Future objects
        # it creates internally) binds to whichever loop is running the
        # first time it actually needs to wait, and raises/silently dies if
        # reused from a different loop afterwards. The module-level
        # _inference_queue singleton is fine in production (one process, one
        # asyncio.run(main()) for its whole life) but isn't safe to reuse
        # across these tests' separate event-loop lifetimes, so each
        # scenario gets its own fresh InferenceQueue bound only to its own
        # loop.
        voice_engine._inference_queue = voice_engine.InferenceQueue()
        voice_engine._inference_queue.start()
        server = await asyncio.start_unix_server(voice_engine.handle_connection, path=sock_path)
        try:
            async with server:
                asyncio.ensure_future(server.serve_forever())
                reader, writer = await asyncio.open_unix_connection(sock_path)
                try:
                    # 16,000 int16 samples = 32,000 bytes/message -- the
                    # same per-message size real clients use
                    # (SPEAK_CHUNK_BYTES/TRANSCRIBE_CHUNK_BYTES), well under
                    # asyncio.StreamReader's default readline() buffer
                    # limit once base64-encoded (unlike a single huge
                    # message, which would hit that unrelated limit before
                    # ever reaching this cap logic). All well above
                    # voice_engine.SILENCE_RMS_THRESHOLD so the detector
                    # never sees silence. voice_engine.MAX_UTTERANCE_BYTES
                    # is 3,840,000 bytes = 120 messages exactly, so the
                    # 121st message crosses it.
                    speech_chunk = _make_pcm(2000, num_samples=16_000)
                    for _ in range(121):
                        writer.write((json.dumps({
                            "type": "audio_chunk",
                            "data": base64.b64encode(speech_chunk).decode(),
                        }) + "\n").encode())
                    await writer.drain()

                    line = await asyncio.wait_for(reader.readline(), timeout=10)
                    msg = json.loads(line.decode())
                    assert msg["type"] == "transcript", (
                        f"expected the buffer cap to force a transcript with no silence ever sent, got: {msg}"
                    )
                    assert captured_pcm_lengths, "expected the model to actually be called"
                    assert captured_pcm_lengths[0] > voice_engine.MAX_UTTERANCE_BYTES, (
                        f"expected the force-flush to fire only once the buffer exceeded the cap, "
                        f"got a flush at {captured_pcm_lengths[0]} bytes (cap is {voice_engine.MAX_UTTERANCE_BYTES})"
                    )
                finally:
                    writer.close()
        finally:
            if os.path.exists(sock_path):
                os.remove(sock_path)

    _run(scenario())


def test_audio_data_drops_oldest_bytes_once_the_buffer_exceeds_the_cap(monkeypatch):
    # I8 regression test, one-shot path: audio_data must never trigger a
    # transcript on its own (see the other tests above), but its buffer
    # still must not grow unbounded if a caller sends far more than a real
    # recorded clip's worth of audio without ever sending "transcribe".
    # Once the cap is exceeded, the oldest bytes are dropped so the buffer
    # never exceeds MAX_UTTERANCE_BYTES.
    captured_pcm_lengths = []

    def fake_transcribe(pcm_bytes: bytes) -> str:
        captured_pcm_lengths.append(len(pcm_bytes))
        return f"transcript-of-{len(pcm_bytes)}-bytes"

    monkeypatch.setattr(voice_engine._stt, "transcribe", fake_transcribe)

    async def scenario():
        sock_path = tempfile.mktemp(suffix=".sock")
        # Each test drives its own fresh asyncio event loop via _run()/
        # asyncio.run() -- asyncio.Queue (and the Condition/Future objects
        # it creates internally) binds to whichever loop is running the
        # first time it actually needs to wait, and raises/silently dies if
        # reused from a different loop afterwards. The module-level
        # _inference_queue singleton is fine in production (one process, one
        # asyncio.run(main()) for its whole life) but isn't safe to reuse
        # across these tests' separate event-loop lifetimes, so each
        # scenario gets its own fresh InferenceQueue bound only to its own
        # loop.
        voice_engine._inference_queue = voice_engine.InferenceQueue()
        voice_engine._inference_queue.start()
        server = await asyncio.start_unix_server(voice_engine.handle_connection, path=sock_path)
        try:
            async with server:
                asyncio.ensure_future(server.serve_forever())
                reader, writer = await asyncio.open_unix_connection(sock_path)
                try:
                    # 130 messages of 32,000 bytes each = 4,160,000 bytes
                    # sent, past MAX_UTTERANCE_BYTES (3,840,000 = exactly
                    # 120 messages) -- each overflow trims the buffer back
                    # down to exactly the cap, so it should sit at exactly
                    # the cap by the time "transcribe" is sent.
                    chunk = _make_pcm(2000, num_samples=16_000)
                    for _ in range(130):
                        writer.write((json.dumps({
                            "type": "audio_data",
                            "data": base64.b64encode(chunk).decode(),
                        }) + "\n").encode())
                    await writer.drain()

                    try:
                        premature = await asyncio.wait_for(reader.readline(), timeout=0.3)
                    except asyncio.TimeoutError:
                        premature = b""
                    assert premature == b"", (
                        f"audio_data must never trigger a transcript on its own, even past the cap, got: {premature!r}"
                    )

                    writer.write((json.dumps({"type": "transcribe"}) + "\n").encode())
                    await writer.drain()
                    line = await asyncio.wait_for(reader.readline(), timeout=5)
                    msg = json.loads(line.decode())
                    assert msg["type"] == "transcript"
                    assert captured_pcm_lengths == [voice_engine.MAX_UTTERANCE_BYTES], (
                        f"expected the buffer to have been capped at exactly MAX_UTTERANCE_BYTES "
                        f"({voice_engine.MAX_UTTERANCE_BYTES}) via oldest-bytes dropping, "
                        f"got: {captured_pcm_lengths}"
                    )
                finally:
                    writer.close()
        finally:
            if os.path.exists(sock_path):
                os.remove(sock_path)

    _run(scenario())


def test_transcribe_with_no_preceding_audio_returns_empty_transcript_without_crashing(monkeypatch):
    calls = []

    def fake_transcribe(pcm_bytes: bytes) -> str:
        calls.append(pcm_bytes)
        return "should not be called"

    monkeypatch.setattr(voice_engine._stt, "transcribe", fake_transcribe)

    async def scenario():
        sock_path = tempfile.mktemp(suffix=".sock")
        server = await asyncio.start_unix_server(voice_engine.handle_connection, path=sock_path)
        try:
            async with server:
                asyncio.ensure_future(server.serve_forever())
                reader, writer = await asyncio.open_unix_connection(sock_path)
                try:
                    writer.write((json.dumps({"type": "transcribe"}) + "\n").encode())
                    await writer.drain()
                    line = await asyncio.wait_for(reader.readline(), timeout=5)
                    msg = json.loads(line.decode())
                    assert msg == {"type": "transcript", "text": ""}
                    assert calls == []  # the model must never be called on an empty buffer
                finally:
                    writer.close()
        finally:
            if os.path.exists(sock_path):
                os.remove(sock_path)

    _run(scenario())


def test_second_concurrent_transcription_gets_a_queued_message_with_its_position(monkeypatch):
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
        # Each test drives its own fresh asyncio event loop via _run()/
        # asyncio.run() -- asyncio.Queue (and the Condition/Future objects
        # it creates internally) binds to whichever loop is running the
        # first time it actually needs to wait, and raises/silently dies if
        # reused from a different loop afterwards. The module-level
        # _inference_queue singleton is fine in production (one process, one
        # asyncio.run(main()) for its whole life) but isn't safe to reuse
        # across these tests' separate event-loop lifetimes, so each
        # scenario gets its own fresh InferenceQueue bound only to its own
        # loop.
        voice_engine._inference_queue = voice_engine.InferenceQueue()
        voice_engine._inference_queue.start()
        server = await asyncio.start_unix_server(voice_engine.handle_connection, path=sock_path)
        writer1 = writer2 = None
        try:
            async with server:
                asyncio.ensure_future(server.serve_forever())

                # First connection: sends audio_data + transcribe, but its
                # transcribe() call blocks on release_first_call until this
                # test explicitly frees it below.
                monkeypatch.setattr(voice_engine._stt, "transcribe", slow_transcribe)
                reader1, writer1 = await asyncio.open_unix_connection(sock_path)
                speech_chunk = _make_pcm(2000)
                try:
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
                    monkeypatch.setattr(voice_engine._stt, "transcribe", fast_transcribe)
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
                finally:
                    # A failed assertion above must not leave either writer
                    # open for the rest of this test process's lifetime --
                    # matches the single-writer scenarios' own try/finally
                    # pattern elsewhere in this file.
                    if writer1 is not None:
                        writer1.close()
                    if writer2 is not None:
                        writer2.close()
        finally:
            server.close()
            if os.path.exists(sock_path):
                os.remove(sock_path)

    _run(scenario())


def test_speak_local_synthesizes_and_plays_without_streaming_audio_chunks_back(monkeypatch):
    played = []

    def fake_synthesize(text: str) -> bytes:
        return f"pcm-for-{text}".encode()

    class FakePlayer:
        def play(self, pcm_bytes, sample_rate):
            played.append((pcm_bytes, sample_rate))

    monkeypatch.setattr(voice_engine._tts, "synthesize", fake_synthesize)
    monkeypatch.setattr(voice_engine, "_player", FakePlayer())
    monkeypatch.setattr(voice_engine, "_ambient_writer", None)

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
                    # speak_local is only honored on the registered ambient
                    # connection, so this has to identify itself first (as
                    # the real ambient-daemon-client.ts does on connect).
                    writer.write((json.dumps({"type": "hello_ambient"}) + "\n").encode())
                    await writer.drain()
                    for _ in range(200):
                        if voice_engine._ambient_writer is not None:
                            break
                        await asyncio.sleep(0.01)

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


def test_speak_local_from_a_non_ambient_connection_is_refused(monkeypatch):
    """speak_local drives the HOST's physical speaker and re-arms the
    ambient listener, so it must only ever be honored on the connection
    that identified itself with hello_ambient. Any other peer able to
    reach the Unix socket (a per-browser-session audio-client.ts
    connection, a one-shot transcribe/synthesize one, anything else on the
    box) must be ignored -- it used to be accepted from all of them."""
    played = []

    def fake_synthesize(text: str) -> bytes:
        return f"pcm-for-{text}".encode()

    class FakePlayer:
        def play(self, pcm_bytes, sample_rate):
            played.append((pcm_bytes, sample_rate))

    monkeypatch.setattr(voice_engine._tts, "synthesize", fake_synthesize)
    monkeypatch.setattr(voice_engine, "_player", FakePlayer())
    monkeypatch.setattr(voice_engine, "_ambient_writer", None)

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
                    # No hello_ambient on this connection.
                    writer.write((json.dumps({"type": "speak_local", "text": "wake everyone up"}) + "\n").encode())
                    await writer.drain()
                    # Then a message that DOES always get a reply, so this
                    # test observes a real response rather than just
                    # trusting a timeout: if speak_local had been honored,
                    # its speak_local_done would arrive first.
                    writer.write((json.dumps({"type": "transcribe"}) + "\n").encode())
                    await writer.drain()

                    line = await asyncio.wait_for(reader.readline(), timeout=5)
                    msg = json.loads(line.decode())
                    assert msg == {"type": "transcript", "text": ""}, (
                        f"speak_local from a non-ambient connection must be ignored entirely, got: {msg}"
                    )
                    assert played == [], "a non-ambient connection must never reach the host speaker"
                finally:
                    writer.close()
        finally:
            if os.path.exists(sock_path):
                os.remove(sock_path)

    _run(scenario())


class _RecordingAmbientListener(AmbientListener):
    """The REAL AmbientListener (real run() loop, real _turn_in_progress
    handling, real turn_complete()) with a call counter bolted on -- the
    thing under test here is the actual production state machine, not a
    stand-in for it. Only the three injected collaborators (wake-word
    predictor, transcribe, on_transcript) are fakes, exactly as
    AmbientListener's constructor is designed for."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.turn_complete_calls = 0

    def turn_complete(self) -> None:
        self.turn_complete_calls += 1
        super().turn_complete()


def _ambient_pcm(rms_level: int) -> bytes:
    import numpy as np
    return np.full(CHUNK_SAMPLES, rms_level, dtype=np.int16).tobytes()


def test_ambient_turn_round_trip_rearms_the_listener(monkeypatch):
    """The single most load-bearing behavior on the ambient path, end to
    end over a real Unix socket: hello_ambient registers the connection ->
    a wake-word trigger dispatches ambient_transcript to it -> the reply
    comes back as speak_local -> AmbientListener.turn_complete() actually
    fires, re-arming wake-word detection.

    Without that last step the listener latches _turn_in_progress=True
    forever and silently ignores every subsequent wake word, with nothing
    logged and nothing crashing -- the feature just stops working. The
    pre-existing test_speak_local_... test cannot catch this: it never sets
    voice_engine._ambient_listener, so _handle_speak_local's re-arming
    finally is a verified no-op there, never a real re-arm.
    """
    def fake_synthesize(text: str) -> bytes:
        return f"pcm-for-{text}".encode()

    class FakePlayer:
        def __init__(self):
            self.played = []

        def play(self, pcm_bytes, sample_rate):
            self.played.append((pcm_bytes, sample_rate))

    player = FakePlayer()
    monkeypatch.setattr(voice_engine._tts, "synthesize", fake_synthesize)
    monkeypatch.setattr(voice_engine, "_player", player)
    # Start from a known-clean module state -- monkeypatch restores both
    # afterwards, so this can't leak into any other test's run either.
    monkeypatch.setattr(voice_engine, "_ambient_writer", None)
    monkeypatch.setattr(voice_engine, "_ambient_listener", None)

    # One frame above threshold (the wake word), everything after it below.
    scores = iter([0.9])

    def fake_predict(frame):
        return next(scores, 0.0)

    def fake_transcribe(pcm_bytes):
        return "what time is it"

    async def scenario():
        frame_queue = asyncio.Queue()
        listener = _RecordingAmbientListener(
            frame_queue=frame_queue,
            wake_word_predict=fake_predict,
            transcribe=fake_transcribe,
            # The REAL dispatcher, so the _ambient_writer lookup and socket
            # write this test exists to prove are the production ones.
            on_transcript=voice_engine._dispatch_ambient_transcript,
            threshold=0.5,
            silence_frames_threshold=2,
        )
        monkeypatch.setattr(voice_engine, "_ambient_listener", listener)

        sock_path = tempfile.mktemp(suffix=".sock")
        voice_engine._inference_queue = voice_engine.InferenceQueue()
        voice_engine._inference_queue.start()
        listener_task = asyncio.ensure_future(listener.run())
        server = await asyncio.start_unix_server(voice_engine.handle_connection, path=sock_path)
        try:
            async with server:
                asyncio.ensure_future(server.serve_forever())
                reader, writer = await asyncio.open_unix_connection(sock_path)
                try:
                    writer.write((json.dumps({"type": "hello_ambient"}) + "\n").encode())
                    await writer.drain()

                    # Wait for the daemon side to actually register this
                    # connection before firing the wake word -- otherwise
                    # the dispatcher would take its "no active ambient
                    # connection" branch and this test would pass for the
                    # wrong reason.
                    for _ in range(200):
                        if voice_engine._ambient_writer is not None:
                            break
                        await asyncio.sleep(0.01)
                    assert voice_engine._ambient_writer is not None, (
                        "daemon never registered the hello_ambient connection as _ambient_writer"
                    )

                    # Wake word, then the utterance, then enough silence to
                    # close it out.
                    await frame_queue.put(_ambient_pcm(3000))  # scores 0.9 -> trigger
                    await frame_queue.put(_ambient_pcm(3000))  # the spoken utterance
                    await frame_queue.put(_ambient_pcm(0))
                    await frame_queue.put(_ambient_pcm(0))

                    line = await asyncio.wait_for(reader.readline(), timeout=10)
                    msg = json.loads(line.decode())
                    assert msg == {"type": "ambient_transcript", "text": "what time is it"}, (
                        f"expected the wake-word turn's transcript to be pushed to the ambient connection, got: {msg}"
                    )
                    assert listener._turn_in_progress is True, (
                        "listener must stay latched for the duration of the turn it just dispatched"
                    )
                    assert listener.turn_complete_calls == 0

                    # The reply, exactly as ambient-daemon-client.ts sends it.
                    writer.write((json.dumps({"type": "speak_local", "text": "it is ten past four"}) + "\n").encode())
                    await writer.drain()

                    line = await asyncio.wait_for(reader.readline(), timeout=10)
                    msg = json.loads(line.decode())
                    assert msg == {"type": "speak_local_done"}, f"expected speak_local_done, got: {msg}"
                    assert player.played == [(b"pcm-for-it is ten past four", voice_engine.KOKORO_SAMPLE_RATE)]

                    # turn_complete() runs in _handle_speak_local's finally,
                    # which can land just after speak_local_done reaches us.
                    for _ in range(200):
                        if listener.turn_complete_calls:
                            break
                        await asyncio.sleep(0.01)
                    assert listener.turn_complete_calls == 1, (
                        "AmbientListener.turn_complete() was never called for a completed ambient turn -- "
                        "the listener is now latched and will ignore every future wake word"
                    )
                    assert listener._turn_in_progress is False, (
                        "listener must be re-armed for the next wake word once the reply has been spoken"
                    )
                finally:
                    writer.close()
        finally:
            listener_task.cancel()
            if os.path.exists(sock_path):
                os.remove(sock_path)

    _run(scenario())


def test_ambient_listener_task_is_retained_and_logs_critical_if_it_dies(monkeypatch):
    """Regression test for the exact failure mode InferenceQueue's own
    _on_worker_done guards against (see that class's docstring), now
    applied to the ambient listener task started in main(): a bare
    `asyncio.create_task(...)` with no stored reference and no done
    callback means (a) the task is eligible for GC mid-run, and (b) if
    AmbientListener.run() ever raises, it's only visible as an
    unretrieved-task-exception warning at some arbitrary future GC time,
    with ambient listening silently dead in the meantime. Verifies both
    halves directly: the module keeps a real reference, and
    _on_ambient_listener_done logs critical on an unexpected exception but
    stays silent on a deliberate cancellation."""
    critical_calls = []
    monkeypatch.setattr(voice_engine.log, "critical", lambda *a, **kw: critical_calls.append((a, kw)))

    async def scenario():
        # An unexpected exception must log critical.
        async def boom():
            raise RuntimeError("ambient listener blew up")

        task = asyncio.ensure_future(boom())
        try:
            await task
        except RuntimeError:
            pass
        voice_engine._on_ambient_listener_done(task)
        assert len(critical_calls) == 1, "an unexpected exception in the ambient listener task must log critical"
        assert "ambient listener task died unexpectedly" in critical_calls[0][0][0]

        # A deliberate cancellation must NOT log critical.
        critical_calls.clear()

        async def hang_forever():
            await asyncio.Event().wait()

        task2 = asyncio.ensure_future(hang_forever())
        await asyncio.sleep(0)
        task2.cancel()
        try:
            await task2
        except asyncio.CancelledError:
            pass
        voice_engine._on_ambient_listener_done(task2)
        assert critical_calls == [], "a deliberate cancellation must never be logged as an unexpected death"

    _run(scenario())

    # main() must store the created task somewhere real, not just fire
    # asyncio.create_task and drop the reference -- confirmed here by
    # checking the module actually exposes a slot for it (exercised live in
    # main() itself; asserting its existence here so a future refactor that
    # deletes the module-level variable and reverts to a bare
    # create_task(...) call is caught).
    assert hasattr(voice_engine, "_ambient_listener_task")
