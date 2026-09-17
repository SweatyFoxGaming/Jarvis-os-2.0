#!/usr/bin/env bash
# Stable entry point for the .desktop files main.js generates (app-menu entry
# and autostart) — points here instead of at a literal `electron .` command
# so the desktop entry keeps working across future code changes without
# needing to be regenerated.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
exec ./node_modules/.bin/electron . "$@"
