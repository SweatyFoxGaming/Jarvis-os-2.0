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
