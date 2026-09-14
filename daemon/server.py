"""Central WebSocket Daemon Server for Jarvis-OS.

Hosts the primary IPC WebSocket endpoint (port 8765), handles incoming renderer
messages, validates schemas and security guardrails, and dispatches tool execution.
"""

import asyncio
import logging
import websockets
from typing import Dict, Any

try:
    from protocol import parse_control_message, ProtocolError, IPCResponse
    from tools.shell import run_shell_command
    from tools.gui import click_at, type_text, send_shortcut
    from tools.perception import capture_screen_base64, get_active_window_info
except ImportError:
    from daemon.protocol import parse_control_message, ProtocolError, IPCResponse
    from daemon.tools.shell import run_shell_command
    from daemon.tools.gui import click_at, type_text, send_shortcut
    from daemon.tools.perception import capture_screen_base64, get_active_window_info
    from daemon.tools.voice import listen_once

log = logging.getLogger("jarvis.server")
HOST = "localhost"
PORT = 8765


async def dispatch_action(action: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    """Routes validated IPC actions to target execution modules."""
    if action == "PING":
        return {"status": "PONG", "alive": True}

    if action == "SHELL":
        command = payload.get("command") or payload.get("cmd") or ""
        return run_shell_command(command)

    if action == "GUI_CLICK":
        x = payload.get("x", 0)
        y = payload.get("y", 0)
        button = payload.get("button", 1)
        return click_at(x, y, button)

    if action == "GUI_TYPE":
        text = payload.get("text", "")
        return type_text(text)

    if action == "GUI_SHORTCUT":
        key = payload.get("key") or payload.get("shortcut") or ""
        return send_shortcut(key)

    if action == "PERCEPTION_WINDOW":
        return get_active_window_info()

    if action == "PERCEPTION_SCREEN":
        return capture_screen_base64()

    if action_type == "VOICE_LISTEN":
    timeout = payload.get("timeout", 10)
    recognized_text = listen_once(timeout_seconds=timeout)
    return {
        "success": True,
        "text": recognized_text
    }

    raise ProtocolError(f"Unsupported action type: '{action}'")


async def handle_connection(websocket):
    log.info(f"IPC Client connected: {websocket.remote_address}")
    try:
        async for raw_message in websocket:
            event_id = "unknown"
            try:
                # 1. Parse message schema and evaluate guardrails
                msg = parse_control_message(raw_message)
                event_id = msg.get("event_id", "unknown")
                action = msg.get("action_type", "")
                payload = msg.get("payload", {})

                # 2. Dispatch action
                result = await dispatch_action(action, payload)
                success = result.get("success", True) if isinstance(result, dict) else True
                error_msg = result.get("stderr") or result.get("error") if not success else None

                response = IPCResponse(
                    event_id=event_id,
                    success=success,
                    result=result,
                    error=error_msg,
                )

            except ProtocolError as pe:
                log.warning(f"Protocol or Security rejection: {pe}")
                response = IPCResponse(
                    event_id=event_id,
                    success=False,
                    error=str(pe),
                )
            except Exception as e:
                log.error(f"Execution handling error: {e}", exc_info=True)
                response = IPCResponse(
                    event_id=event_id,
                    success=False,
                    error=f"Internal Server Error: {str(e)}",
                )

            await websocket.send(response.model_dump_json())

    except websockets.exceptions.ConnectionClosedOK:
        log.info("Client closed connection cleanly.")
    except websockets.exceptions.ConnectionClosedError as e:
        log.warning(f"Client connection closed with error: {e}")


async def main():
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s"
    )
    log.info(f"Starting Jarvis Daemon WebSocket Server on ws://{HOST}:{PORT}")

    async with websockets.serve(handle_connection, HOST, PORT):
        await asyncio.Future()  # Keep server running perpetually


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        log.info("Jarvis Daemon Server stopped by user.")