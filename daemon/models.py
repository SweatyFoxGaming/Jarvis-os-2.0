"""
Thin wrappers around faster-whisper and kokoro, lazy-loading real model
weights only on first real transcribe/synthesize call -- constructing
SpeechToText/TextToSpeech (e.g. at daemon startup) must stay fast and
never require model weights to be present just to import this module,
which is what keeps voice_engine.py's own import graph testable without
real weights (see tests/test_models.py's injected model_loader).
"""
import logging
import threading
from typing import Callable, Optional

log = logging.getLogger("voice_engine.models")

WHISPER_MODEL_SIZE = "base"  # CPU-appropriate; this sandbox has no GPU
KOKORO_VOICE = "af_heart"


def _load_whisper_model():
    from faster_whisper import WhisperModel
    log.info(f"loading faster-whisper model '{WHISPER_MODEL_SIZE}' (CPU inference)...")
    return WhisperModel(WHISPER_MODEL_SIZE, device="cpu", compute_type="int8")


def _load_kokoro_model():
    from kokoro import KPipeline
    log.info("loading Kokoro-82M TTS pipeline (CPU inference)...")
    return KPipeline(lang_code="a")


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
