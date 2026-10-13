#!/usr/bin/env bash
# Reports the age of the newest backup on the VPS and fails when there is none or it is over 26 hours old.
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/backups/least-finance}"
MAX_HOURS=26

newest="$(ls -1t "$BACKUP_DIR"/least-finance-*.archive.gz 2>/dev/null | head -n 1 || true)"
if [ -z "$newest" ]; then
    echo "FAIL: no backup in $BACKUP_DIR" >&2
    exit 1
fi
mtime="$(stat -c %Y "$newest" 2>/dev/null || stat -f %m "$newest")"
age_hours=$((($(date +%s) - mtime) / 3600))
if [ "$age_hours" -gt "$MAX_HOURS" ]; then
    echo "WARN: the newest backup, $(basename "$newest"), is $age_hours hours old (over $MAX_HOURS)" >&2
    exit 1
fi
echo "ok: the newest backup, $(basename "$newest"), is $age_hours hours old"
