import asyncio
import logging
from daemon.registry import ipc_action

log = logging.getLogger("jarvis.handlers.system")

@ipc_action("PING")
async def handle_ping(payload: dict) -> dict:
    """Health check ping/pong."""
    return {"status": "PONG", "alive": True}

@ipc_action("SHELL")
async def handle_shell(payload: dict) -> dict:
    """Execute a shell command asynchronously."""
    command = payload.get("command")
    if not command:
        raise ValueError("Missing required parameter: 'command'")

    log.info(f"Executing shell command: {command}")
    
    proc = await asyncio.create_subprocess_shell(
        command,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE
    )

    stdout, stderr = await proc.communicate()

    return {
        "returncode": proc.returncode,
        "stdout": stdout.decode("utf-8", errors="replace"),
        "stderr": stderr.decode("utf-8", errors="replace")
    }