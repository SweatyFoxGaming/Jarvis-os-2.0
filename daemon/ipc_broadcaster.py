import asyncio
import json
import logging
import websockets
from typing import Set, Dict, Any

logger = logging.getLogger("IPCBroadcaster")

class IPCBroadcaster:
    def __init__(self, host: str = "127.0.0.1", port: int = 8765):
        self.host = host
        self.port = port
        self.clients: Set[websockets.WebSocketServerProtocol] = set()
        self.server = None

    async def register(self, websocket):
        self.clients.add(websocket)
        logger.info(f"HUD Client connected: {websocket.remote_address}")
        try:
            await websocket.wait_closed()
        finally:
            self.clients.discard(websocket)
            logger.info(f"HUD Client disconnected: {websocket.remote_address}")

    async def start_server(self):
        self.server = await websockets.serve(
            self.register, 
            self.host, 
            self.port,
            reuse_port=True
        )
        logger.info(f"IPC WebSocket Server listening on ws://{self.host}:{self.port}")

    async def broadcast(self, event_type: str, payload: Dict[str, Any]):
        if not self.clients:
            return
        
        message = json.dumps({
            "event": event_type,
            "data": payload
        })
        
        await asyncio.gather(
            *[client.send(message) for client in list(self.clients)],
            return_exceptions=True
        )

ipc = IPCBroadcaster()
