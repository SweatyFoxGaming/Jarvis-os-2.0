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
# Upper bound on a single captured utterance, mirroring
# voice_engine.MAX_UTTERANCE_BYTES's 2-minute convention (that constant is
# sized for the browser path's 32000 bytes/sec; this path is 16kHz mono
# int16 = SAMPLE_RATE * 2 bytes/sec). Without a cap, a room with
# continuous background noise after a wake word would keep
# utterance_buffer growing for as long as the noise lasts, since the
# silence-based UtteranceEndDetector never fires.
AMBIENT_MAX_UTTERANCE_BYTES = 2 * 60 * SAMPLE_RATE * 2


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
        turn_timeout: float = 60.0,
    ):
        self.frame_queue = frame_queue
        self.wake_word_predict = wake_word_predict
        self.transcribe = transcribe
        self.on_transcript = on_transcript
        self.threshold = threshold
        self.silence_frames_threshold = silence_frames_threshold
        # Upper bound on how long a single turn (on_transcript dispatch --
        # Node's turn machinery -- TTS -- speak_local coming back) is
        # allowed to stay in flight before this listener gives up waiting
        # and re-arms itself. turn_complete() is ALREADY correctly called
        # on every path that can detect the turn ending (connection close,
        # speak_local completing -- see voice_engine.py's finally blocks),
        # but none of those fire if the round trip just hangs forever with
        # the socket staying open and healthy the whole time (e.g. an LLM
        # call with no timeout of its own). This is the backstop for that
        # case specifically -- a dead-man's-switch, not the normal
        # completion path.
        self.turn_timeout = turn_timeout
        # True from the instant a wake word triggers until the resulting
        # turn's transcript has been dispatched -- guards against a second
        # trigger (or the tail of the reply itself, once mic capture and
        # playback coexist) starting a second capture mid-turn.
        self._turn_in_progress = False
        # The scheduled turn-timeout watchdog task for the currently
        # in-flight turn, if any. Cancelled by turn_complete() when the
        # turn finishes normally, so a normal completion never leaves a
        # leaked task around or risks a spurious double turn_complete()
        # call from the timeout firing afterwards.
        self._turn_timeout_task: Optional[asyncio.Task] = None

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

            # Triggered -- capture the utterance itself. Only actual speech
            # frames are buffered (not the trailing silence frames fed to
            # the detector while it counts toward silence_frames_threshold)
            # so the captured utterance is exactly the speech that was
            # spoken, with no silence padding at either end.
            is_speech = _is_speech_frame(pcm_bytes)
            utterance_ended = detector.feed(is_speech)
            if is_speech and not utterance_ended:
                utterance_buffer.extend(pcm_bytes)

            # Same force-flush guard voice_engine._handle_audio_chunk
            # already has: transcribe whatever was captured so far and
            # reset, rather than letting a continuously noisy room grow
            # this buffer without bound (the silence-based detector above
            # would never fire in that case).
            force_flush = len(utterance_buffer) > AMBIENT_MAX_UTTERANCE_BYTES
            if force_flush:
                log.warning(
                    f"ambient utterance_buffer exceeded AMBIENT_MAX_UTTERANCE_BYTES "
                    f"({len(utterance_buffer)} bytes); force-flushing"
                )
            if not utterance_ended and not force_flush:
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
                    # Schedule the timeout watchdog right before dispatching
                    # -- from here on, turn_complete() must be called (by
                    # whatever normally re-arms the listener, or by the
                    # watchdog itself if nothing else ever does) or this
                    # listener stays latched off forever.
                    self._turn_timeout_task = asyncio.create_task(self._turn_timeout_watchdog())
                    await self.on_transcript(text)
                else:
                    self._turn_in_progress = False
            except Exception:
                log.exception("ambient utterance transcription failed")
                self._turn_in_progress = False
                self._cancel_turn_timeout()

    async def _turn_timeout_watchdog(self) -> None:
        """Backstop for a turn that gets dispatched via on_transcript but
        then never completes -- not just a dropped connection (already
        covered elsewhere: turn_complete() is called on connection-close and
        on speak_local finishing), but the FULL round trip (Node dispatching
        the turn, the LLM call, TTS, and the reply coming back as
        speak_local) simply hanging forever while the socket stays open and
        healthy the whole time -- e.g. an LLM call with no timeout of its
        own. Cancelled by turn_complete() (via _cancel_turn_timeout) if the
        turn finishes normally before this fires, so a normal turn never
        pays for this beyond scheduling+cancelling one task."""
        try:
            await asyncio.sleep(self.turn_timeout)
        except asyncio.CancelledError:
            return
        log.warning(
            f"ambient turn timed out after {self.turn_timeout}s with no turn_complete() "
            "call -- forcing re-arm so a hung turn doesn't permanently silence wake-word "
            "detection"
        )
        self.turn_complete()

    def _cancel_turn_timeout(self) -> None:
        task = self._turn_timeout_task
        self._turn_timeout_task = None
        if task is not None and not task.done():
            task.cancel()

    def turn_complete(self) -> None:
        """Called once the reply for the current turn has finished (Task 6
        wires this to the daemon receiving speak_local_done back from
        itself) -- re-arms wake-word detection for the next trigger."""
        self._turn_in_progress = False
        self._cancel_turn_timeout()


def start_mic_capture(
    device: "Optional[int | str]", sample_rate: int = SAMPLE_RATE, chunk_samples: int = CHUNK_SAMPLES
) -> "tuple[asyncio.Queue[bytes], object]":
    """Opens a real ALSA input stream and pushes each CHUNK_SAMPLES-sized
    int16 PCM block onto the returned queue. Returns (queue, stream): the
    caller MUST hold on to the stream for as long as capture should run.
    Returning only the queue (as this used to) dropped the last reference
    to a live sounddevice.InputStream, leaving it eligible for garbage
    collection mid-capture, and left no handle to stop/close the device if
    the caller's own setup failed afterwards -- which would leak an open
    mic pushing frames into a queue nobody reads, forever.

    sounddevice's InputStream callback runs on its own C-managed thread
    (not the asyncio event loop), so loop.call_soon_threadsafe is required
    to safely hand data back -- calling queue.put_nowait directly from
    that callback thread would
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
    return queue, stream
