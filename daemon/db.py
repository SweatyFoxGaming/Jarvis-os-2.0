import os
import asyncpg
import uuid
import logging

logger = logging.getLogger("AutonomyDB")

class AutonomyDB:
    def __init__(self, db_url: str = None):
        self.db_url = db_url or os.getenv("DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/jarvis")
        self.conn = None

    async def connect(self):
        self.conn = await asyncpg.connect(self.db_url)
        await self._init_schema()

    async def _init_schema(self):
        await self.conn.execute("""
            CREATE TABLE IF NOT EXISTS autonomy_tasks (
                task_id TEXT PRIMARY KEY,
                goal TEXT,
                status TEXT DEFAULT 'proposed',
                result TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            ALTER TABLE autonomy_tasks ADD COLUMN IF NOT EXISTS title TEXT;
        """)
        logger.info("Autonomy DB initialized with 3-tier lifecycle schema.")

    async def close(self):
        if self.conn:
            await self.conn.close()

    async def create_proposal(self, goal: str, title: str = "Autonomous Task") -> str:
        task_id = uuid.uuid4().hex[:8]
        await self.conn.execute(
            """
            INSERT INTO autonomy_tasks (task_id, title, goal, status)
            VALUES ($1, $2, $3, 'proposed')
            """,
            task_id, title, goal
        )
        return task_id

    async def update_status(self, task_id: str, status: str, result: str = None):
        if result is not None:
            await self.conn.execute(
                "UPDATE autonomy_tasks SET status = $1, result = $2 WHERE task_id = $3",
                status, result, task_id
            )
        else:
            await self.conn.execute(
                "UPDATE autonomy_tasks SET status = $1 WHERE task_id = $2",
                status, task_id
            )

    async def fetch_next_task(self, status: str = "approved"):
        row = await self.conn.fetchrow(
            "SELECT task_id, goal, title FROM autonomy_tasks WHERE status = $1 ORDER BY created_at ASC LIMIT 1",
            status
        )
        return row

    async def list_tasks(self):
        rows = await self.conn.fetch("SELECT task_id, title, status, created_at FROM autonomy_tasks ORDER BY created_at DESC")
        return rows
