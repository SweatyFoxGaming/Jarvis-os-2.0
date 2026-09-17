import base64
import io
import logging
import subprocess
import mss
from PIL import Image
from typing import Dict, Any

log = logging.getLogger("jarvis.tools.perception")

def capture_screen_base64(monitor_index: int = 1) -> Dict[str, Any]:
    """Captures the target display frame using mss and returns JPEG Base64 data."""
    try:
        with mss.mss() as sct:
            if monitor_index >= len(sct.monitors):
                monitor_index = 1
            
            monitor = sct.monitors[monitor_index]
            sct_img = sct.grab(monitor)
            
            img = Image.frombytes("RGB", sct_img.size, sct_img.bgra, "raw", "BGRX")
            buffer = io.BytesIO()
            img.save(buffer, format="JPEG", quality=75)
            encoded_str = base64.b64encode(buffer.getvalue()).decode("utf-8")
            
            return {
                "success": True,
                "width": sct_img.width,
                "height": sct_img.height,
                "format": "jpeg",
                "data": encoded_str
            }
    except Exception as e:
        log.error(f"Screen capture failed: {e}")
        return {"success": False, "error": str(e)}

def get_active_window_info() -> Dict[str, Any]:
    """Retrieves the title of the active window via X11 utilities."""
    try:
        res = subprocess.run(
            "xdotool getactivewindow getwindowname",
            shell=True, capture_output=True, text=True, timeout=2
        )
        if res.returncode == 0 and res.stdout.strip():
            return {"success": True, "title": res.stdout.strip()}
        
        # Fallback to xprop query
        res_xprop = subprocess.run(
            "xprop -id $(xprop -root _NET_ACTIVE_WINDOW | awk '{print $NF}') WM_NAME",
            shell=True, capture_output=True, text=True, timeout=2
        )
        if res_xprop.returncode == 0 and '="' in res_xprop.stdout:
            title = res_xprop.stdout.split('="')[1].rstrip('"\n')
            return {"success": True, "title": title}
            
        return {"success": True, "title": "Desktop / Unknown Window"}
    except Exception as e:
        log.error(f"Window inspection failed: {e}")
        return {"success": False, "error": str(e)}
