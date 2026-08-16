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
