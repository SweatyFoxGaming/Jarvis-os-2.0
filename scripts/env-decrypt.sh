#!/bin/bash
# Decrypts .env.age back into .env using the age private key — the
# counterpart to env-encrypt.sh. Use this to restore .env on a fresh
# checkout/new host, or to confirm .env.age actually decrypts correctly
# after rotating a secret (see README's secret-rotation workflow).
#
# Refuses to overwrite an existing, non-empty .env without --force,
# since .env may hold newer plaintext edits that were never re-encrypted
# into .env.age yet — overwriting it silently would lose those.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGE_KEY_PATH="${JARVIS_AGE_KEY_PATH:-$HOME/.config/jarvis/age-key.txt}"
ENV_FILE="$PROJECT_ROOT/.env"
ENV_AGE_FILE="$PROJECT_ROOT/.env.age"
FORCE=0

for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
  esac
done

if ! command -v age >/dev/null 2>&1; then
  echo "[!] age not found. Install with: sudo apt-get install -y age" >&2
  exit 1
fi

if [ ! -f "$ENV_AGE_FILE" ]; then
  echo "[!] $ENV_AGE_FILE not found — nothing to decrypt." >&2
  exit 1
fi

if [ ! -f "$AGE_KEY_PATH" ]; then
  echo "[!] Private key not found at $AGE_KEY_PATH (override with JARVIS_AGE_KEY_PATH)." >&2
  exit 1
fi

if [ -s "$ENV_FILE" ] && [ "$FORCE" -ne 1 ]; then
  echo "[!] $ENV_FILE already exists and is non-empty. Re-run with --force to overwrite it," >&2
  echo "    or back it up first if it might hold edits not yet captured in .env.age." >&2
  exit 1
fi

age -d -i "$AGE_KEY_PATH" -o "$ENV_FILE" "$ENV_AGE_FILE"
chmod 600 "$ENV_FILE"
echo "[*] Decrypted $ENV_AGE_FILE -> $ENV_FILE"
