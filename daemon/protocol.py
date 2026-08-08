"""
Pure, model-free protocol layer for the voice daemon -- newline-delimited
JSON control messages plus base64-encoded PCM audio chunks over a Unix
socket. Deliberately has zero dependency on faster-whisper/kokoro so this
whole module (and its tests) never needs real model weights loaded.
"""
import base64
import binascii
import json


class ProtocolError(Exception):
    """Raised on any malformed control message or audio chunk -- callers
    must catch this and continue the connection, never crash the daemon
    over one bad message."""


def parse_control_message(line: str) -> dict:
    stripped = line.strip()
    if not stripped:
        raise ProtocolError("empty control message line")
    try:
        result = json.loads(stripped)
    except json.JSONDecodeError as e:
        raise ProtocolError(f"malformed JSON control message: {e}") from e
    if not isinstance(result, dict):
        raise ProtocolError(f"control message must be a JSON object, got {type(result).__name__}")
    return result


def encode_audio_chunk(pcm_bytes: bytes) -> str:
    return base64.b64encode(pcm_bytes).decode("ascii")


def decode_audio_chunk(b64: str) -> bytes:
    try:
        return base64.b64decode(b64, validate=True)
    except (binascii.Error, ValueError) as e:
        raise ProtocolError(f"malformed base64 audio chunk: {e}") from e


class UtteranceEndDetector:
    """Pure silence-duration logic, no audio analysis of its own -- the
    caller (the real STT loop, wired to an actual VAD/energy check against
    real audio frames) decides is_speech per frame and feeds it in here.
    Fires exactly once per utterance, the instant sustained silence
    following real speech crosses the threshold. Silence before any speech
    has occurred is never treated as an utterance ending, since there was
    no utterance to end."""

    def __init__(self, silence_frames_threshold: int = 15):
        self.silence_frames_threshold = silence_frames_threshold
        self._has_seen_speech = False
        self._consecutive_silence = 0

    def feed(self, is_speech: bool) -> bool:
        if is_speech:
            self._has_seen_speech = True
            self._consecutive_silence = 0
            return False
        if not self._has_seen_speech:
            return False
        self._consecutive_silence += 1
        if self._consecutive_silence >= self.silence_frames_threshold:
            # Reset so the SAME detector instance can be reused for the
            # next utterance in the same connection, rather than requiring
            # the caller to construct a fresh one every time.
            self._has_seen_speech = False
            self._consecutive_silence = 0
            return True
        return False

    def reset(self) -> None:
        """Clears any in-progress utterance state. Used when the buffer
        this detector was watching gets consumed by something other than
        the detector's own silence trigger -- e.g. an explicit one-shot
        "transcribe" request (see voice_engine.py's _handle_transcribe) --
        so stale "has seen speech"/silence-count state doesn't leak into
        whatever comes next on the same connection."""
        self._has_seen_speech = False
        self._consecutive_silence = 0
