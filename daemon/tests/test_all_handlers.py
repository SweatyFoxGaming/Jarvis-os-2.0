#!/usr/bin/env python3
"""Comprehensive IPC Handler Test Suite for Jarvis OS Daemon."""

import asyncio
import json
import sys
import uuid
import websockets

WS_URL = "ws://localhost:8765"

TEST_CASES = [
    {
        "name": "System: PING",
        "action": "PING",
        "payload": {},
        "expect_success": True
    },
    {
        "name": "System: SHELL execution",
        "action": "SHELL",
        "payload": {"command": "echo 'IPC Handler Test Active'"},
        "expect_success": True
    },
    {
        "name": "GUI: Move Cursor",
        "action": "GUI_MOVE",
        "payload": {"x": 200, "y": 200, "duration": 0.1},
        "expect_success": True
    },
    {
        "name": "GUI: Mouse Click",
        "action": "GUI_CLICK",
        "payload": {"x": 300, "y": 300, "button": "left"},
        "expect_success": True
    },
    {
        "name": "GUI: Mouse Drag",
        "action": "GUI_DRAG",
        "payload": {"start_x": 100, "start_y": 100, "end_x": 400, "end_y": 400, "duration": 0.2},
        "expect_success": True
    },
    {
        "name": "GUI: Mouse Scroll",
        "action": "GUI_SCROLL",
        "payload": {"clicks": -500},
        "expect_success": True
    },
    {
        "name": "GUI: Type Text",
        "action": "GUI_TYPE",
        "payload": {"text": "Jarvis OS Test Input"},
        "expect_success": True
    },
    {
        "name": "GUI: Keyboard Shortcut",
        "action": "GUI_SHORTCUT",
        "payload": {"keys": ["ctrl", "a"]},
        "expect_success": True
    },
    {
        "name": "Perception: Active Window",
        "action": "PERCEPTION_WINDOW",
        "payload": {},
        "expect_success": True
    },
    {
        "name": "Perception: Screen Capture",
        "action": "PERCEPTION_SCREEN",
        "payload": {"monitor": 1},
        "expect_success": True
    },
    {
        "name": "Error Handling: Invalid Action",
        "action": "INVALID_ACTION_TEST",
        "payload": {},
        "expect_success": False
    }
]

async def run_tests():
    print(f"Connecting to Daemon Server on {WS_URL}...\n")
    try:
        async with websockets.connect(WS_URL) as ws:
            print("✓ WebSocket Connected")
            print("=" * 68)
            passed = 0
            failed = 0

            for test in TEST_CASES:
                req_id = f"test-{uuid.uuid4().hex[:6]}"
                request = {
                    "id": req_id,
                    "action": test["action"],
                    "payload": test["payload"]
                }

                await ws.send(json.dumps(request))
                raw_res = await ws.recv()
                res = json.loads(raw_res)

                success = res.get("success", False)
                passed_test = (success == test["expect_success"])

                if passed_test:
                    passed += 1
                    status = "✓ PASS"
                else:
                    failed += 1
                    status = "✗ FAIL"

                print(f"[{status}] {test['name']}")
                print(f"  ├─ ID      : {res.get('id')}")
                print(f"  ├─ Success : {res.get('success')}")

                result_summary = res.get('result')
                # Truncate image_b64 in output if present
                if isinstance(result_summary, dict) and "image_b64" in result_summary:
                    result_summary = result_summary.copy()
                    result_summary["image_b64"] = f"<{len(result_summary['image_b64'])} bytes base64>"

                print(f"  ├─ Result  : {result_summary}")
                print(f"  └─ Error   : {res.get('error')}")
                print("-" * 68)

            print(f"\nFinal Test Results: {passed} Passed, {failed} Failed out of {len(TEST_CASES)} tests.")
            if failed > 0:
                sys.exit(1)

    except ConnectionRefusedError:
        print(f"Error: Connection refused on {WS_URL}. Ensure the server is running.")
        sys.exit(1)
    except Exception as e:
        print(f"Unexpected error: {e}")
        sys.exit(1)

if __name__ == "__main__":
    asyncio.run(run_tests())
