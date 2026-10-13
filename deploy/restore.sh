#!/usr/bin/env bash
# Restores a backup archive into the running Mongo, replacing the collections it holds; --yes skips the confirmation.
set -euo pipefail

cd "$(dirname "$0")"
export COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml}"
export COMPOSE_ENV_FILES="${COMPOSE_ENV_FILES:-/etc/least-finance/server.env}"

yes=0
if [ "${1:-}" = "--yes" ]; then
    yes=1
    shift
fi
archive="${1:-}"
[ $# -eq 1 ] && [ -n "$archive" ] || { echo "usage: restore.sh [--yes] <archive>" >&2; exit 2; }
[ -s "$archive" ] || { echo "restore.sh: $archive is missing or empty" >&2; exit 1; }

if [ "$yes" -ne 1 ]; then
    echo "This replaces the data in the running database with the contents of $archive."
    read -r -p "Type yes to continue: " answer
    [ "$answer" = yes ] || { echo "aborted" >&2; exit 1; }
fi

# The dump holds one database; --drop replaces each collection it contains.
docker compose exec -T backup bash -c '
    conf="$(mktemp)"
    trap "rm -f \"$conf\"" EXIT
    printf "uri: mongodb://root@mongo:27017/?authSource=admin&replicaSet=rs0\npassword: \"%s\"\n" "$MONGO_ROOT_PASSWORD" >"$conf"
    mongorestore --config "$conf" --archive --gzip --drop --quiet
' <"$archive"
echo "restored $archive"
