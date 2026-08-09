# Use official Node.js 20 lightweight Alpine image
FROM node:20-alpine

# Install Python 3, pip, bash, and ffmpeg for scripting/audio decoding.
# ffmpeg is a real runtime prerequisite of THIS image, not daemon/Dockerfile
# (a separate container) -- src/interaction/whisper.ts spawns ffmpeg
# in-process to decode browser-recorded audio (webm/opus/ogg/wav) to raw
# 16-bit PCM before sending it to the voice daemon over the Unix socket.
# Without it here, /api/voice-input's ffmpeg spawn fails with ENOENT in
# production and silently falls back to a canned "Simulated speech
# transcription" stub -- this was live-verified missing (C1 finding).
RUN apk add --no-cache python3 py3-pip bash ffmpeg

# Set working directory inside the container
WORKDIR /app

# Copy dependency manifests first to leverage Docker layer caching
COPY package*.json ./

# Install packages (including devDependencies like tsx for executing TypeScript directly)
RUN npm install

# Copy requirements file first for caching
COPY requirements.txt ./

# Install python dependencies
RUN pip3 install --no-cache-dir -r requirements.txt --break-system-packages || pip3 install --no-cache-dir -r requirements.txt

# Copy the rest of the application files
COPY . .

# Expose port 8000 (FastAPI gateway) and 3000 (Express API)
EXPOSE 8000 3000

# /health now reports the real state of the Express subprocess (200 while
# starting/healthy, 503 once it's given up after repeated crashes — see
# src/api.py) instead of always claiming "up", so this can actually catch
# the failure mode that previously went unnoticed: the container itself
# staying "Up" in `docker ps` while the app inside it was crash-looping.
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD wget --spider -q http://127.0.0.1:8000/health || exit 1

# Drop root privileges for the actual running process — without this,
# every file the app writes into the bind-mounted Obsidian vault /
# jarvis-files directories (see docker-compose.yml's volumes:) lands
# root-owned on the host, later blocking the host's own ubuntu user from
# modifying/deleting them. uid/gid 1000 is this image's built-in "node"
# account AND matches the host's "ubuntu" user exactly (confirmed via
# `id ubuntu` and `docker run --rm node:20-alpine id node`), so files
# written through those mounts land with correct host ownership instead.
# Must come after every RUN step above (apk/npm/pip installs all need root).
USER node

# Default command starts the FastAPI Gateway, which spawns the Node.js Express server on startup
CMD ["python3", "-m", "uvicorn", "src.api:app", "--host", "0.0.0.0", "--port", "8000"]
