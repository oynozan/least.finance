#!/usr/bin/env bash
# Tests deploy.sh and preflight.sh against stub ssh, rsync, curl, docker and getent commands.
# The checks are eval'd strings, so shellcheck sees their variables as unused or unexpanded.
# shellcheck disable=SC2016,SC2034,SC2018,SC2019
set -euo pipefail

cd "$(dirname "$0")"
HERE="$PWD"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir "$WORK/bin"
failures=0

check() {
    if eval "$2"; then echo "ok: $1"; else echo "FAIL: $1" >&2; failures=$((failures + 1)); fi
}

# Every stub logs its arguments to $LOG; curl's answers come from $CURL_CODES (one per call, the last repeats).
for tool in ssh rsync docker; do
    printf '#!/usr/bin/env bash\necho "%s $*" >>"$LOG"\nexit "${%s_EXIT:-0}"\n' "$tool" "$(echo "$tool" | tr a-z A-Z)" >"$WORK/bin/$tool"
done
cat >"$WORK/bin/curl" <<'STUB'
#!/usr/bin/env bash
echo "curl $*" >>"$LOG"
case "$*" in
*geoblock*) printf '%s' "${GEO_BODY:-}"; exit 0 ;;
esac
n="$(cat "$WORK/curl.n" 2>/dev/null || echo 0)"
echo $((n + 1)) >"$WORK/curl.n"
read -r -a codes <<<"$CURL_CODES"
code="${codes[$n]:-${codes[${#codes[@]}-1]}}"
[ "$code" = 200 ] || exit 22
STUB
cat >"$WORK/bin/getent" <<'STUB'
#!/usr/bin/env bash
case "$2" in
good.example) echo "203.0.113.7 STREAM $2" ;;
*) exit 2 ;;
esac
STUB
printf '#!/usr/bin/env bash\nexit 1\n' >"$WORK/bin/mongodump"
chmod +x "$WORK/bin/"*
export WORK LOG="$WORK/log"
export DEPLOY_POLL_SECONDS=0 DEPLOY_WAIT_SECONDS=30

fresh() { : >"$LOG"; rm -f "$WORK/curl.n"; }

# --- deploy.sh ---
# deploy.sh runs from a throwaway git repo so the test does not depend on the real tree's state.
REPO="$WORK/repo"
mkdir -p "$REPO/deploy" "$REPO/.superpowers"
cp "$HERE/deploy.sh" "$REPO/deploy/deploy.sh"
git -C "$REPO" init -q
git -C "$REPO" add -A
git -C "$REPO" -c user.name=t -c user.email=t@example.com commit -q -m init
HEAD_SHA="$(git -C "$REPO" rev-parse HEAD)"
DEPLOY="$REPO/deploy/deploy.sh"

fresh
out="$("$DEPLOY" --dry-run vps 2>&1)"
check "dry run prints an rsync command" '[[ "$out" == *"+ rsync"* && "$out" == *"vps:/opt/least-finance/"* ]]'
check "dry run prints the compose command" '[[ "$out" == *"docker compose --env-file /etc/least-finance/server.env up -d --build"* ]]'
check "dry run runs nothing" '[ ! -s "$LOG" ]'
check "rsync leaves out node_modules, .next, .env*, test output, .superpowers, .claude and .impeccable" \
    '[[ "$out" == *"--exclude=node_modules"* && "$out" == *"--exclude=.next"* && "$out" == *"--exclude=.env*"* && "$out" == *"--exclude=test-results"* && "$out" == *"--exclude=.superpowers"* && "$out" == *"--exclude=.claude"* && "$out" == *"--exclude=.impeccable"* ]]'
check "rsync keeps the REVISION files on the server" '[[ "$out" == *"--exclude=/REVISION "* && "$out" == *"--exclude=/REVISION.previous"* ]]'
check "dry run writes REVISION with the commit and moves the old one to REVISION.previous" \
    '[[ "$out" == *"$HEAD_SHA"* && "$out" == *"/opt/least-finance/REVISION"* && "$out" == *"REVISION.previous"* ]]'
check "dry run backs up before compose up" '[[ "$out" == *"backup.sh --now"* && "${out%%backup.sh --now*}" != *"up -d --build"* ]]'
out="$("$DEPLOY" --dry-run --skip-backup vps 2>&1)"
check "--skip-backup leaves the backup out" '[[ "$out" != *"backup.sh --now"* ]]'

fresh
CURL_CODES="000 000 200" PATH="$WORK/bin:$PATH" "$DEPLOY" vps >"$WORK/out" 2>&1 && rc=0 || rc=$?
check "a deploy that becomes ready succeeds" '[ "$rc" = 0 ] && grep -q "^rsync " "$LOG" && grep -q "^ssh .*up -d --build" "$LOG"'
check "it polls /ready until 200" '[ "$(grep -c "api.least.finance/ready" "$LOG")" = 3 ]'
check "it backs up on the server before compose up" 'grep -n "backup.sh --now" "$LOG" | head -n 1 | cut -d: -f1 | { read -r b; read -r u < <(grep -n "up -d --build" "$LOG" | head -n 1 | cut -d: -f1); [ "$b" -lt "$u" ]; }'
check "it reports the live revision" 'grep -q "deployed: $HEAD_SHA" "$WORK/out"'

fresh
CURL_CODES="000" PATH="$WORK/bin:$PATH" "$DEPLOY" vps >"$WORK/out" 2>&1 && rc=0 || rc=$?
check "a deploy that never becomes ready fails" '[ "$rc" != 0 ]'
check "it asks for the failing services' logs" 'grep -q "^ssh .*logs --tail" "$LOG"'
check "a failed health wait says the new containers are up but unhealthy and names the rollback" \
    'grep -q "new containers are up but unhealthy" "$WORK/out" && grep -q "REVISION.previous" "$WORK/out" && ! grep -q "previous containers are still running" "$WORK/out"'

fresh
DOCKER_EXIT=0 SSH_EXIT=1 CURL_CODES="200" PATH="$WORK/bin:$PATH" "$DEPLOY" vps >"$WORK/out" 2>&1 && rc=0 || rc=$?
check "a failed ssh step fails the deploy" '[ "$rc" != 0 ]'

"$DEPLOY" >"$WORK/out" 2>&1 && rc=0 || rc=$?
check "no host is a usage error" '[ "$rc" = 2 ]'

# A dirty tree.
echo change >"$REPO/file.txt"
echo notes >"$REPO/.superpowers/notes.md"
fresh
PATH="$WORK/bin:$PATH" "$DEPLOY" vps >"$WORK/out" 2>&1 && rc=0 || rc=$?
check "a dirty tree is refused and the blocking file is named" '[ "$rc" != 0 ] && grep -q "file.txt" "$WORK/out" && [ ! -s "$LOG" ]'
check "changes under .superpowers do not block" '! grep -q "superpowers" "$WORK/out"'
out="$("$DEPLOY" --dry-run --allow-dirty vps 2>&1)" && rc=0 || rc=$?
check "--allow-dirty deploys and marks the revision -dirty" '[ "$rc" = 0 ] && [[ "$out" == *"$HEAD_SHA-dirty"* ]]'
rm "$REPO/file.txt"

# --- backup.sh ---
mkdir "$WORK/bk"
touch "$WORK/bk/.hidden"
MONGODB_DB=x MONGO_ROOT_PASSWORD=p BACKUP_DIR="$WORK/bk" PATH="$WORK/bin:$PATH" bash "$HERE/backup.sh" --now >"$WORK/out" 2>&1 && rc=0 || rc=$?
check "a failing backup exits non-zero" '[ "$rc" != 0 ]'

# --- status.sh ---
status() { BACKUP_DIR="$WORK/bk" "$HERE/status.sh" >"$WORK/out" 2>&1 && rc=0 || rc=$?; }
status
check "no backup at all is a failure" '[ "$rc" != 0 ] && grep -q "FAIL.*no backup" "$WORK/out"'
touch "$WORK/bk/least-finance-new.archive.gz"
status
check "a fresh backup is ok" '[ "$rc" = 0 ] && grep -q "^ok:.*backup" "$WORK/out"'
touch -t 202001010000 "$WORK/bk/least-finance-new.archive.gz"
status
check "a backup older than 26 hours warns and fails" '[ "$rc" != 0 ] && grep -q "WARN.*26" "$WORK/out"'

# --- preflight.sh ---
envfile="$WORK/server.env"
printf 'SITE_HOST=good.example\nAPI_HOST=good.example\nSECRET_VALUE=hunter2\n' >"$envfile"
chmod 600 "$envfile"
owner="$(id -un)"
pf() { PATH="$WORK/bin:$PATH" PREFLIGHT_ENV_FILE="$envfile" PREFLIGHT_OWNER="$owner" "$HERE/preflight.sh" >"$WORK/out" 2>&1 && rc=0 || rc=$?; }

fresh
GEO_BODY='{"blocked":false,"ip":"203.0.113.7","country":"DE","region":"BE"}' pf
check "a good host passes" '[ "$rc" = 0 ]'
check "preflight never prints the env file's contents" '! grep -q hunter2 "$WORK/out"'

GEO_BODY='{"blocked":true,"ip":"203.0.113.7","country":"US","region":"NY"}' pf
check "a Polymarket-blocked IP fails" '[ "$rc" != 0 ] && grep -q "FAIL.*Polymarket" "$WORK/out"'

GEO_BODY='{"blocked":false,"ip":"198.51.100.9","country":"DE","region":"BE"}' pf
check "DNS pointing elsewhere fails" '[ "$rc" != 0 ] && grep -q "FAIL.*good.example" "$WORK/out"'

chmod 644 "$envfile"
GEO_BODY='{"blocked":false,"ip":"203.0.113.7","country":"DE","region":"BE"}' pf
check "a loose env file mode fails" '[ "$rc" != 0 ] && grep -q "FAIL.*mode" "$WORK/out"'
chmod 600 "$envfile"

printf 'SITE_HOST=missing.example\nAPI_HOST=good.example\n' >"$envfile"
GEO_BODY='{"blocked":false,"ip":"203.0.113.7","country":"DE","region":"BE"}' pf
check "an unresolvable name fails" '[ "$rc" != 0 ] && grep -q "FAIL.*missing.example" "$WORK/out"'

printf 'SITE_HOST=good.example\nAPI_HOST=good.example\nMONGO_ROOT_PASSWORD=abc123\nMONGO_APP_PASSWORD=ab$c"d\n' >"$envfile"
GEO_BODY='{"blocked":false,"ip":"203.0.113.7","country":"DE","region":"BE"}' pf
check "a password with characters beyond letters and digits warns, by name and without its value" \
    'grep -q "WARN.*MONGO_APP_PASSWORD" "$WORK/out" && ! grep -q "WARN.*MONGO_ROOT_PASSWORD" "$WORK/out" && ! grep -q "ab\$c" "$WORK/out"'

[ "$failures" = 0 ] || { echo "$failures check(s) failed" >&2; exit 1; }
echo "all checks passed"
