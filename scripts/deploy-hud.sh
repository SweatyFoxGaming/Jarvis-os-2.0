#!/usr/bin/env bash
set -euo pipefail
# Compiles the adapter to plain JS (no project node_modules needed at
# runtime — see eww-adapter.ts's own header comment) and installs two
# systemd --user units: one that runs the eww daemon itself and opens the
# HUD window (jarvis-hud-eww.service), and the adapter that polls the
# backend and drives it (jarvis-hud.service, Requires= the eww unit). Does
# NOT touch the Docker-based backend/deployment in any way.
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST_DIR="${HOME}/jarvis-hud"
mkdir -p "$DEST_DIR"

# --ignoreConfig: this repo's own tsconfig.json would otherwise conflict
# with passing a single file + explicit compiler options on the command
# line (TS5112) — this compile is deliberately standalone, independent of
# the backend's own tsconfig (different module target, and this file isn't
# part of the Docker build at all). --ignoreConfig also drops the
# project's own "types": ["node"] setting, so --types node is passed
# explicitly to still resolve process/child_process's ambient types from
# the repo's already-installed @types/node — run from $REPO_DIR so that
# resolves regardless of the caller's own cwd.
(cd "$REPO_DIR" && npx tsc --ignoreConfig --module nodenext --target es2022 --moduleResolution nodenext --types node \
  "$REPO_DIR/src/system/eww-adapter.ts" --outDir "$DEST_DIR")

# Installed to eww's own conventional default config location (not
# referenced via --config anywhere — see jarvis-hud-eww.service's own
# comment on why: the daemon, `eww open`, and the adapter's `eww update`
# calls all need to agree on the identical config path, since eww's IPC
# socket name is derived from a hash of it).
mkdir -p "${HOME}/.config/eww"
cp "$REPO_DIR/config/eww/eww.yuck" "$REPO_DIR/config/eww/eww.scss" "${HOME}/.config/eww/"

mkdir -p "${HOME}/.config/systemd/user"
cp "$REPO_DIR/deploy/jarvis-hud.service" "${HOME}/.config/systemd/user/jarvis-hud.service"
cp "$REPO_DIR/deploy/jarvis-hud-eww.service" "${HOME}/.config/systemd/user/jarvis-hud-eww.service"

ENV_FILE="${HOME}/.config/jarvis-hud.env"
if [ ! -f "$ENV_FILE" ]; then
  echo "JARVIS_API_KEY=" > "$ENV_FILE"
  echo "Created $ENV_FILE — fill in JARVIS_API_KEY (an existing Jarvis API key with the hud.read grant) before starting the service."
fi
chmod 600 "$ENV_FILE"

if ! grep -q '^JARVIS_API_KEY=.\+' "$ENV_FILE"; then
  echo "ERROR: JARVIS_API_KEY is not set in $ENV_FILE — fill it in with a real API key (one granted hud.read), then re-run this script." >&2
  exit 1
fi

systemctl --user daemon-reload
systemctl --user enable jarvis-hud-eww.service jarvis-hud.service
systemctl --user restart jarvis-hud-eww.service jarvis-hud.service

echo "Deployed. Check status: systemctl --user status jarvis-hud-eww.service jarvis-hud.service"
