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

            # Triggered -- capture the utterance itself. Only actual speech
            # frames are buffered (not the trailing silence frames fed to
            # the detector while it counts toward silence_frames_threshold)
            # so the captured utterance is exactly the speech that was
            # spoken, with no silence padding at either end.
            is_speech = _is_speech_frame(pcm_bytes)
            utterance_ended = detector.feed(is_speech)
            if not utterance_ended:
                if is_speech:
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
