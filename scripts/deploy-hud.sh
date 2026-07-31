#!/usr/bin/env bash
set -euo pipefail
# Compiles the adapter to plain JS (no project node_modules needed at
# runtime — see eww-adapter.ts's own header comment) and installs the
# systemd --user unit. Does NOT touch the Docker-based backend/deployment
# in any way.
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST_DIR="${HOME}/jarvis-hud"
mkdir -p "$DEST_DIR"

npx tsc --module nodenext --target es2022 --moduleResolution nodenext \
  "$REPO_DIR/src/system/eww-adapter.ts" --outDir "$DEST_DIR"

mkdir -p "${HOME}/.config/systemd/user"
cp "$REPO_DIR/deploy/jarvis-hud.service" "${HOME}/.config/systemd/user/jarvis-hud.service"

if [ ! -f "${HOME}/.config/jarvis-hud.env" ]; then
  echo "JARVIS_API_KEY=" > "${HOME}/.config/jarvis-hud.env"
  chmod 600 "${HOME}/.config/jarvis-hud.env"
  echo "Created ${HOME}/.config/jarvis-hud.env — fill in JARVIS_API_KEY (an existing Jarvis API key with the hud.read grant) before starting the service."
fi

systemctl --user daemon-reload
systemctl --user enable jarvis-hud.service
systemctl --user restart jarvis-hud.service

echo "Deployed. Check status: systemctl --user status jarvis-hud.service"
echo "Open the HUD window with: eww open jarvis-hud --config $REPO_DIR/config/eww"
