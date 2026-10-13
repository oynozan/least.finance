#!/usr/bin/env bash
# Copies the repo to the VPS, rebuilds the stack there, and waits for the API's /ready; --dry-run only prints the commands.
set -euo pipefail

REMOTE_DIR=/opt/least-finance
ENV_FILE=/etc/least-finance/server.env
API_URL="${DEPLOY_API_URL:-https://api.least.finance}"
WAIT_SECONDS="${DEPLOY_WAIT_SECONDS:-300}"
POLL_SECONDS="${DEPLOY_POLL_SECONDS:-5}"

dry=0
if [ "${1:-}" = "--dry-run" ]; then
    dry=1
    shift
fi
[ $# -eq 1 ] || { echo "usage: deploy.sh [--dry-run] <ssh-host>" >&2; exit 2; }
host="$1"

cd "$(dirname "$0")/.."

run() {
    if [ "$dry" -eq 1 ]; then
        local arg out=+
        for arg in "$@"; do
            if [[ "$arg" =~ ^[A-Za-z0-9_./:=@,+-]+$ ]]; then out+=" $arg"; else out+=" '${arg//\'/\'\\\'\'}'"; fi
        done
        echo "$out"
    else
        "$@"
    fi
}

remote_compose="cd $REMOTE_DIR/deploy && docker compose --env-file $ENV_FILE"

# Prints the state and recent logs of every service that is not running healthy.
show_failures() {
    run ssh "$host" "$remote_compose ps -a; for s in \$($remote_compose ps -a --format '{{.Service}}|{{.State}}|{{.Health}}' | awk -F'|' '\$2 != \"running\" || (\$3 != \"\" && \$3 != \"healthy\") {print \$1}'); do echo \"--- \$s\"; $remote_compose logs --tail 60 \$s; done" || true
}

run rsync -az --delete \
    --exclude=.git --exclude=node_modules --exclude=.next --exclude='.env*' \
    --exclude=test-results --exclude=playwright-report --exclude=.superpowers --exclude=.DS_Store \
    --rsync-path="mkdir -p $REMOTE_DIR && rsync" \
    ./ "$host:$REMOTE_DIR/"

if ! run ssh "$host" "$remote_compose up -d --build"; then
    echo "deploy failed: docker compose up did not finish; the previous containers are still running" >&2
    show_failures
    exit 1
fi

if [ "$dry" -eq 1 ]; then
    echo "+ wait up to ${WAIT_SECONDS}s for $API_URL/ready to answer 200"
    exit 0
fi

waited=0
until curl -fsS -o /dev/null --max-time 5 "$API_URL/ready" 2>/dev/null; do
    if [ "$waited" -ge "$WAIT_SECONDS" ]; then
        echo "deploy failed: $API_URL/ready did not answer 200 within ${WAIT_SECONDS}s" >&2
        show_failures
        exit 1
    fi
    sleep "$POLL_SECONDS"
    waited=$((waited + 5))
done
echo "deployed: $API_URL/ready answers 200"
