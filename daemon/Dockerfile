# Matches the daemon's own dev venv (see daemon/venv), which was built
# against Python 3.11.
FROM python:3.11-slim

# espeak-ng: improves TTS quality for out-of-dictionary English words.
# models.py's _load_kokoro_model() calls KPipeline(lang_code="a") (hardcoded
# American English). In the installed kokoro package, pipeline.py's
# __init__ wraps espeak.EspeakFallback(...) in try/except for lang_code in
# 'ab' -- without espeak-ng that just logs "EspeakFallback not Enabled: OOD
# words will be skipped" and proceeds with fallback=None, it does not raise.
# (The unconditional, raising espeak.EspeakG2P(...) call only fires for
# lang_code in 'efhip' -- Spanish/French/Hindi/Italian/Portuguese -- none of
# which this daemon uses.) So this is a quality/robustness improvement, not
# a hard runtime dependency for synthesize() to succeed.
RUN apt-get update && apt-get install -y --no-install-recommends \
    espeak-ng \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# CPU-only torch, installed explicitly and first: kokoro (below) depends on
# torch but doesn't pin it, and plain PyPI's default "torch" wheel is the
# CUDA/GPU build -- it drags in several GB of nvidia-*/triton CUDA toolkit
# packages (nvidia-cudnn, nvidia-cublas, nvidia-nccl, etc.) that this
# container has no use for: it runs faster-whisper/Kokoro CPU inference
# only, and this stack has no GPU (confirmed at this plan's own research
# phase -- no nvidia-smi). Live-verified (Task 9): pulling from PyPI's
# default index resolved the GPU build and made `docker compose build`
# exceed an hour before being canceled mid-download; pointing pip at
# PyTorch's own CPU wheel index instead resolves torch==<version>+cpu with
# zero nvidia-* packages, verified via `pip install --dry-run`. This must
# run as its own step, before installing requirements.txt below, so pip
# already has a satisfying "torch" installed by the time kokoro's unpinned
# dependency on it is resolved -- once satisfied, pip won't reach back to
# PyPI's default index and pull the GPU build.
RUN pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu

# Copy dependency manifest first to leverage Docker layer caching.
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Only the modules voice_engine.py actually imports at runtime -- not
# venv/, tests/, or pytest.ini, which are dev-only (see voice_engine.py's
# own `from protocol import ...` / `from models import ...`).
COPY voice_engine.py models.py protocol.py ./

CMD ["python3", "voice_engine.py"]
