import subprocess
import time
import requests

CDP_PORT = 9222
CDP_HEALTH_URL = f"http://localhost:{CDP_PORT}/json/version"

def is_cdp_available() -> bool:
    try:
        response = requests.get(CDP_HEALTH_URL, timeout=1)
        return response.status_code == 200
    except requests.RequestException:
        return False

def launch_browser_with_cdp(binary_path: str = "google-chrome"):
    if is_cdp_available():
        print(f"[CDP Launcher] Browser already responding on port {CDP_PORT}.")
        return

    command = [
        binary_path,
        f"--remote-debugging-port={CDP_PORT}",
        "--remote-allow-origins=*",
        "--user-data-dir=/tmp/jarvis_cdp_profile"
    ]

    print(f"[CDP Launcher] Launching browser instance with CDP port {CDP_PORT}...")
    subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    # Poll until ready
    for _ in range(10):
        if is_cdp_available():
            print(f"[CDP Launcher] CDP successfully attached on port {CDP_PORT}.")
            return
        time.sleep(0.5)

    print("[CDP Launcher] Error: Browser process started, but CDP endpoint failed to respond.")

if __name__ == "__main__":
    launch_browser_with_cdp()