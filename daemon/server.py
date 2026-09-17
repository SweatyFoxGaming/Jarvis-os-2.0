import asyncio
import json
import logging
import websockets

import daemon.handlers
from daemon.registry import ACTION_HANDLERS, load_all_handlers

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s"
)
log = logging.getLogger("jarvis.server")

def initialize_server():
    log.info("Discovering IPC action handlers...")
    load_all_handlers(daemon.handlers)
    log.info(f"Loaded {len(ACTION_HANDLERS)} handlers: {list(ACTION_HANDLERS.keys())}")

async def handle_client(websocket):
    async for message in websocket:
        try:
            data = json.loads(message)
            action = data.get("action")
            event_id = data.get("id")
            payload = data.get("payload", {})

            handler = ACTION_HANDLERS.get(action)
            if not handler:
                await websocket.send(json.dumps({
                    "id": event_id,
                    "success": False,
                    "error": f"Unknown action: '{action}'"
                }))
                continue

            if asyncio.iscoroutinefunction(handler):
                result = await handler(payload)
            else:
                result = handler(payload)

            await websocket.send(json.dumps({
                "id": event_id,
                "success": True,
                "result": result
            }))

        except Exception as e:
            log.error(f"Error handling IPC message: {e}")
            await websocket.send(json.dumps({
                "id": data.get("id") if 'data' in locals() and isinstance(data, dict) else None,
                "success": False,
                "error": str(e)
            }))

async def main():
    initialize_server()
    async with websockets.serve(handle_client, "127.0.0.1", 8765):
        log.info("Server active on ws://localhost:8765")
        await asyncio.Future()

if __name__ == "__main__":
    asyncio.run(main())
