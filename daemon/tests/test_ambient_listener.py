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


def test_turn_that_completes_normally_does_not_later_fire_the_timeout():
    # on_transcript calls turn_complete() itself almost immediately (as
    # _dispatch_ambient_transcript does once it has written the message),
    # well before the short test-only timeout would elapse. If the timeout
    # task weren't cancelled, it would still fire later and call
    # turn_complete() again -- harmless on its own (turn_complete() is
    # idempotent), but this test's real point is proving the watchdog task
    # is actually cancelled (not just harmless), via listener._turn_timeout_task.
    scores = iter([0.9])

    def fake_predict(frame):
        return next(scores, 0.0)

    def fake_transcribe(pcm_bytes):
        return "hey jarvis"

    dispatched = asyncio.Event()

    async def fake_on_transcript(text):
        dispatched.set()
        listener.turn_complete()

    async def scenario():
        nonlocal listener
        queue = asyncio.Queue()
        listener = AmbientListener(
            frame_queue=queue,
            wake_word_predict=fake_predict,
            transcribe=fake_transcribe,
            on_transcript=fake_on_transcript,
            threshold=0.5,
            silence_frames_threshold=2,
            turn_timeout=0.2,
        )
        run_task = asyncio.ensure_future(listener.run())
        try:
            await queue.put(_speech_chunk().tobytes())  # trigger
            await queue.put(_speech_chunk().tobytes())  # utterance speech
            await queue.put(_silent_chunk().tobytes())  # end-of-utterance silence
            await queue.put(_silent_chunk().tobytes())

            # Wait for the dispatch itself, not just _turn_in_progress
            # becoming False -- it starts False by default, so polling it
            # directly without first confirming dispatch happened could
            # observe the pre-trigger state and pass vacuously, never
            # actually exercising the watchdog-cancellation behavior below.
            await asyncio.wait_for(dispatched.wait(), timeout=2)

            assert listener._turn_in_progress is False
            assert listener._turn_timeout_task is None, (
                "turn_complete() firing before the timeout must cancel the watchdog task, "
                "not just leave it to fire later"
            )

            # Wait past where the (short) test timeout would have fired if
            # it hadn't been cancelled, and confirm nothing changed.
            await asyncio.sleep(0.3)
            assert listener._turn_in_progress is False
            assert listener._turn_timeout_task is None
        finally:
            run_task.cancel()
            try:
                await run_task
            except asyncio.CancelledError:
                pass

    listener = None
    _run(scenario())


def test_turn_that_never_completes_eventually_rearms_via_the_timeout():
    # on_transcript is dispatched but deliberately never calls
    # turn_complete() -- simulating the full round trip (Node dispatch, LLM
    # call, TTS, speak_local reply) hanging forever with the socket
    # otherwise healthy. Only the timeout watchdog should re-arm the
    # listener here.
    scores = iter([0.9])

    def fake_predict(frame):
        return next(scores, 0.0)

    def fake_transcribe(pcm_bytes):
        return "hey jarvis"

    dispatched = []

    async def fake_on_transcript(text):
        dispatched.append(text)
        # Deliberately never call turn_complete() -- this turn hangs forever.

    async def scenario():
        queue = asyncio.Queue()
        listener = AmbientListener(
            frame_queue=queue,
            wake_word_predict=fake_predict,
            transcribe=fake_transcribe,
            on_transcript=fake_on_transcript,
            threshold=0.5,
            silence_frames_threshold=2,
            turn_timeout=0.1,
        )
        run_task = asyncio.ensure_future(listener.run())
        try:
            await queue.put(_speech_chunk().tobytes())  # trigger
            await queue.put(_speech_chunk().tobytes())  # utterance speech
            await queue.put(_silent_chunk().tobytes())  # end-of-utterance silence
            await queue.put(_silent_chunk().tobytes())

            for _ in range(50):
                if dispatched:
                    break
                await asyncio.sleep(0.01)
            assert dispatched == ["hey jarvis"]

            # Immediately after dispatch, the turn is still latched (the
            # timeout hasn't had time to fire yet).
            assert listener._turn_in_progress is True

            # Wait past turn_timeout -- the watchdog must re-arm on its own.
            for _ in range(200):
                if not listener._turn_in_progress:
                    break
                await asyncio.sleep(0.01)

            assert listener._turn_in_progress is False, (
                "a turn that never calls turn_complete() must still eventually re-arm via "
                "the turn_timeout watchdog"
            )
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
