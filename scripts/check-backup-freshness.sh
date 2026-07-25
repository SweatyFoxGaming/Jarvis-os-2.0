#!/usr/bin/env bash
# Alerts on a stale or entirely missing backup heartbeat — the failure mode
# backup-postgres.sh alone can't catch: a script that's *correct* but has
# quietly stopped running at all (a removed cron line, a disabled systemd
# timer, a host that's been down) looks identical to "backups are fine"
# until someone actually needs a restore. This is meant to run on its own
# schedule (e.g. via the jarvis-backup-check.timer unit in deploy/, or a
# separate cron/monitoring entry), independent of backup-postgres.sh itself
# — a backup job checking its own success is exactly the kind of check that
# silently stops working alongside the thing it's supposed to be watching.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_DIR="${JARVIS_BACKUP_DIR:-$PROJECT_ROOT/backups}"
# Generous relative to a daily backup schedule — wide enough that a single
# missed run (a rebooting host, a transient Docker hiccup) doesn't page
# anyone, but tight enough that two-plus consecutive misses does.
MAX_AGE_HOURS="${JARVIS_BACKUP_MAX_AGE_HOURS:-30}"
HEARTBEAT_FILE="$BACKUP_DIR/.last-success"

if [ ! -f "$HEARTBEAT_FILE" ]; then
  echo "[!] No backup has ever succeeded — $HEARTBEAT_FILE does not exist. Run scripts/backup-postgres.sh (or check why its scheduled job hasn't fired)." >&2
  exit 1
fi

LAST_SUCCESS_EPOCH="$(date -u -d "$(cat "$HEARTBEAT_FILE")" +%s 2>/dev/null || echo 0)"
NOW_EPOCH="$(date -u +%s)"
AGE_HOURS=$(( (NOW_EPOCH - LAST_SUCCESS_EPOCH) / 3600 ))

if [ "$LAST_SUCCESS_EPOCH" -eq 0 ]; then
  echo "[!] $HEARTBEAT_FILE exists but couldn't be parsed as a timestamp — treating as stale." >&2
  exit 1
fi

if [ "$AGE_HOURS" -gt "$MAX_AGE_HOURS" ]; then
  echo "[!] Last successful backup was ${AGE_HOURS}h ago (threshold: ${MAX_AGE_HOURS}h). Check the backup schedule (cron -l, or 'systemctl status jarvis-backup.timer')." >&2
  exit 1
fi

echo "[*] Last successful backup was ${AGE_HOURS}h ago — within the ${MAX_AGE_HOURS}h threshold."
