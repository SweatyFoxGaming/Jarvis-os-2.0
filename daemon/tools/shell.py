import subprocess
from typing import Dict, Any

def run_shell_command(command: str) -> Dict[str, Any]:
    if not command:
        return {"success": False, "error": "No command specified"}
    try:
        res = subprocess.run(command, shell=True, capture_output=True, text=True, timeout=30)
        return {
            "success": res.returncode == 0,
            "stdout": res.stdout,
            "stderr": res.stderr,
            "returncode": res.returncode
        }
    except Exception as e:
        return {"success": False, "error": str(e)}
