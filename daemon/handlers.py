import asyncio
from daemon.registry import ipc_action
from daemon.tools.gui import click_at, type_text, send_shortcut
from daemon.tools.perception import capture_screen_base64, get_active_window_info

@ipc_action("PING")
async def handle_ping(payload: dict) -> dict:
    return {"status": "PONG", "alive": True}

@ipc_action("GUI_CLICK")
async def handle_gui_click(payload: dict) -> dict:
    return click_at(
        x=payload.get("x", 0), 
        y=payload.get("y", 0), 
        button=payload.get("button", 1)
    )

@ipc_action("GUI_TYPE")
async def handle_gui_type(payload: dict) -> dict:
    return type_text(text=payload.get("text", ""))

@ipc_action("PERCEPTION_SCREEN")
async def handle_screen_capture(payload: dict) -> dict:
    monitor_idx = payload.get("monitor", 1)
    return capture_screen_base64(monitor_index=monitor_idx)