import asyncio
import json
import logging
import os
import signal
import sys
from typing import Set

import numpy as np

from models import SpeechToText, TextToSpeech
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

_stt = SpeechToText()
_tts = TextToSpeech()
_inference_lock = asyncio.Lock()

# Track active client writers so we can gracefully close them on shutdown
_active_writers: Set[asyncio.StreamWriter] = set()


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
    try:
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
    try:
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
            elif msg_type == "transcribe":
                await _handle_transcribe(writer, detector, utterance_buffer, peer)
            else:
                log.info(f"received control message: {msg_type}")
    except (ConnectionResetError, BrokenPipeError):
        log.info(f"connection reset: {peer}")
    except asyncio.CancelledError:
        pass
    finally:
        _active_writers.discard(writer)
        writer.close()
        await writer.wait_closed()
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


async def main() -> None:
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
