import io
import base64
import logging
from daemon.registry import ipc_action

log = logging.getLogger("jarvis.handlers.perception")

@ipc_action("PERCEPTION_WINDOW")
async def handle_perception_window(payload: dict) -> dict:
    """Get metadata for the currently focused window."""
    try:
        import pygetwindow as gw
        active_window = gw.getActiveWindow()
        if active_window:
            return {
                "title": active_window.title,
                "bounds": {
                    "left": active_window.left,
                    "top": active_window.top,
                    "width": active_window.width,
                    "height": active_window.height
                }
            }
    except Exception as e:
        log.warning(f"Could not fetch active window details: {e}")

    return {
        "title": "Desktop / Unknown Window",
        "bounds": None
    }

@ipc_action("PERCEPTION_SCREEN")
async def handle_perception_screen(payload: dict) -> dict:
    """Capture the screen and return a Base64-encoded JPEG image."""
    from PIL import Image
    import mss

    monitor_index = payload.get("monitor", 1)

    with mss.mss() as sct:
        monitors = sct.monitors
        if monitor_index >= len(monitors):
            monitor_index = 1
        
        sct_img = sct.grab(monitors[monitor_index])
        img = Image.frombytes("RGB", sct_img.size, sct_img.bgra, "raw", "BGRX")

        buffer = io.BytesIO()
        img.save(buffer, format="JPEG", quality=80)
        encoded_img = base64.b64encode(buffer.getvalue()).decode("utf-8")

        return {
            "width": img.width,
            "height": img.height,
            "format": "jpeg",
            "image_b64": encoded_img
        }