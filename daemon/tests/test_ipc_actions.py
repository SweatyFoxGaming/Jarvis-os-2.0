#!/usr/bin/env python3
"""IPC Action Suite for Jarvis OS Core Daemon."""

import asyncio
import json
import sys
import uuid
import websockets

WS_URL = "ws://localhost:8765"

TEST_SUITE = [
    {
        "name": "PING (Health Check)",
        "action_type": "PING",
        "payload": {},
        "expect_success": True,
    },
    {
        "name": "SHELL (Execute Command)",
        "action_type": "SHELL",
        "payload": {"command": "echo 'Jarvis IPC Interface Active'"},
        "expect_success": True,
    },
    {
        "name": "GUI_CLICK (Mouse Event)",
        "action_type": "GUI_CLICK",
        "payload": {"x": 500, "y": 500, "button": 1},
        "expect_success": True,
    },
    {
        "name": "GUI_TYPE (Keyboard Input)",
        "action_type": "GUI_TYPE",
        "payload": {"text": "Jarvis Verification Stream"},
        "expect_success": True,
    },
    {
        "name": "GUI_SHORTCUT (Keyboard Combination)",
        "action_type": "GUI_SHORTCUT",
        "payload": {"key": "ctrl+t"},
        "expect_success": True,
    },
    {
        "name": "PERCEPTION_WINDOW (Window State)",
        "action_type": "PERCEPTION_WINDOW",
        "payload": {},
        "expect_success": True,
    },
    {
        "name": "PERCEPTION_SCREEN (Screen Frame Capture)",
        "action_type": "PERCEPTION_SCREEN",
        "payload": {},
        "expect_success": True,
    },
    {
        "name": "VOICE_LISTEN (Audio Capture Probe)",
        "action_type": "VOICE_LISTEN",
        "payload": {"timeout": 1},
        "expect_success": True,
    },
    {
        "name": "INVALID_ACTION (Protocol Error Handling)",
        "action_type": "NON_EXISTENT_ACTION",
        "payload": {},
        "expect_success": False,
    },
]


async def run_suite():
    print(f"Connecting to Jarvis OS Daemon on {WS_URL}...\n")
    try:
        async with websockets.connect(WS_URL) as ws:
            print("✓ WebSocket Connection Established\n" + "=" * 64)
            passed = 0
            failed = 0

            for test in TEST_SUITE:
                event_id = f"test-{uuid.uuid4().hex[:6]}"
                request = {
                    "event_id": event_id,
                    "action_type": test["action_type"],
                    "payload": test["payload"],
                }

                await ws.send(json.dumps(request))
                raw_response = await ws.recv()
                response = json.loads(raw_response)

                success = response.get("success", False)
                test_passed = (success == test["expect_success"])

                if test_passed:
                    passed += 1
                    status = "✓ PASS"
                else:
                    failed += 1
                    status = "✗ FAIL"

                print(f"[{status}] {test['name']}")
                print(f"  ├─ Event ID  : {response.get('event_id')}")
                print(f"  ├─ Success   : {response.get('success')}")
                print(f"  ├─ Result    : {response.get('result')}")
                if response.get("error"):
                    print(f"  └─ Error     : {response.get('error')}")
                else:
                    print(f"  └─ Error     : None")
                print("-" * 64)

            print(f"\nFinal Summary: {passed} Passed, {failed} Failed out of {len(TEST_SUITE)} tests.")
            if failed > 0:
                sys.exit(1)

    except ConnectionRefusedError:
        print(f"Error: Connection refused at {WS_URL}. Ensure the daemon server is running.")
        sys.exit(1)
    except Exception as err:
        print(f"Unexpected error during execution: {err}")
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(run_suite())

# Send request over ws://localhost:8765
await websocket.send(json.dumps({
    "id": "test-custom-123",
    "action": "CUSTOM_SYS_INFO",
    "payload": {}
}))

response = json.loads(await websocket.recv())
print(response)
# Output: {'id': 'test-custom-123', 'success': True, 'result': {'platform': 'Linux', ...}}