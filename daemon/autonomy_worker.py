import asyncio
import logging
from daemon.db import AutonomyDB
from daemon.react_engine import ReActEngine

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("AutonomyWorker")

class AutonomyWorker:
    def __init__(self, db: AutonomyDB, react_engine: ReActEngine, poll_interval: int = 60):
        self.db = db
        self.engine = react_engine
        self.poll_interval = poll_interval
        self.is_running = False

    async def start(self):
        self.is_running = True
        logger.info("Autonomous Daemon Loop active (Listening to task queue).")
        
        while self.is_running:
            try:
                # 1. Attempt to claim a pending task from PostgreSQL
                task = await self.db.claim_next_task()
                
                if task:
                    goal_id = task["task_id"]
                    goal = task["goal"]
                    logger.info(f"Processing QUEUED task [{goal_id}]: {goal}")
                    
                    status = "completed"
                    try:
                        result = await self.engine.run(goal)
                        await self.db.finalize_task(goal_id, "completed", result)
                    except Exception as e:
                        logger.error(f"Failed task [{goal_id}]: {e}")
                        await self.db.finalize_task(goal_id, "failed", str(e))
                        result = f"Task failure: {str(e)}"
                        status = "failed"

                    # Persist execution audit log
                    await self.db.log_step(
                        goal_id=goal_id,
                        goal=goal,
                        step=999,
                        thought="Goal iteration finished.",
                        action="final_answer",
                        action_input={"result": result},
                        observation=result,
                        status=status
                    )

                else:
                    # Queue empty: Idle without invoking LLM quota
                    logger.info("Task queue empty. Idle loop sleeping...")

            except asyncio.CancelledError:
                logger.info("Worker execution loop cancelled.")
                break
            except Exception as e:
                logger.error(f"Error in autonomous worker loop: {e}")

            await asyncio.sleep(self.poll_interval)

    def stop(self):
        self.is_running = False
