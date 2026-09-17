import os
import json
import logging
import urllib.request
import urllib.error
import asyncpg

logger = logging.getLogger("EpisodicMemory")

class EpisodicMemory:
    def __init__(self, db_url: str = None, model_name: str = "nomic-embed-text"):
        self.db_url = db_url or os.getenv("DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/jarvis")
        self.model_name = model_name
        laptop_ip = os.getenv("LAPTOP_IP", "192.168.3.12")
        self.ollama_embed_url = f"http://{laptop_ip}:11434/api/embeddings"

    async def get_embedding(self, text: str) -> list[float]:
        """Fetch vector embedding from remote Ollama instance."""
        payload = json.dumps({
            "model": self.model_name,
            "prompt": text
        }).encode("utf-8")

        req = urllib.request.Request(
            self.ollama_embed_url,
            data=payload,
            headers={"Content-Type": "application/json"}
        )

        try:
            with urllib.request.urlopen(req) as resp:
                res_data = json.loads(resp.read().decode("utf-8"))
                return res_data.get("embedding", [])
        except urllib.error.URLError as e:
            logger.error(f"Failed to fetch embedding from Ollama: {e}")
            return []

    async def store_memory(self, task_id: str, goal: str, result: str):
        """Embeds goal text and stores successful task trace in PostgreSQL."""
        embedding = await self.get_embedding(goal)
        if not embedding:
            logger.warning(f"Skipping memory storage for task {task_id} due to empty embedding.")
            return

        conn = await asyncpg.connect(self.db_url)
        try:
            await conn.execute(
                """
                INSERT INTO task_memories (task_id, goal, result, embedding)
                VALUES ($1, $2, $3, $4::vector)
                """,
                task_id, goal, result, str(embedding)
            )
            logger.info(f"Stored episodic memory for task [{task_id}]")
        finally:
            await conn.close()

    async def recall_similar(self, goal: str, limit: int = 2) -> list[dict]:
        """Retrieves top-k most semantically similar past tasks using vector distance."""
        query_embedding = await self.get_embedding(goal)
        if not query_embedding:
            return []

        conn = await asyncpg.connect(self.db_url)
        try:
            rows = await conn.fetch(
                """
                SELECT goal, result, (embedding <=> $1::vector) as distance
                FROM task_memories
                ORDER BY distance ASC
                LIMIT $2
                """,
                str(query_embedding), limit
            )
            return [{"goal": r["goal"], "result": r["result"], "distance": r["distance"]} for r in rows]
        finally:
            await conn.close()