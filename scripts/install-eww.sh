#!/usr/bin/env bash
set -euo pipefail
# Builds eww from source with the X11 feature — GNOME's Wayland compositor
# doesn't implement wlr-layer-shell, which eww's native Wayland backend
# needs for overlay positioning, so X11-via-XWayland is the reliable path
# on this specific host. Requires cargo/rustc (already present).
# Pinned to the exact commit verified to build and run correctly on this
# host (GNOME/Wayland desktop, X11-via-XWayland) — not a moving target.
EWW_REV="48f5aa8b379adf29da0b0bb9ca04164f65d8bdaa"
EWW_DIR="${HOME}/.local/src/eww"
mkdir -p "$(dirname "$EWW_DIR")"
if [ ! -d "$EWW_DIR" ]; then
  git clone https://github.com/elkowar/eww.git "$EWW_DIR"
fi
cd "$EWW_DIR"
git fetch origin
git checkout --detach "$EWW_REV"
cargo build --release --no-default-features --features x11
mkdir -p "${HOME}/.local/bin"
cp target/release/eww "${HOME}/.local/bin/eww"
echo "Installed eww to ${HOME}/.local/bin/eww — ensure that directory is on your PATH."
