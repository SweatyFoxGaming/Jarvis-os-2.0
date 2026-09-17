#!/usr/bin/env bash
set -euo pipefail
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

mkdir -p "${HOME}/.config/systemd/user"
cp "$REPO_DIR/deploy/jarvis-daily-adapt.service" "${HOME}/.config/systemd/user/jarvis-daily-adapt.service"
cp "$REPO_DIR/deploy/jarvis-daily-adapt.timer" "${HOME}/.config/systemd/user/jarvis-daily-adapt.timer"

ENV_FILE="${HOME}/.config/jarvis-daily-adapt.env"
if [ ! -f "$ENV_FILE" ]; then
  echo "JARVIS_API_KEY=" > "$ENV_FILE"
  echo "Created $ENV_FILE — fill in JARVIS_API_KEY (an existing Jarvis API key with the adaptation.run grant) before the timer's first real fire."
fi
chmod 600 "$ENV_FILE"

if ! grep -q '^JARVIS_API_KEY=.\+' "$ENV_FILE"; then
  echo "ERROR: JARVIS_API_KEY is not set in $ENV_FILE — fill it in with a real API key (one granted adaptation.run), then re-run this script." >&2
  exit 1
fi

systemctl --user daemon-reload
systemctl --user enable --now jarvis-daily-adapt.timer

echo "Deployed. Check schedule: systemctl --user list-timers jarvis-daily-adapt.timer"
echo "Manually trigger once for testing: systemctl --user start jarvis-daily-adapt.service"
