#!/usr/bin/env bash
# Builds the whole stack locally as compose project lf-smoke, checks it through Caddy, and tears it down.
set -euo pipefail

cd "$(dirname "$0")"
PROJECT=lf-smoke
SITE=lf-web.localhost
API=lf-api.localhost
HTTPS_PORT=18443
WORK="$(mktemp -d)"

compose() {
    docker compose -p "$PROJECT" --env-file smoke.env -f docker-compose.yml -f compose.smoke.yml "$@"
}

cleanup() {
    status=$?
    if [ "$status" -ne 0 ]; then compose logs --tail 40 server web caddy mongo 2>&1 || true; fi
    compose down -v --remove-orphans >/dev/null 2>&1 || true
    rm -rf "$WORK"
    exit "$status"
}
trap cleanup EXIT

fail() {
    echo "FAIL: $*" >&2
    exit 1
}

pass() {
    echo "ok: $*"
}

# A throwaway ES256 key pair: the server trusts the public half, the socket check signs with the private half.
openssl ecparam -name prime256v1 -genkey -noout | openssl pkcs8 -topk8 -nocrypt -out "$WORK/privy.key"
openssl pkey -in "$WORK/privy.key" -pubout -out "$WORK/privy.pub"
SMOKE_PRIVY_PUBLIC_KEY="$(cat "$WORK/privy.pub")"
export SMOKE_PRIVY_PUBLIC_KEY

compose up -d --build --wait --wait-timeout 300

curl_site() {
    curl -ksS --max-time 20 -o /dev/null -w '%{http_code}' --resolve "$1:$HTTPS_PORT:127.0.0.1" "https://$1:$HTTPS_PORT$2"
}

[ "$(curl_site "$SITE" /)" = 200 ] || fail "web did not answer 200 through Caddy"
pass "web answers 200 through Caddy"

[ "$(curl_site "$API" /health)" = 200 ] || fail "/health did not answer 200 through Caddy"
pass "/health answers 200 through Caddy"

api_url="$(grep '^NEXT_PUBLIC_API_URL=' smoke.env | cut -d= -f2-)"
compose exec -T web grep -rqF "$api_url" /app/.next/static || fail "the web bundle lacks the API URL it was built with"
pass "the web bundle carries $api_url"

PRIVY_KEY_FILE="$WORK/privy.key" \
    SMOKE_API_HOST="$API" SMOKE_SITE_ORIGIN="https://$SITE:$HTTPS_PORT" SMOKE_PORT="$HTTPS_PORT" \
    SMOKE_PRIVY_APP_ID="$(grep '^PRIVY_APP_ID=' smoke.env | cut -d= -f2-)" \
    node smoke-socket.mjs || fail "socket.io did not connect through Caddy"
pass "socket.io connects and upgrades to a websocket through Caddy"

if out="$(compose run --rm --no-deps -T -e TRUST_PROXY=0 server 2>&1)"; then
    fail "the server started in production with TRUST_PROXY=0"
fi
grep -q 'TRUST_PROXY' <<<"$out" || fail "the refusal does not name TRUST_PROXY"
pass "the server refuses to start with TRUST_PROXY=0"

# Runs a mongosh script against the replica set as the root user; the password stays inside the container.
mongo_eval() {
    compose exec -T mongo bash -c 'mongosh --quiet -u root -p "$MONGO_ROOT_PASSWORD" --authenticationDatabase admin --eval "$1"' _ "$1"
}

# Prints "collection=count" lines for every collection of a database, sorted.
mongo_counts() {
    mongo_eval "const d = db.getSiblingDB('$1'); d.getCollectionNames().sort().forEach(n => print(n + '=' + d.getCollection(n).countDocuments({})))"
}

DB="$(grep '^MONGODB_DB=' smoke.env | cut -d= -f2-)"
mongo_eval "
    const d = db.getSiblingDB('$DB');
    d.seed_accounts.insertMany(Array.from({ length: 25 }, (_, i) => ({ _id: 'acct-' + i, balance: i * 10 })));
    d.seed_accounts.createIndex({ balance: 1 });
    d.seed_orders.insertMany(Array.from({ length: 7 }, (_, i) => ({ _id: 'order-' + i, side: i % 2 ? 'buy' : 'sell' })));
    d.seed_deposits.insertOne({ _id: 'dep-1', amount: '12.5' });
" >/dev/null
mongo_counts "$DB" >"$WORK/counts.before"
grep -qx 'seed_accounts=25' "$WORK/counts.before" || fail "the seed documents are missing before the backup"

compose exec -T backup touch -d '20 days ago' /backups/least-finance-19700101T000000Z.archive.gz
compose exec -T backup bash /lf-backup/backup.sh --now >/dev/null || fail "backup.sh --now failed"
listing="$(compose exec -T backup bash -c 'stat -c "%a %n" /backups/*')"
[ "$(wc -l <<<"$listing")" -eq 1 ] || fail "expected exactly one archive after the backup, found: $listing"
grep -Eq '^600 /backups/least-finance-2[0-9TZ]+\.archive\.gz$' <<<"$listing" || fail "the archive is missing or not mode 600: $listing"
mkdir "$WORK/backups"
compose cp backup:/backups/. "$WORK/backups"
archive="$(ls "$WORK"/backups/least-finance-2*.archive.gz)"
[ -s "$archive" ] || fail "the archive is empty"
pass "backup.sh --now writes one mode 600 archive and prunes the one past 14 days"

mongo_eval "db.getSiblingDB('$DB').dropDatabase()" >/dev/null
[ -z "$(mongo_counts "$DB")" ] || fail "the database was not wiped"

COMPOSE_FILE="docker-compose.yml:compose.smoke.yml" COMPOSE_PROJECT_NAME="$PROJECT" COMPOSE_ENV_FILES=smoke.env \
    bash restore.sh --yes "$archive" >/dev/null || fail "restore.sh failed"
mongo_counts "$DB" >"$WORK/counts.after"
diff "$WORK/counts.before" "$WORK/counts.after" >/dev/null || fail "restored collection counts differ from the backed-up ones"
[ "$(mongo_eval "db.getSiblingDB('$DB').seed_accounts.getIndexes().length")" = 2 ] || fail "the restore lost an index"
pass "a wiped database restores from the backup with the same per-collection counts"

if bash restore.sh /nonexistent </dev/null >/dev/null 2>&1; then fail "restore.sh accepted a missing archive"; fi
pass "restore.sh refuses a missing archive"

echo "smoke passed"
