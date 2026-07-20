import os
import sys
import subprocess
import threading
import socket
import time
import json
import logging
import asyncio
from typing import Any, Dict, List
import urllib.request
import urllib.error

# Check for FastAPI. If not present, log a warning (though it should be in the user's environment)
try:
    from fastapi import FastAPI, Request, Response, HTTPException
    from fastapi.middleware.cors import CORSMiddleware
    from fastapi.responses import JSONResponse, StreamingResponse
except ImportError:
    print("[Gateway] FastAPI is not installed. Please run 'pip install fastapi uvicorn requests'")
    # Create mock classes so the script compiles if run directly in other contexts
    class FastAPI:
        def __init__(self, *args, **kwargs): pass
        def add_middleware(self, *args, **kwargs): pass
        def api_route(self, *args, **kwargs):
            def decorator(func): return func
            return decorator
        def get(self, *args, **kwargs):
            def decorator(func): return func
            return decorator
        def on_event(self, *args, **kwargs):
            def decorator(func): return func
            return decorator
    class Request: pass
    class Response: pass
    class HTTPException(Exception):
        def __init__(self, status_code: int, detail: str = ""):
            self.status_code = status_code
            self.detail = detail
    class JSONResponse: pass
    class StreamingResponse: pass
    class CORSMiddleware: pass

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("jarvis-gateway")

app = FastAPI(
    title="JARVIS Cognitive Gateway",
    description="Deterministic Python-to-TypeScript Proxy Gateway",
    version="1.8.0"
)

# Wildcard origins combined with allow_credentials=True makes Starlette
# reflect the caller's actual Origin header (browsers reject a literal
# wildcard + credentials response), which effectively allows any site to
# make credentialed cross-origin requests. Use an explicit allowlist instead.
ALLOWED_ORIGINS = [
    o.strip()
    for o in os.environ.get("ALLOWED_ORIGINS", "http://localhost:8000,http://localhost:3000").split(",")
    if o.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

NODE_PORT = 3000
NODE_URL = f"http://127.0.0.1:{NODE_PORT}"

# Thread-safe variable to track Node.js server process
node_process = None

# Real health state for the Express subprocess, so /health can report the
# truth instead of always saying "up". Previously /health fell back to a
# hardcoded {"status": "up"} whenever the proxy call failed for ANY reason,
# including "Node has been crash-looping for 20 minutes" — live-observed:
# the Express server crashed on every boot for 18+ minutes (a missing
# npm dependency) while docker ps and this endpoint both reported healthy.
GATEWAY_START_TIME = time.time()
STARTUP_GRACE_SECONDS = 30  # Node normally binds its port within a few seconds
MAX_CONSECUTIVE_BOOT_FAILURES = 5
node_supervisor_status = "starting"  # "starting" | "healthy" | "crash_looping" | "given_up"
node_consecutive_boot_failures = 0
node_last_exit_code: int | None = None

def is_node_running() -> bool:
    """Check if the Node.js server is already running on port 3000."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(0.5)
            return s.connect_ex(('127.0.0.1', NODE_PORT)) == 0
    except Exception:
        return False

def log_stream(stream, prefix):
    for line in iter(stream.readline, ''):
        logger.info(f"[{prefix}] {line.strip()}")

def spawn_node_process():
    """Spawn 'npm run start' once and wire up its output streams. Returns the Popen, or None on failure."""
    global node_process
    try:
        node_process = subprocess.Popen(
            ["npm", "run", "start"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1
        )
        threading.Thread(target=log_stream, args=(node_process.stdout, "Express-Out"), daemon=True).start()
        threading.Thread(target=log_stream, args=(node_process.stderr, "Express-Err"), daemon=True).start()
        return node_process
    except Exception as e:
        logger.error("[Gateway] Failed to start Node.js server subprocess: %s", e)
        return None

def supervise_node_server():
    """
    Background thread that spawns the Express server and keeps restarting it
    (with exponential backoff) if it ever exits. Without this, a crash in the
    Node process left the FastAPI gateway silently serving Python fallback
    mock responses forever, since Docker's restart policy only sees the
    top-level container process (uvicorn), not the Node subprocess.
    """
    global node_process, node_supervisor_status, node_consecutive_boot_failures, node_last_exit_code

    # Wait a moment for uvicorn to bind
    time.sleep(1.0)

    if is_node_running():
        logger.info("[Gateway] Express server already active on port %s. Proxying enabled.", NODE_PORT)
        node_supervisor_status = "healthy"
        return

    logger.info("[Gateway] Checking for Node.js runtime to launch Express server...")
    try:
        subprocess.run(["node", "--version"], capture_output=True, check=True)
    except Exception:
        logger.warning("[Gateway] Node.js runtime not found in this container. Running in Python fallback simulation mode.")
        node_supervisor_status = "given_up"
        return

    if not os.path.exists("package.json"):
        logger.warning("[Gateway] package.json not found in workspace. Express server cannot be launched.")
        node_supervisor_status = "given_up"
        return

    backoff_seconds = 2
    max_backoff_seconds = 60

    while True:
        logger.info("[Gateway] Spawning TypeScript/Express server via 'npm run start'...")
        proc = spawn_node_process()
        if proc is None:
            node_consecutive_boot_failures += 1
            if node_consecutive_boot_failures >= MAX_CONSECUTIVE_BOOT_FAILURES:
                node_supervisor_status = "given_up"
                logger.error(
                    "[Gateway] Failed to spawn the Express server process %d times in a row. "
                    "Giving up automatic restarts — fix the underlying error and restart the container.",
                    node_consecutive_boot_failures
                )
                return
            node_supervisor_status = "crash_looping"
            time.sleep(backoff_seconds)
            backoff_seconds = min(backoff_seconds * 2, max_backoff_seconds)
            continue

        started = False
        for _ in range(10):
            time.sleep(1.0)
            if is_node_running():
                logger.info("[Gateway] Express server successfully launched and active on port %s.", NODE_PORT)
                started = True
                break
        if not started:
            logger.warning("[Gateway] Express server process spawned but port %s remains unreachable.", NODE_PORT)

        if started:
            backoff_seconds = 2  # reset backoff after a healthy start
            node_consecutive_boot_failures = 0
            node_supervisor_status = "healthy"
        else:
            node_consecutive_boot_failures += 1
            node_supervisor_status = "crash_looping"

        exit_code = proc.wait()  # blocks until the Node process actually dies
        node_last_exit_code = exit_code
        logger.warning(
            "[Gateway] Express server process exited (code %s). Restarting in %ss...",
            exit_code, backoff_seconds
        )

        if node_consecutive_boot_failures >= MAX_CONSECUTIVE_BOOT_FAILURES:
            node_supervisor_status = "given_up"
            logger.error(
                "[Gateway] Express server failed to stay up %d times in a row (last exit code %s). "
                "Giving up automatic restarts — fix the underlying error (see Express-Err logs above) "
                "and restart the container manually once it's resolved.",
                node_consecutive_boot_failures, exit_code
            )
            return

        time.sleep(backoff_seconds)
        backoff_seconds = min(backoff_seconds * 2, max_backoff_seconds)

@app.on_event("startup")
async def on_startup():
    """Trigger the Express server initialization (with crash supervision) on startup."""
    threading.Thread(target=supervise_node_server, daemon=True).start()

@app.on_event("shutdown")
async def on_shutdown():
    """Terminate the Node.js background process on gateway shutdown."""
    global node_process
    if node_process:
        logger.info("[Gateway] Terminating background Node.js server...")
        try:
            node_process.terminate()
            node_process.wait(timeout=2.0)
            logger.info("[Gateway] Node.js server terminated.")
        except Exception as e:
            logger.warning("[Gateway] Error terminating Node.js process: %s", e)

def make_proxy_request(path: str, method: str, headers: Dict[str, str], body: bytes = None) -> Response:
    """Helper to perform synchronous HTTP proxying to the Node.js backend using urllib."""
    target_url = f"{NODE_URL}{path}"
    
    # Filter and construct headers to pass through
    excluded_headers = {'host', 'connection', 'content-length'}
    proxy_headers = {
        k: v for k, v in headers.items() if k.lower() not in excluded_headers
    }
    
    req = urllib.request.Request(
        url=target_url,
        data=body,
        headers=proxy_headers,
        method=method
    )
    
    try:
        with urllib.request.urlopen(req, timeout=120) as response:
            res_body = response.read()
            res_status = response.getcode()
            res_headers = dict(response.info())
            
            # Filter response headers
            final_headers = {}
            for k, v in res_headers.items():
                if k.lower() not in {'content-encoding', 'transfer-encoding', 'content-length', 'connection'}:
                    final_headers[k] = v
                    
            return Response(
                content=res_body,
                status_code=res_status,
                headers=final_headers
            )
    except urllib.error.HTTPError as e:
        # Pass through the target server's exact error
        try:
            err_body = e.read()
            return Response(content=err_body, status_code=e.code)
        except Exception:
            return Response(content=json.dumps({"error": str(e)}), status_code=e.code, media_type="application/json")
    except urllib.error.URLError as e:
        # Node server is likely offline or unreachable, raise to trigger fallback
        raise e

# ---------- FALLBACK SIMULATION ROUTER ----------
# This router acts as a fallback if the Express server is offline or unreachable.

def get_simulated_kernel():
    return {
        "state": {
            "executiveStatus": "Idle",
            "currentThought": "Reflecting on digital twins",
            "currentPlan": ["Awaiting instructions"],
            "attentionTarget": "User Console"
        },
        "attention": "Idle Reflection",
        "thoughtStage": "Idle",
        "thoughtStages": ["Idle", "Analyzing", "Synthesizing", "Reflecting"],
        "dialogueHistory": [],
        "summarizedDecision": "Operational stability confirmed in fallback mode.",
        "confidence": 100
    }

def get_simulated_metrics():
    return {
        "system": {
            "cpuUsagePercent": 2.4,
            "freeMemoryMb": 8192,
            "totalMemoryMb": 16384
        },
        "metrics": {
            "totalRequests": 10,
            "geminiApiCalls": 0,
            "errorsCount": 0
        },
        "status": "green"
    }

def get_simulated_workspace():
    return {
        "conversation": {
            "messages": []
        },
        "goals": [],
        "tasks": []
    }

@app.get("/health")
async def health_check(request: Request):
    """
    Health check proxy — reports the REAL state of the Express subprocess,
    not just whether uvicorn itself is alive. Previously this always
    returned {"status": "up"} whenever the proxy call failed for any
    reason, so a fully crash-looping Express server (e.g. a missing npm
    dependency) was indistinguishable from a genuinely healthy one to
    anything checking this endpoint or `docker ps`/HEALTHCHECK.
    """
    if is_node_running():
        try:
            # make_proxy_request is a blocking urllib call — run it in a
            # worker thread so a slow/hung Express response (e.g. a 100+s
            # local LLM generation, the documented normal case for this
            # project) can't stall the single-worker asyncio event loop and
            # freeze every other concurrent request through this gateway.
            # Live-verified this was a real bug: a slow request in flight
            # made even /api/status hang indefinitely for everyone else.
            return await asyncio.to_thread(make_proxy_request, "/health", "GET", dict(request.headers))
        except Exception:
            pass

    # Node isn't reachable. Give a fresh boot a real grace period (npm
    # install/tsx startup genuinely takes a few seconds) before reporting
    # unhealthy — but once past that window, or once the supervisor has
    # explicitly given up, say so instead of pretending everything's fine.
    uptime = time.time() - GATEWAY_START_TIME
    if node_supervisor_status == "given_up":
        return JSONResponse(
            status_code=503,
            content={
                "status": "down",
                "mode": "python-fallback",
                "engine_ready": False,
                "reason": "Express server repeatedly failed to start and automatic restarts were stopped.",
                "last_exit_code": node_last_exit_code,
            },
        )
    if uptime < STARTUP_GRACE_SECONDS:
        return {"status": "starting", "mode": "python-fallback", "engine_ready": False}
    return JSONResponse(
        status_code=503,
        content={
            "status": "down",
            "mode": "python-fallback",
            "engine_ready": False,
            "reason": "Express server is not currently reachable.",
            "supervisor_status": node_supervisor_status,
            "last_exit_code": node_last_exit_code,
        },
    )

@app.get("/props")
async def props_check(request: Request):
    """Props check proxy with automatic fallback."""
    if is_node_running():
        try:
            return await asyncio.to_thread(make_proxy_request, "/props", "GET", dict(request.headers))
        except Exception:
            pass
    return {"status": "up", "version": "1.8.0", "engine_ready": True}

@app.api_route("/api/{path_name:path}", methods=["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"])
async def wildcard_api_proxy(path_name: str, request: Request):
    """Universal API router that proxies all requests to Node.js, falling back to simulated logic if unreachable."""
    body = await request.body()

    # Try proxying to Express server
    if is_node_running():
        try:
            forward_path = request.url.path
            if request.url.query:
                forward_path = f"{forward_path}?{request.url.query}"
            # See health_check() above for why this runs in a thread rather
            # than being called directly.
            return await asyncio.to_thread(
                make_proxy_request,
                forward_path,
                request.method,
                dict(request.headers),
                body if body else None
            )
        except Exception as e:
            logger.warning("[Gateway] Failed to proxy to Express backend. Falling back to python mock responses. Error: %s", e)

    # Express server is unreachable - implement fallback handlers for critical endpoints
    path = request.url.path.rstrip("/")
    
    if path == "/api/cognition/kernel":
        return get_simulated_kernel()
        
    elif path == "/api/observation/metrics":
        return get_simulated_metrics()
        
    elif path == "/api/observation/telemetry":
        return []
        
    elif path == "/api/observation/audit":
        return []
        
    elif path == "/api/cognition/workspace":
        return get_simulated_workspace()
        
    elif path == "/api/observation/diagnostics":
        return {
            "status": "healthy",
            "checks": {
                "kernel": "simulation_fallback",
                "workspace": "simulation_fallback",
                "memory": "simulation_fallback"
            }
        }
        
    elif path == "/api/learning/dashboard":
        return {
            "style": "Balanced",
            "mistakes": [],
            "stats": {"totalConcepts": 0, "correctRatio": 1.0}
        }
        
    elif path == "/api/memory/pending":
        return []
        
    elif path == "/api/chat":
        # Handle chat requests with a friendly placeholder explaining the fallback
        try:
            body_json = json.loads(body)
            message = body_json.get("message", "")
        except Exception:
            message = ""
            
        async def mock_stream():
            sim_reply = f"[Gateway Fallback] Received: '{message}'. Node.js server is offline or loading. Operating in Python fallback simulation mode."
            for word in sim_reply.split(" "):
                yield f"data: {word} \n\n"
                await asyncio.sleep(0.04)

        return StreamingResponse(mock_stream(), media_type="text/event-stream")

    elif path == "/api/voice-input":
        return {"transcription": "Configure process.env.GEMINI_API_KEY to activate voice services."}

    elif path == "/api/status":
        return {
            "cpu": 2.4,
            "ram_available_mb": 8192,
            "disk": 38,
            "engine_ready": True,
            "user": "admin"
        }

    # Default fallback for unhandled endpoints to prevent 404
    return {"message": "Service operational in simulation mode.", "endpoint": path}
