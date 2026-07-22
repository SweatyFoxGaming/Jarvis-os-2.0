#!/usr/bin/env python3
import os
import sys
import time
import socket
import subprocess

# PyWebView desktop client for lightweight, low-resource Linux systems
try:
    import webview
except ImportError:
    print("Warning: 'pywebview' is not installed. To run the Python wrapper, run: pip install pywebview")
    webview = None

PORT = 3000

def check_server():
    """Verify if the Express server is up and listening on PORT."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.connect(('127.0.0.1', PORT))
        sock.close()
        return True
    except:
        return False

def main():
    # Locate the server's entry point relative to this file
    desktop_dir = os.path.dirname(os.path.abspath(__file__))
    server_js = os.path.join(desktop_dir, "..", "server.ts")
    root_dir = os.path.join(desktop_dir, "..", "..")
    
    print("=" * 60)
    print("   JARVIS COGNITIVE ENGINE - OFFLINE DESKTOP WRAPPER")
    print("=" * 60)
    
    print("[*] Launching local background cognitive host...")
    
    # Launch server process using tsx if running from dev, or standard node
    server_process = None
    try:
        # Check if tsx is available to run ts files directly, fallback to node
        server_process = subprocess.Popen(
            ["npx", "tsx", "src/server.ts"],
            cwd=root_dir,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True
        )
    except Exception as e:
        print(f"[-] Failed to execute via tsx, attempting direct Node compilation: {e}")
        try:
            compiled_js = os.path.join(root_dir, "dist", "server.js")
            server_process = subprocess.Popen(
                ["node", compiled_js],
                cwd=root_dir,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT
            )
        except Exception as err:
            print(f"[-] Severe Error: Direct Node invocation failed: {err}")
            sys.exit(1)

    print("[*] Waiting for localized backend synchronization...")
    
    # Wait for PORT to become active (up to 15 seconds)
    timeout = 15.0
    start_time = time.time()
    ready = False
    while time.time() - start_time < timeout:
        if check_server():
            ready = True
            break
        time.sleep(0.2)
        
    if not ready:
        print("[-] Error: Offline backend startup timed out.")
        if server_process:
            server_process.kill()
        sys.exit(1)
        
    print("[+] Core synchronized. Spawning webview interface...")
    
    if webview is None:
        print("\n" + "=" * 60)
        print("   OFFLINE SERVICE IS NOW LIVE AT: http://127.0.0.1:3000")
        print("   (Please install 'pywebview' or use the Electron launcher for a native window)")
        print("=" * 60 + "\n")
        try:
            server_process.wait()
        except KeyboardInterrupt:
            print("\n[*] Suspending cognitive core services...")
            server_process.kill()
    else:
        # Spawn full native desktop window
        window = webview.create_window(
            title='JARVIS OS',
            url=f'http://127.0.0.1:{PORT}',
            width=1280,
            height=800,
            background_color='#04060f'
        )
        
        try:
            webview.start()
        finally:
            print("[*] Terminating localized background server processes...")
            if server_process:
                server_process.kill()
            print("[+] SUSPENDED.")

if __name__ == '__main__':
    main()
