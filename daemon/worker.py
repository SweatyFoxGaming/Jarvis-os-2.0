import asyncio
import logging
from daemon.db import AutonomyDB
from daemon.react_engine import ReActEngine

logger = logging.getLogger("AutonomyWorker")

class AutonomyWorker:
    def __init__(self, db_url: str = None):
        self.db_url = db_url
        self.db = AutonomyDB(db_url)
        self.engine = ReActEngine()

    async def start(self):
        await self.db.connect()
        logger.info("Autonomous Daemon Loop active (Listening for APPROVED tasks).")
        try:
            while True:
                task = await self.db.fetch_next_task("approved")
                if task:
                    task_id = task["task_id"]
                    goal = task["goal"]
                    logger.info(f"Processing APPROVED task [{task_id}]: {goal}")
                    
                    await self.db.update_status(task_id, "executing")
                    
                    try:
                        result = await self.engine.run(goal, task_id=task_id)
                        # Move to review_pending for final user launch approval
                        await self.db.update_status(task_id, "review_pending", result=result)
                        logger.info(f"Task [{task_id}] execution complete. Moved to review_pending.")
                    except Exception as e:
                        logger.error(f"Task [{task_id}] failed: {e}")
                        await self.db.update_status(task_id, "failed", result=str(e))
                else:
                    await asyncio.sleep(5)
        except asyncio.CancelledError:
            pass
        finally:
            await self.db.close()
