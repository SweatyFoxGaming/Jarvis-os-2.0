import asyncio
import os
import logging
from daemon.memory import EpisodicMemory

logging.basicConfig(level=logging.INFO)

async def main():
    db_url = os.getenv("DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/jarvis")
    
    print("Initializing EpisodicMemory...")
    memory = EpisodicMemory(db_url=db_url)
    
    # 1. Store a mock successful task memory
    test_task_id = "mock-task-999"
    test_goal = "Audit root disk partition usage and check available space"
    test_result = "Root partition (/) is at 89% capacity with 14G free."
    
    print(f"\n[1/2] Storing memory for task [{test_task_id}]...")
    await memory.store_memory(test_task_id, test_goal, test_result)
    
    # 2. Query with semantically similar phrasing (different words, same meaning)
    query = "How much hard drive space do we have left on root?"
    print(f"\n[2/2] Performing vector similarity search for query:\n  -> '{query}'\n")
    
    similar = await memory.recall_similar(query, limit=2)
    
    print("--- Recall Results ---")
    if not similar:
        print("No similar memories found.")
    for idx, item in enumerate(similar):
        print(f"Result {idx + 1}:")
        print(f"  Matched Goal: {item['goal']}")
        print(f"  Result:       {item['result']}")
        print(f"  Distance:     {item['distance']:.4f} (lower is closer)")

if __name__ == "__main__":
    asyncio.run(main())
