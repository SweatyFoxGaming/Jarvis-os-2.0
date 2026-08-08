# Matches the daemon's own dev venv (see daemon/venv), which was built
# against Python 3.11.
FROM python:3.11-slim

# espeak-ng: a real system-level runtime dependency of kokoro's misaki G2P
# backend (daemon/venv/.../kokoro/pipeline.py does `from misaki import en,
# espeak` and calls into it for every synthesize() call), not just a build
# nicety -- TextToSpeech.synthesize() in models.py will fail at first use
# without it, even though `pip install -r requirements.txt` succeeds fine.
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
