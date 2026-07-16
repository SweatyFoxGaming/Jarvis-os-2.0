import os
import sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from dotenv import load_dotenv
load_dotenv()  # Load .env

from config.secure_config import AppConfig
AppConfig.load()  # Ensure config is loaded

from memory.secure_store import SecureMemoryStore

def migrate():
    # Force SQLite as source
    source = SecureMemoryStore(use_postgres=False)
    # Force PostgreSQL as target
    target = SecureMemoryStore(use_postgres=True)

    records = source.get_all(limit=100000)
    print(f"Migrating {len(records)} records...")
    for rec in records:
        # Insert without embedding (target will generate embedding automatically if needed)
        target.insert(rec['text'], rec['metadata'])
    print("Migration complete.")
    source.close()
    target.close()

if __name__ == "__main__":
    migrate()
