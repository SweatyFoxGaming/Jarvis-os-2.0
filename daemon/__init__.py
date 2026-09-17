import json
import asyncio
import websockets
import os
import psutil
from typing import Dict, Any, Callable, Awaitable

class ToolRegistry:
    def __init__(self, ipc_uri: str = "ws://localhost:8765"):
        self.ipc_uri = ipc_uri
        self._registry: Dict[str, Callable[..., Awaitable[Any]]] = {}
        self._register_default_tools()

    def register(self, name: str, func: Callable[..., Awaitable[Any]]):
        self._registry[name] = func

    def _register_default_tools(self):
        self.register("trigger_ipc", self.trigger_ipc)
        self.register("read_system_metrics", self.read_system_metrics)
        self.register("run_shell", self.run_shell)
        self.register("send_notification", self.send_notification)
        self.register("read_file", self.read_file)
        self.register("write_file", self.write_file)

    async def trigger_ipc(self, action: str, payload: dict = None) -> str:
        """Sends an IPC message to the desktop Electron process or EWW layer."""
        try:
            async with websockets.connect(self.ipc_uri) as ws:
                msg = json.dumps({"action": action, "payload": payload or {}})
                await ws.send(msg)
                response = await asyncio.wait_for(ws.recv(), timeout=5.0)
                return f"IPC Success: {response}"
        except Exception as e:
            return f"IPC Error (GUI server offline): {str(e)}"

    async def read_system_metrics(self) -> str:
        """Gathers system resource stats (CPU, RAM, Disk)."""
        metrics = {
            "cpu_percent": psutil.cpu_percent(),
            "memory_percent": psutil.virtual_memory().percent,
            "disk_percent": psutil.disk_usage("/").percent,
        }
        return json.dumps(metrics)

    async def run_shell(self, command: str) -> str:
        """Executes a bash shell command and captures stdout/stderr."""
        try:
            proc = await asyncio.create_subprocess_shell(
                command,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=15.0)
            out = stdout.decode().strip()
            err = stderr.decode().strip()
            if proc.returncode != 0:
                return f"Shell Error (exit code {proc.returncode}): {err or out}"
            return out or "Command executed successfully with no output."
        except Exception as e:
            return f"Execution Failure: {str(e)}"

    async def send_notification(self, title: str, message: str) -> str:
        """Sends a desktop notification via notify-send or IPC fallback."""
        res = await self.run_shell(f'notify-send "{title}" "{message}"')
        if "Error" in res:
            return await self.trigger_ipc("NOTIFY", {"title": title, "message": message})
        return f"Notification sent: [{title}] {message}"

    async def read_file(self, filepath: str) -> str:
        """Reads a text file from the filesystem."""
        try:
            with open(filepath, "r", encoding="utf-8") as f:
                return f.read(4000)
        except Exception as e:
            return f"Read Error: {str(e)}"

    async def write_file(self, filepath: str, content: str) -> str:
        """Writes content to a file, creating directories if needed."""
        try:
            os.makedirs(os.path.dirname(os.path.abspath(filepath)), exist_ok=True)
            with open(filepath, "w", encoding="utf-8") as f:
                f.write(content)
            return f"Successfully wrote {len(content)} bytes to {filepath}"
        except Exception as e:
            return f"Write Error: {str(e)}"

    async def execute(self, tool_name: str, **kwargs) -> str:
        if tool_name not in self._registry:
            return f"Error: Tool '{tool_name}' not found."
        try:
            return await self._registry[tool_name](**kwargs)
        except Exception as e:
            return f"Execution Error in '{tool_name}': {str(e)}"