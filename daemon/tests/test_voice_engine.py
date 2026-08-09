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
