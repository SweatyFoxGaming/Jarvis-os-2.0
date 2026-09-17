import asyncio
import subprocess
from typing import Dict, Any, Callable

async def run_shell(command: str) -> str:
    """Executes bash commands asynchronously."""
    try:
        proc = await asyncio.create_subprocess_shell(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE
        )
        stdout, stderr = await proc.communicate()
        output = stdout.decode().strip() or stderr.decode().strip()
        return output if output else "Command executed with no output."
    except Exception as e:
        return f"Shell execution error: {str(e)}"

class ToolRegistry:
    def __init__(self):
        self._registry: Dict[str, Callable] = {
            "run_shell": run_shell
        }

    def register(self, name: str, func: Callable):
        self._registry[name] = func

    async def execute(self, action: str, action_input: Dict[str, Any]) -> str:
        if action not in self._registry:
            return f"Error: Tool '{action}' is not supported."
        
        func = self._registry[action]
        if action == "run_shell":
            return await func(action_input.get("command", ""))
        return await func(**action_input)

# Default registry instance
registry = ToolRegistry()

async def execute_tool(action: str, action_input: Dict[str, Any]) -> str:
    """Helper function for backward compatibility with ReActEngine."""
    return await registry.execute(action, action_input)
