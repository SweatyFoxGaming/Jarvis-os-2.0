import logging
from typing import Dict, Any

log = logging.getLogger("jarvis.tools.gui")

def _get_pyautogui():
    """Lazily imports pyautogui to prevent boot-time display crash."""
    import pyautogui
    pyautogui.FAILSAFE = False
    pyautogui.PAUSE = 0.05
    return pyautogui

def click_at(x: int, y: int, button: int = 1) -> Dict[str, Any]:
    """Triggers a mouse click at specific screen coordinates."""
    button_map = {1: "left", 2: "middle", 3: "right"}
    btn = button_map.get(button, "left")
    try:
        pag = _get_pyautogui()
        pag.click(x=x, y=y, button=btn)
        return {"success": True, "action": "click", "x": x, "y": y, "button": btn}
    except Exception as e:
        log.error(f"GUI click failed: {e}")
        return {"success": False, "error": str(e)}

def type_text(text: str) -> Dict[str, Any]:
    """Types out a string as synthetic keyboard input."""
    try:
        pag = _get_pyautogui()
        pag.write(text, interval=0.01)
        return {"success": True, "action": "type", "text": text}
    except Exception as e:
        log.error(f"GUI type failed: {e}")
        return {"success": False, "error": str(e)}

def send_shortcut(key: str) -> Dict[str, Any]:
    """Triggers hotkey combinations (e.g., 'ctrl+t', 'alt+tab')."""
    try:
        pag = _get_pyautogui()
        keys = [k.strip().lower() for k in key.split("+")]
        pag.hotkey(*keys)
        return {"success": True, "action": "shortcut", "key": key}
    except Exception as e:
        log.error(f"GUI shortcut failed: {e}")
        return {"success": False, "error": str(e)}
