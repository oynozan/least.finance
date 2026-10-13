#!/usr/bin/env bash
# The backup service's entry point: a gzip'd mongodump archive every night at 03:00 UTC, 14 days kept; --now runs one at once.
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/backups}"
KEEP_DAYS=14
DB="${MONGODB_DB:?}"
PREFIX=least-finance-

backup_once() {
    umask 077
    local stamp tmp conf
    stamp="$(date -u +%Y%m%dT%H%M%SZ)"
    tmp="$BACKUP_DIR/.$PREFIX$stamp.partial"
    conf="$(mktemp)"
    trap 'rm -f "$tmp" "$conf"' RETURN
    # The password goes through a config file so it never shows in the process list.
    printf 'uri: mongodb://root@mongo:27017/?authSource=admin&replicaSet=rs0\npassword: "%s"\n' "$MONGO_ROOT_PASSWORD" >"$conf"
    mongodump --config "$conf" --db "$DB" --archive="$tmp" --gzip --quiet
    chmod 600 "$tmp"
    mv "$tmp" "$BACKUP_DIR/$PREFIX$stamp.archive.gz"
    find "$BACKUP_DIR" -maxdepth 1 -name "$PREFIX*.archive.gz" -mmin "+$((KEEP_DAYS * 1440))" -delete
    echo "backup written: $PREFIX$stamp.archive.gz"
}

if [ "${1:-}" = "--now" ]; then
    backup_once
    exit 0
fi

while true; do
    now="$(date -u +%s)"
    next="$(date -u -d "today 03:00" +%s)"
    [ "$next" -gt "$now" ] || next="$(date -u -d "tomorrow 03:00" +%s)"
    sleep "$((next - now))"
    backup_once || echo "backup failed" >&2
done
