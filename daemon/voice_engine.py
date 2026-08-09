"""
Unix socket server for the local voice daemon. STT/TTS only -- this file
and everything it imports never calls an LLM, never does tool-calling,
never touches memory or the knowledge graph. That boundary lives entirely
in TypeScript (src/core/audio-client.ts + the voice-session handler);
violating it here recreates the duplication the design spec explicitly
rejected.

Protocol: newline-delimited JSON control messages, base64 PCM audio
chunks. See protocol.py for the pure parsing/framing logic this file
wires up to real socket I/O and (in a later task) real model inference.
"""
import asyncio
import json
import logging
import os
import sys

import numpy as np

from protocol import (
    ProtocolError,
    UtteranceEndDetector,
    decode_audio_chunk,
    encode_audio_chunk,
    parse_control_message,
)
from models import SpeechToText, TextToSpeech

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("voice_engine")

SOCKET_PATH = os.environ.get("VOICE_DAEMON_SOCKET", "/tmp/jarvis-voice/voice.sock")

# Below this int16 RMS energy, an audio_chunk frame is treated as silence
# for utterance-end detection purposes. Not a real VAD model -- a cheap
# energy gate is enough to drive UtteranceEndDetector, and keeps this file
# free of any additional model dependency beyond STT/TTS themselves.
SILENCE_RMS_THRESHOLD = 500

# Outgoing "speak" audio is split into chunks this size (bytes of raw PCM,
# pre-base64) so a long synthesized utterance doesn't arrive as one huge
# line on the socket.
SPEAK_CHUNK_BYTES = 32000

# Hard cap on how large a single connection's utterance_buffer is allowed to
# grow, in bytes of raw 16-bit mono 16kHz PCM. Byte math: 16000 samples/sec
# * 2 bytes/sample (int16) = 32000 bytes/sec of audio; capping at 2 minutes
# of continuous audio (120s * 32000 bytes/sec = 3,840,000 bytes, ~3.7MiB)
# comfortably covers any real utterance/recorded clip while still bounding
# memory if a streaming connection's silence detector never fires (e.g.
# genuinely continuous quiet background noise below SILENCE_RMS_THRESHOLD,
# or a misbehaving audio source that never stops sending audio_chunk/
# audio_data messages) -- without this, that buffer grows unbounded for the
# entire life of the connection.
MAX_UTTERANCE_BYTES = 2 * 60 * 32000

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
        # The silence detector never fired and the buffer has grown past
        # the cap -- force-flush rather than let it grow unbounded for the
        # rest of the connection's life. Transcribe whatever's accumulated
        # so far, exactly as if a real utterance boundary had just been
        # detected, and reset both the buffer and the detector so the next
        # audio_chunk starts a clean new utterance.
        log.warning(
            f"utterance_buffer for {peer} exceeded MAX_UTTERANCE_BYTES "
            f"({len(utterance_buffer)} > {MAX_UTTERANCE_BYTES}) without the "
            "silence detector firing; force-flushing"
        )
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
    """One-shot counterpart to _handle_audio_chunk's buffering -- appends
    decoded PCM to utterance_buffer WITHOUT ever calling
    UtteranceEndDetector.feed(). Reserved exclusively for the one-shot
    /api/voice-input path (see _handle_transcribe below): that path
    already knows exactly when its clip is complete (the client's own
    explicit "transcribe" message) and must never have the silence-based
    auto-trigger built for the continuous mic-stream flow fire early and
    hand back a truncated transcript -- e.g. a long trailing pause in a
    recorded clip, before the browser got around to sending "transcribe",
    must not be mistaken for "utterance ended, respond now." Using a
    distinct message type (rather than reusing "audio_chunk") makes that
    guarantee structural instead of a race between two possible triggers.
    """
    try:
        pcm = decode_audio_chunk(msg.get("data", ""))
    except ProtocolError as e:
        log.warning(f"malformed audio_data from {peer}, ignoring: {e}")
        return
    utterance_buffer.extend(pcm)

    if len(utterance_buffer) > MAX_UTTERANCE_BYTES:
        # Unlike _handle_audio_chunk's force-flush, this path can't just
        # transcribe early: a caller here (e.g. /api/voice-input's one-shot
        # flow) is waiting on the FIRST "transcript" reply after its own
        # explicit "transcribe" message (see transcribeOverSocket in
        # src/core/audio-client.ts) -- writing one now would resolve that
        # promise early with a truncated/wrong result. Instead, drop the
        # oldest bytes and keep only the most recent MAX_UTTERANCE_BYTES,
        # bounding memory while still producing *a* transcript (of the tail
        # of the clip) once "transcribe" actually arrives, rather than
        # letting the buffer grow unbounded for a malformed/oversized
        # client that never sends "transcribe" at all.
        overflow = len(utterance_buffer) - MAX_UTTERANCE_BYTES
        log.warning(
            f"utterance_buffer for {peer} exceeded MAX_UTTERANCE_BYTES via "
            f"audio_data ({len(utterance_buffer)} > {MAX_UTTERANCE_BYTES}); "
            f"dropping the oldest {overflow} bytes"
        )
        del utterance_buffer[:overflow]


async def _handle_transcribe(
    writer: asyncio.StreamWriter,
    detector: UtteranceEndDetector,
    utterance_buffer: bytearray,
    peer: str,
) -> None:
    """Explicit one-shot request: transcribe whatever audio has already
    been sent on this connection via audio_data messages, right now. This
    is the one-shot counterpart to the continuous mic-stream flow in
    _handle_audio_chunk (where the daemon itself decides an utterance has
    ended from live silence): a caller that already has a complete,
    pre-recorded clip -- e.g. /api/voice-input's click-to-talk fallback --
    sends the whole clip as audio_data message(s) and then this message to
    get one transcription back immediately.

    Resets detector state too, as a defensive measure in case a connection
    ever mixes audio_chunk and audio_data traffic: the buffer this
    consumes might overlap with what the detector was watching, so leaving
    stale "has seen speech"/silence-count state around could make a
    subsequent audio_chunk on a reused connection trigger prematurely.
    """
    pcm_for_utterance = bytes(utterance_buffer)
    utterance_buffer.clear()
    detector.reset()
    await _run_transcription(writer, pcm_for_utterance, peer)


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


async def handle_connection(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    peer = writer.get_extra_info("peername") or "unix-client"
    log.info(f"connection opened: {peer}")
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
            elif msg_type == "transcribe":
                await _handle_transcribe(writer, detector, utterance_buffer, peer)
            else:
                log.info(f"received control message: {msg_type}")
    except (ConnectionResetError, BrokenPipeError):
        log.info(f"connection reset: {peer}")
    finally:
        writer.close()
        log.info(f"connection closed: {peer}")


def _remove_stale_socket() -> None:
    """Ensure SOCKET_PATH's parent directory exists and delete any
    pre-existing file left there by a previous run, before this run does
    anything else. Split out of main() and called from the
    `__main__` guard below, before asyncio.run(main()) even spins up an
    event loop, so the stale file is gone from the very first instant this
    process starts -- not just "before we bind the new socket" a few
    lines into an async function.

    Why this matters: docker-compose.yml's voice-daemon healthcheck only
    checks whether a file exists at SOCKET_PATH -- it can't tell a live
    socket from a leftover one. On the very first-ever start there's no
    stale file, so that's not a problem. On a RESTART, though, if the old
    file were still sitting on the persistent voice-socket volume for any
    stretch of this run's startup, the healthcheck would report healthy
    off the previous run's leftovers while this run isn't actually
    listening yet -- the exact race the healthcheck exists to catch, just
    moved from "first start" to "restart". Removing it here, first, closes
    that off. In practice the window this guards is already small: unlike
    what an earlier revision of this comment assumed, daemon/models.py
    lazy-loads the real faster-whisper/Kokoro/torch weights only on the
    first real transcribe/synthesize call (see its docstring), never at
    daemon startup, so there's no multi-tens-of-seconds import gate
    between process start and socket bind on either a first start or a
    restart. Doing this first is defense-in-depth, not a fix for a large
    observed window.
    """
    socket_dir = os.path.dirname(SOCKET_PATH)
    os.makedirs(socket_dir, exist_ok=True)
    if os.path.exists(SOCKET_PATH):
        os.remove(SOCKET_PATH)


async def main() -> None:
    server = await asyncio.start_unix_server(handle_connection, path=SOCKET_PATH)
    # daemon/Dockerfile has no USER directive, so this process runs as root
    # and start_unix_server() creates the socket file with a default mode
    # of 0777 & ~umask -- Docker's default umask (0022) yields 0755,
    # root-owned. The api container runs as uid 1000 (USER node, see the
    # repo-root Dockerfile) and falls under "other" permissions on that
    # file, which lack write access; Linux requires WRITE permission on a
    # Unix-domain-socket file to connect() to it, so every real
    # container-to-container voice call would otherwise fail with EACCES.
    # Explicitly widening to 0666 makes this work regardless of which user
    # either container's process runs as, or what the host's umask is.
    os.chmod(SOCKET_PATH, 0o666)
    log.info(f"voice daemon listening on {SOCKET_PATH}")
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    _remove_stale_socket()
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        sys.exit(0)
