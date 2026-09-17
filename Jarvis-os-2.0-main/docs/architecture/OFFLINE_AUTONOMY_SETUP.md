# Offline + Autonomous Runtime

This deployment mode treats cloud providers as optional acceleration layers. The local GGUF/llama.cpp service is the primary cognition backend, memory remains usable without embeddings, and scheduled objectives can execute without a cloud API key.

## Required configuration

Copy `.env.example` to `.env` and set:

```dotenv
JARVIS_OFFLINE_MODE=true
LOCAL_TOOL_CALLING=true
JARVIS_AUTONOMY_ENABLED=true
AUTONOMY_INTERVAL_MS=60000
ALLOW_KEYWORD_FALLBACK=false
```

Leave `POSTGRES_HOST` blank when using the supplied Docker Compose stack so the application uses the Compose service name `postgres`.

Set `HOST_MODEL_DIR` and `LOCAL_MODEL_FILE` to a GGUF model that is already present on the host. The compose `llama-cpp` service must be able to load that file; no model download is performed by the runtime.

## What works without the cloud

The cognition router is created even when `GROQ_API_KEYS` and `GEMINI_API_KEYS` are empty. Chat requests can use the local model with tool schemas, and the coding-agent model order starts with the local provider. The execution layer blocks network-backed capabilities while offline mode is enabled.

Memory writes do not require embeddings. Without a configured `LOCAL_EMBEDDING_ENDPOINT`, recall uses deterministic lexical matching over stored memories instead of fabricating vectors.

The scheduler can execute due objectives on its autonomy interval. Objective execution is routed through the existing `AutonomousExecutive`; coding objectives remain subject to its existing consultation/approval gate.

## Voice

The voice daemon entrypoint is `daemon/voice_engine.py`; `daemon/server.py` is now only a compatibility wrapper. Speech models still need to be present in the local cache before strict offline operation is truly first-boot offline. Preload Faster-Whisper/Kokoro assets while online, then run with network disabled.

## Sandbox behavior

When `JARVIS_OFFLINE_MODE=true`, build and chat sandbox containers are started with Docker `--network none`. This prevents package downloads and all other network access during autonomous coding. Online coding explicitly opts out of strict offline mode and restores the previous default-bridge behavior.

## Verification

From the project root:

```bash
python3 -m compileall -q src daemon
npm ci
npm run build
```

A successful `npm run build` is still the authoritative TypeScript verification because the offline repair was performed against the source tree and this archive does not contain a complete installed `node_modules` tree.
