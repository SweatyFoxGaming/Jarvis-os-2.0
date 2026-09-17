import asyncio
import logging
import psutil
from daemon.db import AutonomyDB

logger = logging.getLogger("AutonomyWatchdog")

class AutonomyWatchdog:
    def __init__(self, check_interval: int = 60, disk_threshold: float = 85.0):
        self.check_interval = check_interval
        self.disk_threshold = disk_threshold

    async def check_disk_space(self):
        usage = psutil.disk_usage('/')
        percent = usage.percent
        logger.info(f"Disk telemetry check: {percent}% utilized")
        
        if percent >= self.disk_threshold:
            logger.warning(f"Disk threshold breached ({percent}% >= {self.disk_threshold}%). Drafting maintenance proposal.")
            db = AutonomyDB()
            await db.connect()
            
            # Prevent duplicate pending task spam
            tasks = await db.list_tasks()
            active_disk_tasks = [
                t for t in tasks 
                if t["title"] == "Automated Disk Cleanup" and t["status"] in ["proposed", "approved", "running"]
            ]
            
            if not active_disk_tasks:
                goal = f"Root disk usage is currently at {percent}%. Audit storage, clear old logs, and clean up unnecessary package caches."
                task_id = await db.create_proposal(goal, title="Automated Disk Cleanup")
                logger.info(f"Watchdog successfully proposed task ID: {task_id}")
            else:
                logger.info("Active disk cleanup task already queued. Skipping duplicate proposal.")
            
            await db.close()

    async def start(self):
        logger.info(f"Starting AutonomyWatchdog (Interval: {self.check_interval}s, Disk Threshold: {self.disk_threshold}%)...")
        while True:
            try:
                await self.check_disk_space()
            except Exception as e:
                logger.error(f"Error in watchdog background loop: {e}")
            await asyncio.sleep(self.check_interval)

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
    watchdog = AutonomyWatchdog()
    asyncio.run(watchdog.start())
