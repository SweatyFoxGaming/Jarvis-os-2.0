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
# Discard any local state (a prior interrupted build, manual edits) before
# pinning — otherwise `checkout --detach` can fail or silently build
# something other than EWW_REV on a rerun. -e target keeps cargo's own
# build cache: it's untracked (gitignored) but expensive to lose — a
# rerun should skip already-built dependencies, not recompile from
# scratch every time.
git reset --hard
git clean -fdx -e target
git checkout --detach "$EWW_REV"
# --locked: EWW_REV's own committed Cargo.lock pins every transitive
# dependency too, not just eww's own source — without this, cargo would
# still be free to resolve newer transitive versions than what was
# actually verified to build on this host.
cargo build --release --locked --no-default-features --features x11
mkdir -p "${HOME}/.local/bin"
# Staged into a temp file in the destination directory (so the final `mv`
# is an atomic rename, not a cross-filesystem copy) with executable
# permissions set explicitly, then moved into place — a `cp` straight to
# the final path risks a partially-written or non-executable binary if
# interrupted mid-copy or raced by a concurrent systemd restart.
install -m 0755 target/release/eww "${HOME}/.local/bin/eww.tmp"
mv -f "${HOME}/.local/bin/eww.tmp" "${HOME}/.local/bin/eww"
echo "Installed eww to ${HOME}/.local/bin/eww — ensure that directory is on your PATH."
