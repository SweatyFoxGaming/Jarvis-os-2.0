#!/bin/bash
# Encrypts .env into .env.age using age (https://age-encryption.org) — the
# encrypted file is what's safe to include in backups/snapshots; the
# plaintext .env never should be. This does NOT remove the plaintext .env
# from disk (docker-compose's env_file: still needs a real file to read
# while containers are running) — it gives you a safe-to-store-anywhere
# artifact for everything else (backups, moving to new hardware, etc.),
# and a documented, repeatable process for secret changes instead of ad
# hoc hand-edits.
#
# First run generates a fresh age keypair. The PRIVATE key
# (age-key.txt) must never live inside the repo or travel with the
# encrypted file — anyone with both can decrypt everything, which
# defeats the entire point. Default location is outside the repo
# entirely; back that file up somewhere separate from your regular repo
# backups, or losing it means losing every secret in .env with no
# recovery path.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGE_KEY_DIR="${JARVIS_AGE_KEY_DIR:-$HOME/.config/jarvis}"
AGE_KEY_PATH="${JARVIS_AGE_KEY_PATH:-$AGE_KEY_DIR/age-key.txt}"
ENV_FILE="$PROJECT_ROOT/.env"
ENV_AGE_FILE="$PROJECT_ROOT/.env.age"

if ! command -v age >/dev/null 2>&1 || ! command -v age-keygen >/dev/null 2>&1; then
  echo "[!] age/age-keygen not found. Install with: sudo apt-get install -y age" >&2
  exit 1
fi

if [ ! -f "$ENV_FILE" ]; then
  echo "[!] $ENV_FILE not found — nothing to encrypt." >&2
  exit 1
fi

if [ ! -f "$AGE_KEY_PATH" ]; then
  mkdir -p "$AGE_KEY_DIR"
  chmod 700 "$AGE_KEY_DIR"
  echo "[*] No age key found at $AGE_KEY_PATH — generating one now."
  age-keygen -o "$AGE_KEY_PATH"
  chmod 600 "$AGE_KEY_PATH"
  echo "[!] BACK UP $AGE_KEY_PATH somewhere separate from this repo right now."
  echo "[!] Losing it means losing every secret in .env with no recovery path."
fi

RECIPIENT="$(grep -m1 '^# public key:' "$AGE_KEY_PATH" | sed 's/^# public key: //')"
if [ -z "$RECIPIENT" ]; then
  echo "[!] Could not read the public key out of $AGE_KEY_PATH — is it a real age-keygen output file?" >&2
  exit 1
fi

age -r "$RECIPIENT" -o "$ENV_AGE_FILE" "$ENV_FILE"
echo "[*] Wrote $ENV_AGE_FILE — safe to back up. $ENV_FILE is still the live plaintext copy docker-compose reads."
