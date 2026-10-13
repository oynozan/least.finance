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

echo "smoke passed"
