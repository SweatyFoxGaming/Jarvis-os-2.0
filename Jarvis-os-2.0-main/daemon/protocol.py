import base64
import binascii
import json

MAX_AUDIO_CHUNK_BYTES = 5 * 1024 * 1024  # 5 MB limit per audio chunk


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
    if "type" not in result:
        raise ProtocolError("control message missing required 'type' field")
    return result


def encode_audio_chunk(pcm_bytes: bytes) -> str:
    return base64.b64encode(pcm_bytes).decode("ascii")


def decode_audio_chunk(b64: str, max_bytes: int = MAX_AUDIO_CHUNK_BYTES) -> bytes:
    if len(b64) > (max_bytes * 4 // 3) + 4:
        raise ProtocolError(f"audio payload exceeds maximum size limit of {max_bytes} bytes")
    try:
        return base64.b64decode(b64, validate=True)
    except (binascii.Error, ValueError) as e:
        raise ProtocolError(f"malformed base64 audio chunk: {e}") from e


class UtteranceEndDetector:
    """Pure silence-duration logic, no audio analysis of its own -- the
    caller decides is_speech per frame and feeds it in here. Fires exactly
    once per utterance, the instant sustained silence following real speech
    crosses the threshold."""

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
            self.reset()
            return True
        return False

    def reset(self) -> None:
        """Clears any in-progress utterance state."""
        self._has_seen_speech = False
        self._consecutive_silence = 0
