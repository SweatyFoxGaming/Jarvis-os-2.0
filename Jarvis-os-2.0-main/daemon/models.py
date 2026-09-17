"""
Thin wrappers around faster-whisper and kokoro, lazy-loading real model
weights only on first real transcribe/synthesize call -- constructing
SpeechToText/TextToSpeech (e.g. at daemon startup) must stay fast and
never require model weights to be present just to import this module,
which is what keeps voice_engine.py's own import graph testable without
real weights (see tests/test_models.py's injected model_loader).
"""
import logging
import os
import threading
from typing import Callable, Optional

log = logging.getLogger("voice_engine.models")

WHISPER_MODEL_SIZE = "base"  # CPU-appropriate; this sandbox has no GPU
KOKORO_VOICE = "af_heart"
KOKORO_SAMPLE_RATE = 24000  # Kokoro's fixed TTS output sample rate -- see TextToSpeech.synthesize below.


def parse_device_env(raw: Optional[str]) -> "Optional[int | str]":
    """Converts an AMBIENT_MIC_DEVICE/AMBIENT_SPEAKER_DEVICE-style env var
    string into whatever sounddevice actually expects. sounddevice matches
    a `str` device argument by SUBSTRING against device *names*, and only
    treats a real Python `int` as a numeric device index -- passing the
    string "2" through unchanged (as os.environ.get always returns str)
    silently fails to match any device by that literal name rather than
    selecting index 2. .env.example documents this env var as accepting
    "a device name or index", so this coerces the numeric case for real
    while leaving anything else (a device name, or unset/blank) alone.
    """
    if not raw:
        return None
    try:
        return int(raw)
    except ValueError:
        return raw


_AMBIENT_SPEAKER_DEVICE = parse_device_env(os.environ.get("AMBIENT_SPEAKER_DEVICE"))  # None -> sounddevice's system default output device


def _load_whisper_model():
    from faster_whisper import WhisperModel
    log.info(f"loading faster-whisper model '{WHISPER_MODEL_SIZE}' (CPU inference)...")
    return WhisperModel(WHISPER_MODEL_SIZE, device="cpu", compute_type="int8")


def _load_kokoro_model():
    from kokoro import KPipeline
    log.info("loading Kokoro-82M TTS pipeline (CPU inference)...")
    return KPipeline(lang_code="a")


def _load_audio_player_backend():
    import sounddevice as sd
    return sd


class SpeechToText:
    def __init__(self, model_loader: Optional[Callable] = None):
        self._loader = model_loader or _load_whisper_model
        self._model = None
        # transcribe() runs off the event loop via asyncio.to_thread, so
        # multiple connections can call _ensure_loaded() concurrently on
        # separate worker threads. A plain "if self._model is None: load"
        # check-then-set is a race: two threads can both pass the check
        # before either has set self._model, triggering two redundant
        # (44s+, real-weights-downloading) loads instead of one. Guard
        # with a real threading.Lock (not asyncio.Lock -- this runs in
        # worker threads, not on the event loop) using the standard
        # double-checked-locking pattern so the fast path (already loaded)
        # stays lock-free.
        self._load_lock = threading.Lock()

    def _ensure_loaded(self):
        if self._model is None:
            with self._load_lock:
                if self._model is None:
                    self._model = self._loader()
        return self._model

    def transcribe(self, pcm_bytes: bytes) -> str:
        import numpy as np
        model = self._ensure_loaded()
        # 16-bit PCM frames are 2 bytes each; a stray trailing odd byte
        # (e.g. a truncated final chunk) can't form a whole int16 sample,
        # so drop it rather than let np.frombuffer raise ValueError.
        if len(pcm_bytes) % 2 != 0:
            pcm_bytes = pcm_bytes[:-1]
        audio = np.frombuffer(pcm_bytes, dtype=np.int16).astype(np.float32) / 32768.0
        segments, _info = model.transcribe(audio, language="en")
        return " ".join(s.text.strip() for s in segments).strip()


class TextToSpeech:
    def __init__(self, model_loader: Optional[Callable] = None):
        self._loader = model_loader or _load_kokoro_model
        self._model = None
        # Same concurrent-lazy-load race as SpeechToText above -- see that
        # class's __init__ comment for the full explanation.
        self._load_lock = threading.Lock()

    def _ensure_loaded(self):
        if self._model is None:
            with self._load_lock:
                if self._model is None:
                    self._model = self._loader()
        return self._model

    def synthesize(self, text: str) -> bytes:
        # NOTE: the real installed `kokoro` package (0.9.4) has no
        # `.create(text, voice=...)` method -- that shape was guessed from
        # documentation and does not match reality. The real KPipeline
        # instance is *callable*: `model(text, voice=...)` returns a
        # generator of `KPipeline.Result` objects (one per text chunk the
        # pipeline splits on), each carrying `.output.audio`, a
        # `torch.FloatTensor` waveform at Kokoro's fixed 24kHz sample rate.
        # There's no `.create()` and no returned sample rate to unpack.
        import numpy as np
        model = self._ensure_loaded()
        chunks = []
        for result in model(text, voice=KOKORO_VOICE):
            audio_tensor = result.output.audio
            if hasattr(audio_tensor, "detach"):
                audio_np = audio_tensor.detach().cpu().numpy()
            else:
                audio_np = np.asarray(audio_tensor)
            chunks.append(audio_np)
        if not chunks:
            return b""
        audio_np = np.concatenate(chunks).astype(np.float32)
        pcm16 = (np.clip(audio_np, -1.0, 1.0) * 32767.0).astype(np.int16)
        return pcm16.tobytes()


class AudioPlayer:
    """Plays raw int16 PCM directly out a host audio device -- used only by
    the ambient host-mic path (Task 3), which has no caller waiting to
    receive bytes back over the socket, unlike _handle_speak's existing
    stream-back-to-caller behavior. Lazily imports sounddevice (same
    reasoning as _load_whisper_model/_load_kokoro_model above) so importing
    this module never requires PortAudio to be present -- real playback
    only happens if something actually calls play()."""

    def __init__(self, player_loader: Optional[Callable] = None):
        self._loader = player_loader or _load_audio_player_backend
        self._backend = None
        self._load_lock = threading.Lock()
        self._play_lock = threading.Lock()  # Protects concurrent play() calls on the shared audio device

    def _ensure_loaded(self):
        if self._backend is None:
            with self._load_lock:
                if self._backend is None:
                    self._backend = self._loader()
        return self._backend

    def play(self, pcm_bytes: bytes, sample_rate: int) -> None:
        import numpy as np
        backend = self._ensure_loaded()
        audio = np.frombuffer(pcm_bytes, dtype=np.int16)
        with self._play_lock:
            backend.play(audio, samplerate=sample_rate, device=_AMBIENT_SPEAKER_DEVICE)
            backend.wait()
