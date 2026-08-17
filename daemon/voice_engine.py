import asyncio
import json
import logging
import os
import signal
import sys
from typing import Callable, Optional, Set

import numpy as np

from ambient_listener import AmbientListener, start_mic_capture
from models import AudioPlayer, SpeechToText, TextToSpeech, KOKORO_SAMPLE_RATE, parse_device_env
from protocol import (
    ProtocolError,
    UtteranceEndDetector,
    decode_audio_chunk,
    encode_audio_chunk,
    parse_control_message,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("voice_engine")

SOCKET_PATH = os.environ.get("VOICE_DAEMON_SOCKET", "/tmp/jarvis-voice/voice.sock")
SILENCE_RMS_THRESHOLD = 500
SPEAK_CHUNK_BYTES = 32000
MAX_UTTERANCE_BYTES = 2 * 60 * 32000
AMBIENT_LISTENING_ENABLED = os.environ.get("AMBIENT_LISTENING_ENABLED", "false").lower() == "true"
AMBIENT_MIC_DEVICE = parse_device_env(os.environ.get("AMBIENT_MIC_DEVICE"))
# `.get(key, default)`'s default only applies when the var is entirely
# UNSET -- if it's set but blank (AMBIENT_WAKE_WORD_THRESHOLD= with nothing
# after the "="), .get() returns "" (not the default), and float("") raises
# ValueError at import time, crashing the whole daemon (click-to-talk
# included) regardless of AMBIENT_LISTENING_ENABLED. `or` falls through on
# both None (unset) and "" (blank), so this treats both the same.
AMBIENT_WAKE_WORD_THRESHOLD = float(os.environ.get("AMBIENT_WAKE_WORD_THRESHOLD") or "0.5")

_stt = SpeechToText()
_tts = TextToSpeech()
_player = AudioPlayer()

# Track active client writers so we can gracefully close them on shutdown
_active_writers: Set[asyncio.StreamWriter] = set()

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
# Reference to the asyncio.Task running _ambient_listener.run(), kept for
# the exact same reason InferenceQueue.start() keeps self._worker_task (see
# its own docstring): asyncio.create_task's return value is the ONLY strong
# reference to a running task, so not storing it anywhere leaves the task
# eligible for garbage collection mid-run, and any unexpected exception it
# raises would otherwise only ever surface as an unretrieved-task-exception
# warning at some arbitrary later GC time -- with ambient listening then
# silently dead and nothing pointing at why.
_ambient_listener_task: Optional[asyncio.Task] = None


def _on_ambient_listener_done(task: asyncio.Task) -> None:
    """Registered on _ambient_listener_task, mirroring InferenceQueue's
    _on_worker_done -- if AmbientListener.run() ever exits unexpectedly
    (it's an infinite loop in normal operation), this is the loud alarm for
    it instead of a silent, invisible death."""
    if task.cancelled():
        return
    exc = task.exception()
    if exc is not None:
        log.critical(
            f"ambient listener task died unexpectedly: {exc!r} -- ambient "
            "(host-mic) voice is now silently dead until the daemon is "
            "restarted; click-to-talk STT/TTS is unaffected",
            exc_info=exc,
        )


async def _dispatch_ambient_transcript(text: str) -> None:
    if _ambient_writer is None or _ambient_writer.is_closing():
        log.warning(f"ambient wake word fired but no Node ambient connection is active; discarding transcript: {text!r}")
        if _ambient_listener is not None:
            _ambient_listener.turn_complete()
        return
    await _write_message(_ambient_writer, {"type": "ambient_transcript", "text": text})


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
        # Jobs queued OR currently being run by the worker. NOT the same as
        # self._queue.qsize(): asyncio.Queue.get() removes an item from the
        # queue's internal deque the instant the worker claims it, well
        # before that job's actual inference call (asyncio.to_thread(...))
        # finishes -- so qsize() alone reads back down to 0 while a job is
        # still in flight, and a second submit() during that window would
        # wrongly compute position 0 instead of 1. This counter is
        # incremented in submit() (before put()) and only decremented once
        # the worker has fully finished a job (in _worker's finally), so it
        # always reflects "how many jobs are ahead of a newly submitted one,
        # whether still queued or actively running".
        self._pending = 0

    def start(self) -> None:
        """Must be called once, from inside a running event loop (main(),
        below) -- asyncio.create_task requires one, unlike the Queue/lock
        constructors above, which don't.

        Idempotent: a second call is a no-op rather than spinning up a
        second concurrent _worker() task. Nothing calls start() twice
        today, but if it ever did, two workers would violate this class's
        own core invariant (one inference call in flight at a time, system
        -wide -- see the class docstring)."""
        if self._worker_task is not None:
            return
        self._worker_task = asyncio.create_task(self._worker())
        self._worker_task.add_done_callback(self._on_worker_done)

    def _on_worker_done(self, task: asyncio.Task) -> None:
        """Registered on self._worker_task so a worker crash is never just
        an "unretrieved task exception" warning logged at some arbitrary
        future GC time. If _worker() ever exits -- which should never
        happen in normal operation -- every submit() after that point still
        succeeds silently (the queue has no size limit) and every `await
        future` on those jobs hangs forever (futures have no timeout), with
        no other visible symptom. This is the loud alarm for that."""
        if task.cancelled():
            return
        exc = task.exception()
        if exc is not None:
            log.critical(
                f"InferenceQueue worker died unexpectedly: {exc!r} -- all "
                "subsequent STT/TTS requests will hang forever until the "
                "daemon is restarted",
                exc_info=exc,
            )

    async def _worker(self) -> None:
        try:
            while True:
                fn, args, future = await self._queue.get()
                try:
                    result = await asyncio.to_thread(fn, *args)
                    if not future.cancelled():
                        future.set_result(result)
                except asyncio.CancelledError:
                    # Deliberate cancellation of this worker task (e.g.
                    # during shutdown) -- must propagate normally, not be
                    # treated as a job failure.
                    raise
                except BaseException as exc:  # noqa: BLE001 -- propagated to the caller via the future, not swallowed. Catching BaseException (not just Exception) so a non-Exception failure surfaced through asyncio.to_thread can never silently kill this worker task -- see class docstring and Plan 2 final review finding 1.
                    if not future.cancelled():
                        future.set_exception(exc)
                finally:
                    self._pending -= 1
                    self._queue.task_done()
        except asyncio.CancelledError:
            raise
        except BaseException:
            # This should be unreachable: every per-job failure above is
            # caught inside the inner try/except and never escapes the
            # loop. If something still gets here, it's a genuine bug in
            # this method itself -- log loudly (in addition to the
            # done_callback registered in start()) before letting it
            # propagate and kill the task.
            log.critical(
                "InferenceQueue worker loop is exiting unexpectedly -- this "
                "should never happen in normal operation; all subsequent "
                "STT/TTS requests will hang forever until the daemon is "
                "restarted",
                exc_info=True,
            )
            raise

    async def submit(self, fn, *args) -> tuple[asyncio.Future, int]:
        """Returns (future, position). position is 0 if this job starts
        immediately (nothing else queued/running ahead of it), or the
        number of jobs already queued/running ahead of it otherwise. Read
        self._pending BEFORE incrementing/put() -- afterwards, this job
        would count itself."""
        position = self._pending
        self._pending += 1
        future = asyncio.get_running_loop().create_future()
        await self._queue.put((fn, args, future))
        return future, position


_inference_queue = InferenceQueue()


def _is_speech_frame(pcm_bytes: bytes) -> bool:
    if not pcm_bytes:
        return False
    if len(pcm_bytes) % 2 != 0:
        pcm_bytes = pcm_bytes[:-1]
    if not pcm_bytes:
        return False
    audio = np.frombuffer(pcm_bytes, dtype=np.int16)
    if audio.size == 0:
        return False
    rms = float(np.sqrt(np.mean(audio.astype(np.float64) ** 2)))
    return rms > SILENCE_RMS_THRESHOLD


async def _write_message(writer: asyncio.StreamWriter, message: dict) -> None:
    writer.write((json.dumps(message) + "\n").encode("utf-8"))
    await writer.drain()


async def _run_transcription(writer: asyncio.StreamWriter, pcm_for_utterance: bytes, peer: str) -> None:
    if not pcm_for_utterance:
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


async def _handle_audio_chunk(
    writer: asyncio.StreamWriter,
    msg: dict,
    detector: UtteranceEndDetector,
    utterance_buffer: bytearray,
    peer: str,
) -> None:
    try:
        pcm = decode_audio_chunk(msg.get("data", ""))
    except ProtocolError as e:
        log.warning(f"malformed audio_chunk from {peer}, ignoring: {e}")
        return
    utterance_buffer.extend(pcm)

    if len(utterance_buffer) > MAX_UTTERANCE_BYTES:
        log.warning(f"utterance_buffer for {peer} exceeded MAX_UTTERANCE_BYTES; force-flushing")
        pcm_for_utterance = bytes(utterance_buffer)
        utterance_buffer.clear()
        detector.reset()
        await _run_transcription(writer, pcm_for_utterance, peer)
        return

    utterance_ended = detector.feed(_is_speech_frame(pcm))
    if not utterance_ended:
        return
    pcm_for_utterance = bytes(utterance_buffer)
    utterance_buffer.clear()
    await _run_transcription(writer, pcm_for_utterance, peer)


async def _handle_audio_data(
    msg: dict,
    utterance_buffer: bytearray,
    peer: str,
) -> None:
    try:
        pcm = decode_audio_chunk(msg.get("data", ""))
    except ProtocolError as e:
        log.warning(f"malformed audio_data from {peer}, ignoring: {e}")
        return
    utterance_buffer.extend(pcm)

    if len(utterance_buffer) > MAX_UTTERANCE_BYTES:
        overflow = len(utterance_buffer) - MAX_UTTERANCE_BYTES
        log.warning(f"utterance_buffer for {peer} exceeded cap via audio_data; dropping {overflow} bytes")
        del utterance_buffer[:overflow]


async def _handle_transcribe(
    writer: asyncio.StreamWriter,
    detector: UtteranceEndDetector,
    utterance_buffer: bytearray,
    peer: str,
) -> None:
    pcm_for_utterance = bytes(utterance_buffer)
    utterance_buffer.clear()
    detector.reset()
    await _run_transcription(writer, pcm_for_utterance, peer)


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


async def _handle_speak_local(writer: asyncio.StreamWriter, msg: dict, peer: str) -> None:
    """Synthesizes and plays text DIRECTLY out the host speaker -- unlike
    _handle_speak above, there is no caller waiting to receive audio_chunk
    frames back; this is the ambient host-mic path's reply mechanism. The
    finally block re-arms AmbientListener regardless of success/failure --
    only the ambient connection ever sends speak_local (Task 4's
    ambient-daemon-client.ts), so it's always correct to call
    turn_complete() once this handler is done, whichever way it ends.

    That "only the ambient connection" invariant is now actually ENFORCED
    (it used to be an unchecked docstring claim): any other peer on this
    socket -- a per-browser-session audio-client.ts connection, a one-shot
    transcribe/synthesize connection, or anything else that can reach the
    Unix socket -- sending speak_local would otherwise be able to make the
    daemon speak arbitrary text out of the host's physical speaker AND
    re-arm the ambient listener mid-turn. Rejected loudly and early
    instead."""
    if writer is not _ambient_writer:
        log.warning(
            f"ignoring speak_local from {peer}: it is not the registered ambient connection "
            "(only the connection that sent hello_ambient may drive host-speaker playback)"
        )
        return
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


async def handle_connection(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    # Declared once, at the top of the function: Python raises a SyntaxError
    # ("name '_ambient_writer' is assigned to before global declaration") if
    # `global _ambient_writer` appears more than once in the same function
    # body at different points, since the first occurrence already makes
    # every later reference in this function refer to the module-level name.
    global _ambient_writer
    peer = writer.get_extra_info("peername") or "unix-client"
    log.info(f"connection opened: {peer}")
    _active_writers.add(writer)
    detector = UtteranceEndDetector()
    utterance_buffer = bytearray()
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
            msg_type = msg.get("type", "unknown")
            if msg_type == "audio_chunk":
                await _handle_audio_chunk(writer, msg, detector, utterance_buffer, peer)
            elif msg_type == "audio_data":
                await _handle_audio_data(msg, utterance_buffer, peer)
            elif msg_type == "speak":
                await _handle_speak(writer, msg, peer)
            elif msg_type == "speak_local":
                await _handle_speak_local(writer, msg, peer)
            elif msg_type == "transcribe":
                await _handle_transcribe(writer, detector, utterance_buffer, peer)
            elif msg_type == "hello_ambient":
                # Exactly one ambient connection at a time. If a DIFFERENT,
                # still-open connection already holds that role, refuse
                # rather than silently redirecting every future
                # ambient_transcript (and the speak_local authorization
                # that goes with it, see _handle_speak_local) to whichever
                # peer spoke last -- that would let any process able to
                # reach this Unix socket hijack the host-mic turn stream
                # from the real Node client. A re-handshake from the SAME
                # writer, or one arriving after the previous ambient
                # connection has closed (handle_connection's finally
                # clears _ambient_writer) is accepted normally, so Node's
                # own reconnect loop is unaffected.
                if (
                    _ambient_writer is not None
                    and _ambient_writer is not writer
                    and not _ambient_writer.is_closing()
                ):
                    log.warning(
                        f"REFUSING hello_ambient from {peer}: another ambient connection is already "
                        "active and still open; ignoring this handshake rather than redirecting the "
                        "ambient transcript stream"
                    )
                else:
                    _ambient_writer = writer
                    log.info(f"ambient connection identified: {peer}")
            else:
                log.info(f"received control message: {msg_type}")
    except (ConnectionResetError, BrokenPipeError):
        log.info(f"connection reset: {peer}")
    except asyncio.CancelledError:
        pass
    finally:
        _active_writers.discard(writer)
        if _ambient_writer is writer:
            _ambient_writer = None
            # The ambient connection is going away. If a turn was in
            # flight on it, its reply (the speak_local that would have
            # run _handle_speak_local's own re-arming finally) can never
            # arrive now, so AmbientListener would stay latched with
            # _turn_in_progress=True forever -- silently ignoring every
            # subsequent wake word with no error anywhere. Re-arm here
            # instead. This is the catch-all for every "reply lost"
            # scenario (Node restarting mid-turn, a reconnect window, the
            # API container being recreated): they all end with this
            # socket closing, and this finally always runs when it does.
            # Harmless when no turn was in flight -- turn_complete() just
            # sets an already-False flag back to False.
            if _ambient_listener is not None:
                _ambient_listener.turn_complete()
        try:
            writer.close()
            await writer.wait_closed()
        except (ConnectionResetError, BrokenPipeError):
            # The peer can legitimately have already torn down its side
            # (e.g. its own client-side timeout fired and destroyed the
            # socket while we were still writing) -- closing our side can
            # race that. Previously uncaught here (the same exception types
            # ARE caught around the read loop above, but that except clause
            # doesn't cover this finally block), which surfaced as a noisy
            # "Unhandled exception in client_connected_cb" traceback in the
            # logs on every client-timeout, even though the daemon itself
            # was never actually broken by it.
            pass
        log.info(f"connection closed: {peer}")


def _cleanup_socket() -> None:
    """Safely remove socket file if present."""
    if os.path.exists(SOCKET_PATH):
        try:
            os.remove(SOCKET_PATH)
            log.info(f"removed socket file at {SOCKET_PATH}")
        except OSError as e:
            log.warning(f"failed to remove socket file: {e}")


def _prepare_socket_dir() -> None:
    socket_dir = os.path.dirname(SOCKET_PATH)
    os.makedirs(socket_dir, exist_ok=True)
    _cleanup_socket()


async def _warm_models() -> None:
    """Pre-loads both models in the background right after the daemon starts
    accepting connections, so the FIRST real transcribe/synthesize request
    doesn't pay the one-time weights-download-and-load cost (tens of
    seconds on a cold cache, live-verified: ~9s for Kokoro once cached,
    ~32s for faster-whisper's first-ever load including the Hugging Face
    download) on top of whatever client-side timeout is racing it --
    exactly the failure mode that broke voice on this daemon's actual first
    real use: audio-client.ts's 60s synthesizeOverSocket/
    transcribeOverSocket timeouts collided with a cold container (0
    restarts, hours of uptime, never having served one real request) doing
    its first-ever HF download AND model load in the same window.

    Submitted through _inference_queue (not a bare asyncio.to_thread) so it
    naturally serializes with any real request that arrives while it's
    still loading, rather than racing two model-load threads against each
    other. Harmless no-op if a real request gets there first --
    SpeechToText/TextToSpeech's _ensure_loaded() already de-dupes concurrent
    loads via its own lock, so whichever caller (this warm-up or a real
    request) loses the race just finds the model already loaded.
    """
    try:
        log.info("pre-warming STT/TTS models in the background...")
        stt_future, _ = await _inference_queue.submit(_stt._ensure_loaded)
        await stt_future
        tts_future, _ = await _inference_queue.submit(_tts._ensure_loaded)
        await tts_future
        log.info("model pre-warm complete")
    except Exception:
        # Never let a warm-up failure crash the daemon or block real
        # requests -- worst case, the lazy-load path in models.py pays the
        # same cost the next real request pays anyway, same as before this
        # existed.
        log.exception("model pre-warm failed; models will still lazy-load on first real request")


def _make_wake_word_predictor() -> Callable[[np.ndarray], float]:
    """Real openWakeWord adapter -- wraps openwakeword.Model's predict()
    call behind AmbientListener's simple `frame -> float` interface.
    openWakeWord's real Model.predict(frame) takes a 1D int16 numpy array
    of exactly CHUNK_SAMPLES (1280) samples and returns a dict of
    {model_name: score}. Verified live against the actually-installed
    openwakeword==0.6.0 inside the built daemon image: this function
    constructs and returns a float score for a 1280-sample int16 frame,
    entirely offline (the model files are baked into the image, see
    daemon/Dockerfile). If a future version's API differs, this is the one
    function that needs to change,
    everything else in this file is decoupled from openWakeWord's exact
    shape by AmbientListener's injectable interface.
    """
    from openwakeword.model import Model
    # inference_framework is pinned explicitly: openwakeword 0.6.0's own
    # default is "tflite" (verified against the installed 0.6.0 wheel's
    # Model.__init__ signature), which requires the tflite-runtime native
    # package. ONNX is what this codebase already targets elsewhere, and
    # onnxruntime is a hard, always-installed dependency of openwakeword
    # itself -- so "onnx" is the variant guaranteed to exist in this slim
    # container. daemon/Dockerfile's build-time download step fetches both
    # the .tflite and .onnx model files (its utility offers no way to pick
    # one), so the .onnx ones these sessions load are present in the image.
    model = Model(wakeword_models=["hey_jarvis"], inference_framework="onnx")

    def predict(frame: np.ndarray) -> float:
        prediction = model.predict(frame)
        return float(prediction.get("hey_jarvis", 0.0))

    return predict


async def main() -> None:
    # Must start from inside this running event loop -- InferenceQueue.start()
    # calls asyncio.create_task, which requires one (unlike the plain
    # Semaphore/Queue construction this replaced, which didn't).
    _inference_queue.start()
    asyncio.create_task(_warm_models())

    if AMBIENT_LISTENING_ENABLED:
        global _ambient_listener, _ambient_listener_task
        # Held in a local of this coroutine's frame, which stays alive for
        # the daemon's whole lifetime (main() sits on `await
        # stop_event.wait()` below). That reference is what keeps the real
        # sounddevice.InputStream from being garbage-collected out from
        # under the still-running capture callback -- start_mic_capture()
        # used to return only the queue, dropping the stream on the floor.
        mic_stream = None
        try:
            frame_queue, mic_stream = start_mic_capture(AMBIENT_MIC_DEVICE)
            _ambient_listener = AmbientListener(
                frame_queue=frame_queue,
                wake_word_predict=_make_wake_word_predictor(),
                transcribe=_stt.transcribe,
                on_transcript=_dispatch_ambient_transcript,
                threshold=AMBIENT_WAKE_WORD_THRESHOLD,
            )
            _ambient_listener_task = asyncio.create_task(_ambient_listener.run())
            _ambient_listener_task.add_done_callback(_on_ambient_listener_done)
            log.info(f"ambient host-mic listening enabled (device={AMBIENT_MIC_DEVICE or 'default'})")
        except Exception:
            # The mic stream may already be open and pushing frames if the
            # failure happened AFTER start_mic_capture() succeeded (most
            # likely in _make_wake_word_predictor(), which loads real
            # models). Nothing will ever read that queue now, so close the
            # device rather than leaking an open input stream for the
            # process's whole lifetime. Its own try/except so a teardown
            # failure can't mask the original error being logged below.
            if mic_stream is not None:
                try:
                    mic_stream.stop()
                    mic_stream.close()
                except Exception:
                    log.warning("failed to close the ambient mic stream after a startup failure", exc_info=True)
                mic_stream = None
            log.exception(
                "failed to start ambient host-mic listening -- AMBIENT_LISTENING_ENABLED is true but the "
                "mic device could not be opened; the rest of the daemon (click-to-talk STT/TTS) is unaffected"
            )
    else:
        log.info("ambient host-mic listening disabled (AMBIENT_LISTENING_ENABLED is not 'true')")

    loop = asyncio.get_running_loop()
    stop_event = asyncio.Event()

    def signal_handler():
        log.info("shutdown signal received")
        stop_event.set()

    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, signal_handler)

    server = await asyncio.start_unix_server(handle_connection, path=SOCKET_PATH)
    os.chmod(SOCKET_PATH, 0o666)
    log.info(f"voice daemon listening on {SOCKET_PATH}")

    async with server:
        await stop_event.wait()
        log.info("stopping voice daemon socket server...")
        server.close()
        await server.wait_closed()

    # Close active streaming writers cleanly
    if _active_writers:
        log.info(f"closing {len(_active_writers)} active client connections...")
        for writer in list(_active_writers):
            writer.close()
        await asyncio.gather(*(w.wait_closed() for w in _active_writers), return_exceptions=True)

    _cleanup_socket()
    log.info("voice daemon stopped cleanly")


if __name__ == "__main__":
    _prepare_socket_dir()
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        sys.exit(0)
