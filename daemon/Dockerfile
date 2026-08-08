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

# Copy dependency manifest first to leverage Docker layer caching.
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Only the modules voice_engine.py actually imports at runtime -- not
# venv/, tests/, or pytest.ini, which are dev-only (see voice_engine.py's
# own `from protocol import ...` / `from models import ...`).
COPY voice_engine.py models.py protocol.py ./

CMD ["python3", "voice_engine.py"]
