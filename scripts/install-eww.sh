#!/usr/bin/env bash
set -euo pipefail
# Builds eww from source with the X11 feature — GNOME's Wayland compositor
# doesn't implement wlr-layer-shell, which eww's native Wayland backend
# needs for overlay positioning, so X11-via-XWayland is the reliable path
# on this specific host. Requires cargo/rustc (already present).
EWW_DIR="${HOME}/.local/src/eww"
mkdir -p "$(dirname "$EWW_DIR")"
if [ ! -d "$EWW_DIR" ]; then
  git clone https://github.com/elkowar/eww.git "$EWW_DIR"
fi
cd "$EWW_DIR"
git pull --ff-only
cargo build --release --no-default-features --features x11
mkdir -p "${HOME}/.local/bin"
cp target/release/eww "${HOME}/.local/bin/eww"
echo "Installed eww to ${HOME}/.local/bin/eww — ensure that directory is on your PATH."
