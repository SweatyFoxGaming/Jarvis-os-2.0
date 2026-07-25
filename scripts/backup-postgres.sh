#!/bin/bash
# Dumps the jarvis-postgres container's database to a timestamped,
# gzip-compressed file. This is the only copy of Jarvis's memory,
# knowledge-graph, session, and identity data — the compose file's bind
# mount alone is not a backup, it's just where the live data happens to
# live. Run this on a schedule (e.g. daily via cron); see README.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_DIR="${JARVIS_BACKUP_DIR:-$PROJECT_ROOT/backups}"
CONTAINER_NAME="${POSTGRES_CONTAINER_NAME:-jarvis-postgres}"
RETAIN="${JARVIS_BACKUP_RETAIN:-14}"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"

if [ -f "$PROJECT_ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source <(grep -E '^(POSTGRES_USER|POSTGRES_DB)=' "$PROJECT_ROOT/.env")
  set +a
fi

POSTGRES_USER="${POSTGRES_USER:?POSTGRES_USER not set (check .env)}"
POSTGRES_DB="${POSTGRES_DB:?POSTGRES_DB not set (check .env)}"

mkdir -p "$BACKUP_DIR"
OUT_FILE="$BACKUP_DIR/jarvis-${POSTGRES_DB}-${TIMESTAMP}.sql.gz"

echo "[*] Dumping ${POSTGRES_DB} from ${CONTAINER_NAME}..."
docker exec "$CONTAINER_NAME" pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" | gzip > "$OUT_FILE"
echo "[*] Wrote $OUT_FILE ($(du -h "$OUT_FILE" | cut -f1))"

# Daily backups: ~2 weeks of history is enough to recover from any single
# bad day (bad migration, accidental delete) without unbounded disk growth.
cd "$BACKUP_DIR"
ls -1t "jarvis-${POSTGRES_DB}"-*.sql.gz 2>/dev/null | tail -n "+$((RETAIN + 1))" | xargs -r rm --
echo "[*] Retained the ${RETAIN} most recent backups in $BACKUP_DIR"

# A correct script that silently stopped running (cron entry removed, a
# systemd timer disabled, the host itself down) is indistinguishable from
# "backups are fine" until the day a restore is actually needed — this
# heartbeat is what scripts/check-backup-freshness.sh checks the age of, so
# staleness itself becomes an observable, alertable condition instead of a
# silent gap discovered too late.
date -u +%Y-%m-%dT%H:%M:%SZ > "$BACKUP_DIR/.last-success"
