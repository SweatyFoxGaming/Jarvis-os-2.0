#!/usr/bin/env bash
# Runs OUTSIDE Docker, directly on the host — this is the "lightweight
# host-side scanner" half of security-ops (see README's "Security ops"
# section). It's the only piece of this feature that ever touches the real
# LAN; the jarvis-os-api container stays on its isolated Docker bridge
# network with no new privileges. Run periodically via cron/systemd timer
# (root, or a user with CAP_NET_RAW, since arp-scan needs raw sockets).
#
# Reads INTERNAL_API_KEY from the same .env file the app itself uses —
# never hardcode it here.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${JARVIS_ENV_FILE:-$SCRIPT_DIR/../../.env}"
JARVIS_URL="${JARVIS_URL:-http://localhost:3000}"

if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: .env not found at $ENV_FILE (set JARVIS_ENV_FILE to override)" >&2
  exit 1
fi

API_KEY=$(grep -E "^INTERNAL_API_KEY=" "$ENV_FILE" | cut -d= -f2)
if [ -z "$API_KEY" ]; then
  echo "ERROR: INTERNAL_API_KEY not set in $ENV_FILE" >&2
  exit 1
fi

if ! command -v arp-scan >/dev/null 2>&1; then
  echo "ERROR: arp-scan not installed (apt install arp-scan)" >&2
  exit 1
fi

# Parses arp-scan's "IP<TAB>MAC<TAB>Vendor" lines into a JSON array with jq
# (never hand-build JSON from vendor strings, which can contain commas/quotes).
DEVICES_JSON=$(arp-scan --localnet 2>/dev/null \
  | awk -F'\t' 'NF==3 && $1 ~ /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/ {print $1"\t"$2"\t"$3}' \
  | jq -R -s '
      split("\n") | map(select(length > 0) | split("\t")) |
      map({ip: .[0], mac: .[1], vendor: .[2]})
    ')

DEVICE_COUNT=$(echo "$DEVICES_JSON" | jq 'length')
if [ "$DEVICE_COUNT" -eq 0 ]; then
  echo "No devices found — arp-scan may need sudo, or the network is empty."
  exit 0
fi

BODY=$(jq -n --argjson devices "$DEVICES_JSON" '{devices: $devices}')

RESPONSE=$(curl -sS -X POST "$JARVIS_URL/api/security/ingest/devices" \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_KEY" \
  -d "$BODY")

echo "Scanned $DEVICE_COUNT device(s). Response: $RESPONSE"
