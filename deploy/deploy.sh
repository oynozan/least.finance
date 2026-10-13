#!/usr/bin/env bash
# Copies the committed repo to the VPS, backs up, rebuilds the stack there, records the revision and waits for the API's /ready; --dry-run only prints the commands.
set -euo pipefail

REMOTE_DIR=/opt/least-finance
ENV_FILE=/etc/least-finance/server.env
API_URL="${DEPLOY_API_URL:-https://api.least.finance}"
WAIT_SECONDS="${DEPLOY_WAIT_SECONDS:-300}"
POLL_SECONDS="${DEPLOY_POLL_SECONDS:-5}"

dry=0
allow_dirty=0
skip_backup=0
while [ $# -gt 0 ]; do
    case "$1" in
    --dry-run) dry=1 ;;
    --allow-dirty) allow_dirty=1 ;;
    --skip-backup) skip_backup=1 ;;
    -*) echo "unknown option: $1" >&2; exit 2 ;;
    *) break ;;
    esac
    shift
done
[ $# -eq 1 ] || { echo "usage: deploy.sh [--dry-run] [--allow-dirty] [--skip-backup] <ssh-host>" >&2; exit 2; }
host="$1"

cd "$(dirname "$0")/.."

# Anything uncommitted outside .superpowers/ and .impeccable/ would be deployed under a commit that does not contain it.
dirty="$(git status --porcelain -- . ':!.superpowers' ':!.impeccable')"
rev="$(git rev-parse HEAD)"
if [ -n "$dirty" ]; then
    if [ "$allow_dirty" -eq 0 ]; then
        echo "deploy refused: uncommitted changes would go live under commit $rev (commit them, or pass --allow-dirty):" >&2
        echo "$dirty" >&2
        exit 1
    fi
    rev="$rev-dirty"
fi

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
    --exclude=test-results --exclude=playwright-report --exclude=.superpowers --exclude=.claude --exclude=.impeccable --exclude=.DS_Store \
    --exclude=/REVISION --exclude=/REVISION.previous \
    --rsync-path="mkdir -p $REMOTE_DIR && rsync" \
    ./ "$host:$REMOTE_DIR/"

# A running stack is backed up first; a failed backup stops the deploy.
if [ "$skip_backup" -eq 0 ]; then
    if ! run ssh "$host" "if [ -n \"\$($remote_compose ps --status running -q)\" ]; then $remote_compose exec -T backup bash /lf-backup/backup.sh --now; fi"; then
        echo "deploy stopped: the pre-deploy backup failed (fix it, or pass --skip-backup)" >&2
        exit 1
    fi
fi

if ! run ssh "$host" "$remote_compose up -d --build"; then
    echo "deploy failed: the build or docker compose up did not finish; the previous containers are still running" >&2
    show_failures
    exit 1
fi

# The live commit goes to REVISION, the one it replaces to REVISION.previous.
previous=
[ "$dry" -eq 1 ] || previous="$(ssh "$host" "cat $REMOTE_DIR/REVISION 2>/dev/null || true")"
run ssh "$host" "{ [ ! -f $REMOTE_DIR/REVISION ] || cp $REMOTE_DIR/REVISION $REMOTE_DIR/REVISION.previous; } && echo '$rev '\$(date -u +%Y-%m-%dT%H:%M:%SZ) > $REMOTE_DIR/REVISION"

if [ "$dry" -eq 1 ]; then
    echo "+ wait up to ${WAIT_SECONDS}s for $API_URL/ready to answer 200"
    exit 0
fi

waited=0
until curl -fsS -o /dev/null --max-time 5 "$API_URL/ready" 2>/dev/null; do
    if [ "$waited" -ge "$WAIT_SECONDS" ]; then
        echo "deploy failed: $API_URL/ready did not answer 200 within ${WAIT_SECONDS}s; the new containers are up but unhealthy" >&2
        show_failures
        echo "to roll back, redeploy the commit named in $REMOTE_DIR/REVISION.previous on the server (previous: ${previous:-none recorded})" >&2
        exit 1
    fi
    sleep "$POLL_SECONDS"
    waited=$((waited + 5))
done
echo "deployed: $rev ($API_URL/ready answers 200)"
echo "replaced: ${previous:-none recorded}"
