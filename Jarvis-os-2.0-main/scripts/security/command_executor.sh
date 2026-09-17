#!/usr/bin/env bash
# Runs OUTSIDE Docker, directly on the host — the ONLY thing in this entire
# codebase that ever actually executes a shell command, and only ever a
# command that has already been through the full chain: proposed by Jarvis
# (propose_command tool) -> reviewed by the user in the dashboard ->
# explicitly approved by the user. Nothing here auto-approves anything;
# this script only ever picks up rows already marked 'approved' by a real
# human action.
#
# flock guarantees only one instance runs at a time — without it, an
# overlapping cron invocation could claim and run commands concurrently in
# a way the atomic DB claim alone doesn't fully protect against at the
# process level.
set -uo pipefail  # deliberately not -e: a failing *user* command must not kill this script

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${JARVIS_ENV_FILE:-$SCRIPT_DIR/../../.env}"
JARVIS_URL="${JARVIS_URL:-http://localhost:3000}"
LOCK_FILE="/tmp/jarvis-command-executor.lock"
TIMEOUT_SECONDS="${COMMAND_TIMEOUT:-60}"

exec 200>"$LOCK_FILE"
flock -n 200 || { echo "Another executor run is already in progress — exiting."; exit 0; }

if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: .env not found at $ENV_FILE (set JARVIS_ENV_FILE to override)" >&2
  exit 1
fi

API_KEY=$(grep -E "^INTERNAL_API_KEY=" "$ENV_FILE" | cut -d= -f2)
if [ -z "$API_KEY" ]; then
  echo "ERROR: INTERNAL_API_KEY not set in $ENV_FILE" >&2
  exit 1
fi

# Defense-in-depth ONLY — the real safety boundary is the user's own review
# before approving in the dashboard. This exists purely in case something
# genuinely catastrophic somehow got approved (fat-fingered, or approved
# without fully reading it) — it is not a substitute for reading the command.
is_denylisted() {
  local cmd="$1"
  echo "$cmd" | grep -qE '(rm[[:space:]]+-rf[[:space:]]+/([[:space:]]|$))|(:\(\)[[:space:]]*\{[[:space:]]*:\|:[[:space:]]*&[[:space:]]*\}[[:space:]]*;[[:space:]]*:)|(mkfs\.)|(dd[[:space:]]+.*of=/dev/(sd|nvme|hd))|(>[[:space:]]*/dev/(sd|nvme|hd))'
}

while true; do
  CLAIM_RESPONSE=$(curl -sS -X POST "$JARVIS_URL/api/system/commands/claim" -H "x-api-key: $API_KEY")
  COMMAND_ID=$(echo "$CLAIM_RESPONSE" | jq -r '.command.id // empty')
  if [ -z "$COMMAND_ID" ]; then
    echo "No approved commands waiting."
    break
  fi

  COMMAND_TEXT=$(echo "$CLAIM_RESPONSE" | jq -r '.command.command')
  echo "Claimed command #$COMMAND_ID: $COMMAND_TEXT"

  if is_denylisted "$COMMAND_TEXT"; then
    echo "BLOCKED by safety denylist — not running: $COMMAND_TEXT" >&2
    OUTPUT="Blocked by the executor's safety denylist (matches a known-catastrophic pattern) — not run. Run it manually yourself if it was genuinely intended."
    EXIT_CODE=126
  else
    OUTPUT=$(timeout "$TIMEOUT_SECONDS" bash -c "$COMMAND_TEXT" 2>&1)
    EXIT_CODE=$?
  fi

  BODY=$(jq -n --argjson id "$COMMAND_ID" --arg output "$OUTPUT" --argjson exitCode "$EXIT_CODE" \
    '{id: $id, output: $output, exitCode: $exitCode}')
  curl -sS -X POST "$JARVIS_URL/api/system/ingest/command-result" \
    -H "Content-Type: application/json" -H "x-api-key: $API_KEY" -d "$BODY" > /dev/null

  echo "Command #$COMMAND_ID finished with exit code $EXIT_CODE"
done
