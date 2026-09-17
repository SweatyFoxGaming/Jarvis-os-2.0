import os
import asyncio
import logging

logger = logging.getLogger("ToolRegistry")

class ToolRegistry:
    def __init__(self):
        self.tools = {
            "read_file": {"func": self.read_file, "risk": "auto"},
            "list_directory": {"func": self.list_directory, "risk": "auto"},
            "run_shell": {"func": self.run_shell, "risk": "hitl"},
            "write_file": {"func": self.write_file, "risk": "hitl"}
        }

    async def execute(self, action: str, action_input: dict) -> str:
        if action not in self.tools:
            return f"Error: Unknown tool '{action}'"
        
        tool_def = self.tools[action]
        logger.info(f"Executing tool [{action}] under risk tier [{tool_def['risk']}]")
        
        try:
            return await tool_def["func"](action_input)
        except Exception as e:
            logger.error(f"Tool execution failed for {action}: {e}")
            return f"Tool execution error: {str(e)}"

    async def read_file(self, params: dict) -> str:
        path = params.get("path")
        if not path or not os.path.exists(path):
            return f"Error: File not found or path missing: {path}"
        with open(path, "r") as f:
            return f.read()

    async def list_directory(self, params: dict) -> str:
        path = params.get("path", ".")
        if not os.path.exists(path):
            return f"Error: Directory not found: {path}"
        items = os.listdir(path)
        return "\n".join(items)

    async def run_shell(self, params: dict) -> str:
        command = params.get("command")
        if not command:
            return "Error: No command provided."
        
        process = await asyncio.create_subprocess_shell(
            command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )
        stdout, stderr = await process.communicate()
        
        output = ""
        if stdout:
            output += stdout.decode("utf-8")
        if stderr:
            output += "\nSTDERR:\n" + stderr.decode("utf-8")
        return output.strip() or "Command executed with no output."

    async def write_file(self, params: dict) -> str:
        path = params.get("path")
        content = params.get("content", "")
        if not path:
            return "Error: No path provided for file write."
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        with open(path, "w") as f:
            f.write(content)
        return f"Successfully wrote content to {path}"

async def execute_tool(action: str, action_input: dict) -> str:
    registry = ToolRegistry()
    return await registry.execute(action, action_input)
