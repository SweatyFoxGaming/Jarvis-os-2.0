import asyncio
import sys
import argparse
from daemon.db import AutonomyDB

async def main():
    parser = argparse.ArgumentParser(description="Jarvis-OS Autonomy CLI")
    subparsers = parser.add_subparsers(dest="command", required=True)

    # propose
    p_parser = subparsers.add_parser("propose", help="Propose a new autonomous task")
    p_parser.add_argument("goal", type=str, help="The goal description")
    p_parser.add_argument("--title", type=str, default="Task Proposal", help="Task title")

    # approve
    a_parser = subparsers.add_parser("approve", help="Approve a proposed task for execution")
    a_parser.add_argument("task_id", type=str, help="Task ID")

    # launch
    l_parser = subparsers.add_parser("launch", help="Give final launch approval for a review_pending task")
    l_parser.add_argument("task_id", type=str, help="Task ID")

    # list
    subparsers.add_parser("list", help="List all tasks and their lifecycle status")

    args = parser.parse_args()
    db = AutonomyDB()
    await db.connect()

    if args.command == "propose":
        task_id = await db.create_proposal(args.goal, args.title)
        print(f"Task proposed successfully. ID: {task_id} [Status: proposed]")
    elif args.command == "approve":
        await db.update_status(args.task_id, "approved")
        print(f"Task {args.task_id} approved. Daemon worker will pick it up.")
    elif args.command == "launch":
        await db.update_status(args.task_id, "launched")
        print(f"Task {args.task_id} launched successfully! [Status: launched]")
    elif args.command == "list":
        tasks = await db.list_tasks()
        print("\n--- Jarvis-OS Task Lifecycle Queue ---")
        for t in tasks:
            print(f"ID: {t['task_id']} | Status: {t['status']:14} | Title: {t['title']}")
        print("-" * 40)

    await db.close()

if __name__ == "__main__":
    asyncio.run(main())
