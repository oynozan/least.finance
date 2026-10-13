#!/usr/bin/env bash
# Checks a VPS before the first deploy: Docker, the env file's mode and owner, DNS for both names, and Polymarket's geoblock answer.
set -euo pipefail

ENV_FILE="${PREFLIGHT_ENV_FILE:-/etc/least-finance/server.env}"
OWNER="${PREFLIGHT_OWNER:-root}"
GEOBLOCK_URL="${GEOBLOCK_URL:-https://polymarket.com/api/geoblock}"

failed=0
pass() { echo "ok: $*"; }
fail() {
    echo "FAIL: $*" >&2
    failed=1
}

# Reads one variable from the env file without printing anything else in it.
env_value() {
    sed -n "s/^$1=//p" "$ENV_FILE" 2>/dev/null | tail -n 1 | tr -d '"'"'"'\r'
}

if docker version >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    pass "Docker and the Compose plugin are installed and the daemon answers"
else
    fail "Docker or the Compose plugin is missing, or the daemon is not running"
fi

if [ -f "$ENV_FILE" ]; then
    stat_out="$(stat -c '%a %U' "$ENV_FILE" 2>/dev/null || stat -f '%Lp %Su' "$ENV_FILE")"
    mode="${stat_out% *}"
    owner="${stat_out#* }"
    if [ "$mode" = 600 ]; then pass "$ENV_FILE has mode 600"; else fail "$ENV_FILE has mode $mode, not 600 (chmod 600 $ENV_FILE)"; fi
    if [ "$owner" = "$OWNER" ]; then pass "$ENV_FILE is owned by $OWNER"; else fail "$ENV_FILE is owned by $owner, not $OWNER (chown $OWNER:$OWNER $ENV_FILE)"; fi
else
    fail "$ENV_FILE does not exist"
fi

geo="$(curl -fsS --max-time 15 "$GEOBLOCK_URL" 2>/dev/null || true)"
server_ip="$(printf '%s' "$geo" | sed -n 's/.*"ip": *"\([^"]*\)".*/\1/p')"
if [[ "$geo" == *'"blocked":false'* || "$geo" == *'"blocked": false'* ]]; then
    pass "Polymarket's geoblock allows this server's IP${server_ip:+ ($server_ip)}"
elif [[ "$geo" == *'"blocked"'* ]]; then
    fail "Polymarket blocks this server's IP${server_ip:+ ($server_ip)}: pick a VPS in an allowed region"
else
    fail "Polymarket's geoblock ($GEOBLOCK_URL) gave no usable answer"
fi

for key in SITE_HOST API_HOST; do
    default=least.finance
    [ "$key" = API_HOST ] && default=api.least.finance
    name="${!key:-$(env_value "$key")}"
    name="${name:-$default}"
    addrs="$(getent ahostsv4 "$name" 2>/dev/null | awk '{print $1}' | sort -u | tr '\n' ' ' || true)"
    if [ -z "$addrs" ]; then
        fail "$name does not resolve; add an A record for it"
    elif [ -z "$server_ip" ]; then
        pass "$name resolves to ${addrs% } (this server's IP is unknown, so it was not compared)"
    elif [[ " $addrs" == *" $server_ip "* ]]; then
        pass "$name resolves to this server ($server_ip)"
    else
        fail "$name resolves to ${addrs% }, not this server ($server_ip)"
    fi
done

# Passwords with anything beyond letters and digits break compose interpolation, the YAML config or the Mongo URI.
for key in MONGO_ROOT_PASSWORD MONGO_APP_PASSWORD; do
    value="${!key:-$(env_value "$key")}"
    if [ -z "$value" ]; then
        echo "WARN: $key is not set in $ENV_FILE" >&2
    elif [[ ! "$value" =~ ^[A-Za-z0-9]+$ ]]; then
        echo "WARN: $key contains characters other than A-Z, a-z and 0-9; generate it with: openssl rand -hex 32" >&2
    else
        pass "$key is letters and digits only"
    fi
done

exit "$failed"
