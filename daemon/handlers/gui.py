import logging
from daemon.registry import ipc_action

log = logging.getLogger("jarvis.handlers.gui")

def _get_pyautogui():
    """Lazy import pyautogui to prevent X11 display connection crashes at startup."""
    import pyautogui
    pyautogui.FAILSAFE = False
    pyautogui.PAUSE = 0.05
    return pyautogui

@ipc_action("GUI_CLICK")
async def handle_gui_click(payload: dict) -> dict:
    """Perform a mouse click at specified coordinates."""
    x = payload.get("x")
    y = payload.get("y")
    button = payload.get("button", "left")

    if x is None or y is None:
        raise ValueError("Missing required parameters: 'x' and 'y'")

    pag = _get_pyautogui()
    pag.click(x=x, y=y, button=button)

    return {
        "action": "click",
        "x": x,
        "y": y,
        "button": button
    }

@ipc_action("GUI_MOVE")
async def handle_gui_move(payload: dict) -> dict:
    """Move cursor to screen coordinates (x, y)."""
    x = payload.get("x")
    y = payload.get("y")
    duration = payload.get("duration", 0.1)

    if x is None or y is None:
        raise ValueError("Missing required parameters: 'x' and 'y'")

    pag = _get_pyautogui()
    pag.moveTo(x=x, y=y, duration=duration)

    return {
        "action": "move",
        "x": x,
        "y": y,
        "duration": duration
    }

@ipc_action("GUI_DRAG")
async def handle_gui_drag(payload: dict) -> dict:
    """Drag the mouse from current or specified start position to (end_x, end_y)."""
    end_x = payload.get("end_x") or payload.get("x")
    end_y = payload.get("end_y") or payload.get("y")
    start_x = payload.get("start_x")
    start_y = payload.get("start_y")
    button = payload.get("button", "left")
    duration = payload.get("duration", 0.5)

    if end_x is None or end_y is None:
        raise ValueError("Missing required parameters: 'end_x' (or 'x') and 'end_y' (or 'y')")

    pag = _get_pyautogui()
    
    # Optionally move to start coordinates first
    if start_x is not None and start_y is not None:
        pag.moveTo(start_x, start_y)

    pag.dragTo(x=end_x, y=end_y, duration=duration, button=button)

    return {
        "action": "drag",
        "start": {"x": start_x, "y": start_y} if start_x is not None else "current",
        "end": {"x": end_x, "y": end_y},
        "button": button,
        "duration": duration
    }

@ipc_action("GUI_SCROLL")
async def handle_gui_scroll(payload: dict) -> dict:
    """Scroll mouse wheel (positive = up, negative = down)."""
    clicks = payload.get("clicks") or payload.get("amount")
    x = payload.get("x")
    y = payload.get("y")

    if clicks is None:
        raise ValueError("Missing required parameter: 'clicks' (positive for up, negative for down)")

    pag = _get_pyautogui()
    
    if x is not None and y is not None:
        pag.scroll(clicks, x=x, y=y)
    else:
        pag.scroll(clicks)

    return {
        "action": "scroll",
        "clicks": clicks,
        "x": x,
        "y": y
    }

@ipc_action("GUI_TYPE")
async def handle_gui_type(payload: dict) -> dict:
    """Type out text synthetically."""
    text = payload.get("text")
    interval = payload.get("interval", 0.0)

    if text is None:
        raise ValueError("Missing required parameter: 'text'")

    pag = _get_pyautogui()
    pag.write(text, interval=interval)

    return {
        "action": "type",
        "length": len(text)
    }

@ipc_action("GUI_SHORTCUT")
async def handle_gui_shortcut(payload: dict) -> dict:
    """Trigger a hotkey / key combination (e.g., ['ctrl', 't'])."""
    keys = payload.get("keys")
    if not keys or not isinstance(keys, list):
        raise ValueError("Missing or invalid parameter: 'keys' (must be a list of strings)")

    pag = _get_pyautogui()
    pag.hotkey(*keys)

    return {
        "action": "shortcut",
        "keys": keys
    }
