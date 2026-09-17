import asyncio
import logging
import os
from daemon.watchdog import AutonomyWatchdog
from daemon.ipc import IPCDaemon
from daemon.db import AutonomyDB

logger = logging.getLogger("JarvisMaster")

async def main():
    database_url = os.getenv("DATABASE_URL")
    if not database_url:
        logger.error("DATABASE_URL environment variable is missing!")
        return

    # Initialize and verify database connection on startup
    db = AutonomyDB()
    await db.connect()
    await db.close()
    logger.info("Database schema verified successfully.")

    # Initialize background subsystems
    watchdog = AutonomyWatchdog(check_interval=60, disk_threshold=85.0)
    ipc = IPCDaemon(host="0.0.0.0", port=8765)

    logger.info("Starting Jarvis-OS Master Autonomy Daemon stack...")
    
    # Run both the background watchdog and IPC server concurrently
    await asyncio.gather(
        watchdog.start(),
        ipc.start(),
        return_exceptions=True
    )

if __name__ == "__main__":
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s"
    )
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("Jarvis-OS Master Daemon shut down gracefully by user.")
