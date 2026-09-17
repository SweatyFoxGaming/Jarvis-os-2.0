#!/usr/bin/env bash
# Runs OUTSIDE Docker, directly on the host — real checks against the actual
# machine, not the isolated api container. Reports findings only; nothing
# here ever applies a fix. Run periodically via cron (daily is plenty —
# these don't change minute to minute the way the network device list does).
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

FINDINGS="[]"

add_finding() {
  local category="$1" severity="$2" title="$3" description="$4" action="${5:-}" command="${6:-}"
  FINDINGS=$(echo "$FINDINGS" | jq \
    --arg category "$category" --arg severity "$severity" --arg title "$title" \
    --arg description "$description" --arg action "$action" --arg command "$command" \
    '. + [{category: $category, severity: $severity, title: $title, description: $description,
           proposedAction: (if $action == "" then null else $action end),
           proposedCommand: (if $command == "" then null else $command end)}]')
}

# --- Pending security updates (real apt data, not a guess) ---
if command -v apt >/dev/null 2>&1; then
  SECURITY_UPDATES=$(apt list --upgradable 2>/dev/null | grep -i -- "-security" || true)
  UPDATE_COUNT=$(echo "$SECURITY_UPDATES" | grep -c . || true)
  if [ "$UPDATE_COUNT" -gt 0 ]; then
    PACKAGE_NAMES=$(echo "$SECURITY_UPDATES" | cut -d/ -f1 | tr '\n' ',' | sed 's/,$//')
    add_finding "vulnerability" "$([ "$UPDATE_COUNT" -gt 5 ] && echo high || echo medium)" \
      "$UPDATE_COUNT pending security update(s)" \
      "Packages with available security patches: $PACKAGE_NAMES" \
      "Apply pending security updates" \
      "sudo apt update && sudo apt upgrade"
  fi
fi

# --- SSH hardening: root login ---
if [ -f /etc/ssh/sshd_config ]; then
  if grep -qE "^\s*PermitRootLogin\s+yes" /etc/ssh/sshd_config 2>/dev/null; then
    add_finding "config" "high" "SSH root login is permitted" \
      "PermitRootLogin yes in /etc/ssh/sshd_config allows direct root SSH login — a real, well-known hardening gap." \
      "Disable direct root SSH login" \
      "sudo sed -i 's/^PermitRootLogin yes/PermitRootLogin no/' /etc/ssh/sshd_config && sudo systemctl restart sshd"
  fi
fi

# --- Listening ports reachable from outside localhost (informational — not
# all of these are wrong, many are this app's own services; just surfaced
# for review rather than guessed at) ---
if command -v ss >/dev/null 2>&1; then
  EXTERNAL_PORTS=$(ss -tlnH 2>/dev/null | awk '{print $4}' | grep -vE "^(127\.0\.0\.1|\[::1\])" | sort -u || true)
  PORT_COUNT=$(echo "$EXTERNAL_PORTS" | grep -c . || true)
  if [ "$PORT_COUNT" -gt 0 ]; then
    PORT_LIST=$(echo "$EXTERNAL_PORTS" | tr '\n' ',' | sed 's/,$//')
    add_finding "anomaly" "info" "$PORT_COUNT listening port(s) reachable beyond localhost" \
      "Bound addresses: $PORT_LIST — review that each is intentional (this includes Jarvis's own ports)." \
      "" ""
  fi
fi

FINDING_COUNT=$(echo "$FINDINGS" | jq 'length')
if [ "$FINDING_COUNT" -eq 0 ]; then
  echo "No findings — host looks clean."
  exit 0
fi

BODY=$(jq -n --argjson findings "$FINDINGS" '{findings: $findings}')
RESPONSE=$(curl -sS -X POST "$JARVIS_URL/api/security/ingest/findings" \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_KEY" \
  -d "$BODY")

echo "Reported $FINDING_COUNT finding(s). Response: $RESPONSE"
