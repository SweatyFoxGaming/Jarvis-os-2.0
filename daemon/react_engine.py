import os
import json
import logging
import urllib.request
import urllib.error
from typing import Any
from daemon.tools import ToolRegistry
from daemon.memory import EpisodicMemory

logger = logging.getLogger("ReActEngine")

class ReActEngine:
    def __init__(
        self, 
        model_name: str = "qwen2.5-coder:7b", 
        ollama_url: str = None, 
        *args, 
        **kwargs
    ):
        self.model_name = model_name
        laptop_ip = os.getenv("LAPTOP_IP", "192.168.3.12")
        self.ollama_url = ollama_url or f"http://{laptop_ip}:11434/api/generate"
        self.tool_registry = ToolRegistry()
        self.memory = EpisodicMemory()

    async def _call_local_llm(self, prompt: str) -> str:
        payload = json.dumps({
            "model": self.model_name,
            "prompt": prompt,
            "stream": False
        }).encode("utf-8")

        req = urllib.request.Request(
            self.ollama_url,
            data=payload,
            headers={"Content-Type": "application/json"}
        )

        try:
            with urllib.request.urlopen(req) as resp:
                res_data = json.loads(resp.read().decode("utf-8"))
                response_text = res_data.get("response", "")
                logger.info(f"Raw Ollama Response: {response_text}")
                return response_text
        except urllib.error.URLError as e:
            logger.error(f"Failed to connect to laptop at {self.ollama_url}: {e}")
            raise e

    async def run(self, goal: str, task_id: str = None, max_steps: int = 5) -> str:
        # Retrieve similar past experiences via RAG
        similar_memories = await self.memory.recall_similar(goal, limit=2)
        rag_context = ""
        if similar_memories:
            rag_context = "Here are relevant past tasks and solutions from memory:\n"
            for mem in similar_memories:
                rag_context += f"- Past Goal: {mem['goal']}\n  Solution: {mem['result']}\n\n"

        prompt_history = f"""You are an autonomous agent executing tasks in a Linux environment.
Goal: {goal}

{rag_context}
Available Tools:
- read_file: Read a file's contents. Input: {{"path": "file_path"}}
- list_directory: List files in a directory. Input: {{"path": "dir_path"}}
- run_shell: Run a bash command. Input: {{"command": "your_command"}}
- write_file: Write content to a file. Input: {{"path": "file_path", "content": "text"}}

Respond strictly in valid JSON format starting with {{ and ending with }}:
For tool action:
{{"thought": "your reasoning", "action": "tool_name", "action_input": {{"param": "value"}}}}

For final result:
{{"thought": "final summary", "action": "final_answer", "action_input": {{"result": "your detailed report"}}}}
"""

        for step in range(1, max_steps + 1):
            logger.info(f"--- ReAct Step {step} (Remote Inference via Laptop) ---")
            
            raw_response = await self._call_local_llm(prompt_history)
            
            raw_text = raw_response.strip()
            if "```json" in raw_text:
                raw_text = raw_text.split("```json")[1].split("```")[0].strip()
            elif "```" in raw_text:
                raw_text = raw_text.split("```")[1].split("```")[0].strip()

            try:
                data = json.loads(raw_text)
            except json.JSONDecodeError:
                logger.error(f"Invalid JSON from remote LLM: {raw_text}")
                return f"Failed to parse local model output: {raw_text}"

            thought = data.get("thought", "")
            action = data.get("action", "")
            action_input = data.get("action_input", {})

            logger.info(f"Thought: {thought}")
            logger.info(f"Action: {action} | Input: {action_input}")

            if action == "final_answer":
                final_result = action_input.get("result", raw_text)
                if task_id:
                    await self.memory.store_memory(task_id, goal, final_result)
                return final_result

            observation = await self.tool_registry.execute(action, action_input)
            logger.info(f"Observation: {observation[:200]}...")

            prompt_history += f"\nStep {step} Thought: {thought}\nAction: {action}\nObservation: {observation}\n"

        return "Max execution steps reached without final_answer."
