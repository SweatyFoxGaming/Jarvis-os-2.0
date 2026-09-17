import asyncio
import json
import logging
import websockets
from daemon.db import AutonomyDB

logger = logging.getLogger("IPCWebSocket")

class IPCDaemon:
    def __init__(self, host: str = "0.0.0.0", port: int = 8765):
        self.host = host
        self.port = port
        self.connected_clients = set()

    async def register(self, websocket):
        self.connected_clients.add(websocket)
        logger.info(f"Client connected: {websocket.remote_address}")

    async def unregister(self, websocket):
        self.connected_clients.remove(websocket)
        logger.info(f"Client disconnected: {websocket.remote_address}")

    async def broadcast(self, message: dict):
        if self.connected_clients:
            payload = json.dumps(message)
            await asyncio.gather(
                *[client.send(payload) for client in self.connected_clients],
                return_exceptions=True
            )

    async def handle_message(self, websocket, message_str: str):
        try:
            data = json.loads(message_str)
            action = data.get("action")
            db = AutonomyDB()
            await db.connect()

            if action == "list_tasks":
                tasks = await db.list_tasks()
                formatted = [{"task_id": t["task_id"], "title": t["title"], "status": t["status"]} for t in tasks]
                await websocket.send(json.dumps({"status": "success", "data": formatted}))
            elif action == "propose":
                goal = data.get("goal")
                title = data.get("title", "IPC Task")
                task_id = await db.create_proposal(goal, title)
                await websocket.send(json.dumps({"status": "success", "task_id": task_id}))
                await self.broadcast({"event": "task_proposed", "task_id": task_id, "title": title})
            else:
                await websocket.send(json.dumps({"status": "error", "message": f"Unknown action: {action}"}))

            await db.close()
        except Exception as e:
            logger.error(f"Error handling IPC message: {e}")
            await websocket.send(json.dumps({"status": "error", "message": str(e)}))

    async def handler(self, websocket):
        await self.register(websocket)
        try:
            async for message in websocket:
                await self.handle_message(websocket, message)
        except websockets.exceptions.ConnectionClosed:
            pass
        finally:
            await self.unregister(websocket)

    async def start(self):
        logger.info(f"Starting IPC WebSocket server on {self.host}:{self.port}...")
        async with websockets.serve(self.handler, self.host, self.port, reuse_address=True):
            await asyncio.Future()

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    server = IPCDaemon()
    asyncio.run(server.start())
