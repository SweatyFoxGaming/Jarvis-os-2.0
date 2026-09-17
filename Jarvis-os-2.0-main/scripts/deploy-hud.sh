#!/usr/bin/env bash
set -euo pipefail
# Compiles the bridge to plain JS (no project node_modules needed at
# runtime for anything except "ws" — see eww-bridge.ts's own header
# comment: it's a deliberate, documented exception to the
# "no project node_modules required" property eww-adapter.ts, the file
# this replaced, used to have) and installs two systemd --user units: one
# that runs the eww daemon itself and opens the HUD window
# (jarvis-hud-eww.service), and the bridge that listens for real-time
# events and drives it (jarvis-hud.service, Requires= the eww unit). Does
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
  "$REPO_DIR/src/ipc/eww-bridge.ts" --outDir "$DEST_DIR")

# Stamps the deployed commit next to the compiled bridge -- eww-bridge.ts
# reads this once at its own startup and self-reports it to the api server
# (POST /api/hud/report-version), so health-watchdog.ts's companion-
# staleness check has real evidence of whether the running bridge actually
# matches the current repo, instead of silently running stale code
# indefinitely (the exact real incident that motivated this check).
git -C "$REPO_DIR" rev-parse HEAD > "$DEST_DIR/VERSION"

# The one dependency the compiled output can't do without: a real
# WebSocket client. "ws" itself ships with zero required dependencies of
# its own (verified against its package.json — only optional native
# perf addons), so copying just this one package over is enough to make
# `require("ws")`/`import ... from "ws"` resolve from $DEST_DIR at
# runtime, without pulling in the rest of the project's node_modules.
rm -rf "$DEST_DIR/node_modules/ws"
mkdir -p "$DEST_DIR/node_modules"
cp -r "$REPO_DIR/node_modules/ws" "$DEST_DIR/node_modules/ws"

# Installed to eww's own conventional default config location (not
# referenced via --config anywhere — see jarvis-hud-eww.service's own
# comment on why: the daemon, `eww open`, and the bridge's `eww update`
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
  # /api/hud/status (validateApiKey) still accepts either the admin key or
  # any per-user key granted hud.read, same as before. But /ws/events (the
  # bridge's new real-time trigger) checks the X-API-Key header against the
  # server's resolved admin key directly (ADMIN_API_KEY, falling back to
  # INTERNAL_API_KEY) — it does not look up per-user keys the way
  # validateApiKey does. One JARVIS_API_KEY value now has to satisfy both
  # requests, so it must be the actual admin key, not merely a
  # hud.read-scoped user key, or the WS connection will be rejected even
  # though the HTTP status fetch would still succeed.
  echo "Created $ENV_FILE — fill in JARVIS_API_KEY with the server's actual admin key (ADMIN_API_KEY, or INTERNAL_API_KEY if ADMIN_API_KEY is unset) before starting the service."
fi
chmod 600 "$ENV_FILE"

if ! grep -q '^JARVIS_API_KEY=.\+' "$ENV_FILE"; then
  echo "ERROR: JARVIS_API_KEY is not set in $ENV_FILE — fill it in with the server's actual admin key (ADMIN_API_KEY / INTERNAL_API_KEY), then re-run this script." >&2
  exit 1
fi

systemctl --user daemon-reload
systemctl --user enable jarvis-hud-eww.service jarvis-hud.service
systemctl --user restart jarvis-hud-eww.service jarvis-hud.service

echo "Deployed. Check status: systemctl --user status jarvis-hud-eww.service jarvis-hud.service"
