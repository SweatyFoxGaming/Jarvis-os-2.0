import unittest
import importlib
import socket
import os

class TestJarvisOSBaseline(unittest.TestCase):

    def test_01_syntax_and_imports(self):
        """Verify all core daemon modules import without missing dependencies or syntax errors."""
        modules = [
            "daemon.db",
            "daemon.tools",
            "daemon.ipc_broadcaster",
            "daemon.react_engine",
            "daemon.autonomy_worker",
            "daemon.main",
        ]
        for mod in modules:
            with self.subTest(module=mod):
                try:
                    importlib.import_module(mod)
                except Exception as e:
                    self.fail(f"Failed to import {mod}: {e}")

    def test_02_port_availability(self):
        """Check if WebSocket IPC port 8765 is available or bound."""
        host, port = "127.0.0.1", 8765
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            result = s.connect_ex((host, port))
            if result == 0:
                print(f"\n[WARNING] Port {port} is currently bound by another process.")

    def test_03_environment_keys(self):
        """Check if DATABASE_URL and GEMINI_API_KEY exist in environment."""
        self.assertIsNotNone(os.getenv("DATABASE_URL"), "DATABASE_URL environment variable is missing.")
        self.assertIsNotNone(os.getenv("GEMINI_API_KEY"), "GEMINI_API_KEY environment variable is missing.")

    def test_04_hitl_task_approval_lifecycle(self):
        """Verify state machine moves tasks cleanly from awaiting_approval to approved."""
        import asyncio
        from daemon.db import AutonomyDB

        async def run_test():
            db = AutonomyDB()
            await db.connect()
            
            task_id = await db.create_proposal("Research kernel tuning", "Draft proposal details")
            self.assertIsNotNone(task_id)

            unapproved = await db.claim_approved_task()
            self.assertIsNone(unapproved)

            approved = await db.set_task_approval(task_id, approved=True)
            self.assertTrue(approved)

            claimed = await db.claim_approved_task()
            self.assertIsNotNone(claimed)
            self.assertEqual(claimed["task_id"], task_id)

            await db.close()

        asyncio.run(run_test())

if __name__ == "__main__":
    unittest.main()
