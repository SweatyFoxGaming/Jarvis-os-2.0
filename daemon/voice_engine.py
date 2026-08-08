"""
Unix socket server for the local voice daemon. STT/TTS only -- this file
and everything it imports never calls an LLM, never does tool-calling,
never touches memory or the knowledge graph. That boundary lives entirely
in TypeScript (src/core/audio-client.ts + the voice-session handler);
violating it here recreates the duplication the design spec explicitly
rejected.

Protocol: newline-delimited JSON control messages, base64 PCM audio
chunks. See protocol.py for the pure parsing/framing logic this file
wires up to real socket I/O and (in a later task) real model inference.
"""
import asyncio
import json
import logging
import os
import sys

from protocol import ProtocolError, parse_control_message

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("voice_engine")

SOCKET_PATH = os.environ.get("VOICE_DAEMON_SOCKET", "/tmp/jarvis-voice/voice.sock")


async def handle_connection(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    peer = writer.get_extra_info("peername") or "unix-client"
    log.info(f"connection opened: {peer}")
    try:
        while True:
            line = await reader.readline()
            if not line:
                break
            try:
                msg = parse_control_message(line.decode("utf-8"))
            except ProtocolError as e:
                log.warning(f"malformed message from {peer}, ignoring: {e}")
                continue
            # Task 2 wires real STT/TTS handling in here based on msg["type"].
            log.info(f"received control message: {msg.get('type', 'unknown')}")
    except (ConnectionResetError, BrokenPipeError):
        log.info(f"connection reset: {peer}")
    finally:
        writer.close()
        log.info(f"connection closed: {peer}")


async def main() -> None:
    socket_dir = os.path.dirname(SOCKET_PATH)
    os.makedirs(socket_dir, exist_ok=True)
    if os.path.exists(SOCKET_PATH):
        os.remove(SOCKET_PATH)

    server = await asyncio.start_unix_server(handle_connection, path=SOCKET_PATH)
    log.info(f"voice daemon listening on {SOCKET_PATH}")
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        sys.exit(0)
