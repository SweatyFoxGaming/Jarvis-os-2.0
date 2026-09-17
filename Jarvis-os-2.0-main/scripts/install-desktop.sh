#!/bin/bash

# Exit immediately if a command exits with a non-zero status
set -e

echo "========================================================="
echo "   JARVIS LINUX DESKTOP APPLICATION INSTALLATION SCRIPT"
echo "========================================================="

# Get absolute path of project root
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="$HOME/.local/bin"
APP_DIR="$HOME/.local/share/applications"

# Create directories if they don't exist
mkdir -p "$BIN_DIR"
mkdir -p "$APP_DIR"

echo "[*] Creating offline execution wrapper..."

# Create a master launcher script that boots up the server and starts python or electron client
CAT_LAUNCHER="$BIN_DIR/JARVIS"
cat << EOF > "$CAT_LAUNCHER"
#!/bin/bash
export PATH="\$PATH:/usr/local/bin:/usr/bin"
cd "$PROJECT_ROOT"

# Check if pywebview is available to use Python native window, else fallback to standard web browser app mode
if python3 -c "import webview" &>/dev/null; then
    echo "Launching JARVIS in native pywebview window mode..."
    python3 src/interaction/desktop/app.py
elif command -v google-chrome &>/dev/null; then
    echo "Launching in Google Chrome sandboxed app mode..."
    # Start the local server in background
    npm run start &
    SERVER_PID=\$!
    
    # Wait for server
    while ! nc -z localhost 3000 &>/dev/null; do sleep 0.2; done
    
    # Launch Chrome in standalone App mode
    google-chrome --app="http://localhost:3000" --class="JARVIS" --user-data-dir="\$HOME/.config/jarvis-desktop-chrome"
    
    # Kill server on browser exit
    kill \$SERVER_PID
elif command -v chromium-browser &>/dev/null; then
    echo "Launching in Chromium sandboxed app mode..."
    npm run start &
    SERVER_PID=\$!
    while ! nc -z localhost 3000 &>/dev/null; do sleep 0.2; done
    chromium-browser --app="http://localhost:3000" --class="JARVIS"
    kill \$SERVER_PID
else
    echo "No desktop wrapper found. Opening server and loading standard browser..."
    npm run start &
    SERVER_PID=\$!
    while ! nc -z localhost 3000 &>/dev/null; do sleep 0.2; done
    xdg-open "http://localhost:3000"
    wait \$SERVER_PID
fi
EOF

# Make the wrapper launcher executable
chmod +x "$CAT_LAUNCHER"
echo "[+] Launcher generated at: $CAT_LAUNCHER"

# Create an elegant icon path or look for system icon
ICON_PATH="$PROJECT_ROOT/src/interaction/static/favicon.ico" # Fallback static logo
# Create a desktop entry for gnome/kde system integration
DESKTOP_ENTRY="$APP_DIR/JARVIS.desktop"

echo "[*] Packaging freedesktop launcher entry..."
cat << EOF > "$DESKTOP_ENTRY"
[Desktop Entry]
Version=1.0
Type=Application
Name=JARVIS OS
Comment=Self-Improving Cognitive Engine offline workspace
Exec=$CAT_LAUNCHER
Icon=preferences-desktop-keyboard-shortcuts
Terminal=false
Categories=Utility;Development;Science;
StartupNotify=true
StartupWMClass=JARVIS
EOF

chmod +x "$DESKTOP_ENTRY"
echo "[+] Desktop application shortcut installed to: $DESKTOP_ENTRY"

# Add desktop file update trigger
if command -v update-desktop-database &>/dev/null; then
    update-desktop-database "$APP_DIR"
fi

echo "========================================================="
echo "   INSTALLATION COMPLETE!"
echo "   JARVIS OS is now accessible offline from your "
echo "   system application drawer or via typing 'JARVIS'"
echo "   in any terminal session."
echo "========================================================="
