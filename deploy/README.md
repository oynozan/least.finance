# Deploying Least Finance

One VPS runs everything with Docker Compose: Caddy (the only open ports, 80 and 443, with automatic TLS), the web app, the API, a single-node MongoDB replica set and a nightly backup service. Deploys run from your machine with `deploy/deploy.sh`. There is no CI and no alerting; health shows in `docker compose ps` and the logs.

| Name                | Goes to                                    |
| ------------------- | ------------------------------------------ |
| `least.finance`     | the web app (`web:3000`)                   |
| `api.least.finance` | the API and its websockets (`server:4500`) |

The design is in [the deployment spec](../docs/superpowers/specs/2026-10-14-deployment-design.md). Replace `HOST` below with the VPS's IP address or SSH name. Commands marked "on the VPS" run in a root shell there (`ssh root@HOST`); the rest run on your machine in the repo root.

## 1. Choose the server and its region

The pool trades on Polymarket from the server's own IP, and traffic is never routed through a proxy. So the VPS must sit in a country Polymarket allows trading from. Check the current list in Polymarket's docs ([geographic restrictions](https://docs.polymarket.com/api-reference/geoblock)) before you buy, and confirm the real machine in step 3: `preflight.sh` calls Polymarket's public geoblock endpoint, `GET https://polymarket.com/api/geoblock`, which answers `{"blocked":false,"ip":"...","country":"..","region":".."}` for the caller's IP.

Size: 2 vCPUs, 4 GB of memory and 40 GB of disk is enough to start; the image builds need the memory.

## 2. Provision the VPS

Ubuntu 24.04 LTS. Put your SSH public key on it (your provider's panel, or `ssh-copy-id root@HOST`), confirm `ssh root@HOST` works without a password, then on the VPS:

```bash
# SSH keys only
cat >/etc/ssh/sshd_config.d/10-least-finance.conf <<'CONF'
PasswordAuthentication no
PermitRootLogin prohibit-password
CONF
systemctl restart ssh

# Firewall: SSH, HTTP, HTTPS (and HTTP/3)
apt-get update
apt-get install -y ufw
ufw default deny incoming
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp
ufw --force enable

# Security updates install themselves
apt-get install -y unattended-upgrades
cat >/etc/apt/apt.conf.d/20auto-upgrades <<'CONF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
CONF

# Docker Engine and the Compose plugin, from Docker's apt repository
apt-get install -y ca-certificates curl
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" >/etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

# Where the backups land
install -d -m 700 /var/backups/least-finance
```

Only Caddy publishes ports, so Docker's firewall bypass for published ports does not expose MongoDB or the API.

## 3. Point DNS at it

At your DNS provider, add two `A` records (and `AAAA` if the VPS has IPv6) to the VPS's address: `least.finance` and `api.least.finance`. Caddy asks Let's Encrypt for the certificates on first start, which needs both names to resolve to this server and ports 80 and 443 to be reachable.

## 4. Create the env file

The file holds every secret, so it lives only on the server, owned by root with mode 600. On the VPS, create it empty with those permissions:

```bash
install -d -m 700 /etc/least-finance
install -m 600 -o root -g root /dev/null /etc/least-finance/server.env
```

Then, on your machine, append the API's variable list to it (a blank value counts as unset):

```bash
ssh root@HOST 'cat >> /etc/least-finance/server.env' < server/.env.example
```

Edit it on the VPS (`nano /etc/least-finance/server.env`) and fill in at least these. Remove any variable that ends up on two lines.

| Variable                                                     | Value                                                                                                                      |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `CORS_ORIGINS`                                               | `https://least.finance`                                                                                                    |
| `PRIVY_APP_ID`, `PRIVY_APP_SECRET`, `PRIVY_VERIFICATION_KEY` | From the Privy dashboard (Settings, Basics)                                                                                |
| `DEPOSIT_MNEMONIC`                                           | A fresh phrase from `npm run mnemonic` in `server/`. It holds every deposit: back it up off the server and never change it |
| `NEXT_PUBLIC_API_URL`                                        | `https://api.least.finance`                                                                                                |
| `NEXT_PUBLIC_PRIVY_APP_ID`, `NEXT_PUBLIC_PRIVY_CLIENT_ID`    | From the Privy dashboard. Next bakes these into the web image at build time                                                |
| `MONGO_ROOT_PASSWORD`, `MONGO_APP_PASSWORD`                  | Two random strings, each from `openssl rand -hex 32` (see below)                                                           |
| `MONGODB_DB`                                                 | Optional, defaults to `TradeEverything`                                                                                    |
| `PREDICTIONS_TRADING`                                        | Leave `off` until the live check in the [README](../README.md#prediction-trading) has passed                               |
| Optional: `SITE_HOST`, `API_HOST`, `BACKUP_DIR`              | Default to `least.finance`, `api.least.finance` and `/var/backups/least-finance`                                           |

Generate every password and secret in the file with `openssl rand -hex 32`, which gives letters and digits only. Other characters break things: `$` breaks compose interpolation, quotes break the YAML config, and `@`, `:`, `/` and the like break the `MONGODB_URI`. Paste the output beside each line:

```bash
MONGO_ROOT_PASSWORD=   # openssl rand -hex 32
MONGO_APP_PASSWORD=    # openssl rand -hex 32
```

`preflight.sh` warns when either Mongo password holds anything but `A-Za-z0-9`.

Leave `MONGODB_URI`, `NODE_ENV`, `TRUST_PROXY`, `HOST` and `PORT` out: the compose file sets them (production mode, one proxy, the stack's own database). In production the API refuses to start if `CORS_ORIGINS` is not `https://`, if `TRUST_PROXY` is 0 or if the database URI has no credentials, and it names each problem in its log.

Also add the Privy dashboard's allowed origin `https://least.finance` for the app.

## 5. Run the preflight check

It runs on the VPS and checks Docker, the env file's mode and owner, DNS for both names against the server's own IP, and Polymarket's geoblock answer. Run it from your machine, without copying anything first:

```bash
ssh root@HOST 'bash -s' < deploy/preflight.sh
```

Every line must start with `ok:`. A `FAIL:` line says what to fix; DNS changes can take a few minutes to arrive. If the geoblock line fails, this VPS is in a region that Polymarket blocks: use another region rather than a proxy.

## 6. The first deploy

```bash
deploy/deploy.sh --dry-run root@HOST   # prints the rsync and compose commands without running them
deploy/deploy.sh root@HOST
```

The script refuses to deploy while the working tree has uncommitted changes (outside `.superpowers/` and `.impeccable/`) and lists the files that block it; `--allow-dirty` deploys anyway and marks the revision `-dirty`. It copies the repo to `/opt/least-finance` on the VPS (leaving out `.git`, `node_modules`, `.next`, `.env*`, test output, `.superpowers`, `.claude` and `.impeccable`), backs up a running stack (`--skip-backup` skips this; a failed backup stops the deploy), runs `docker compose --env-file /etc/least-finance/server.env up -d --build` there, then waits up to five minutes for `https://api.least.finance/ready` to answer 200. It then records the commit in `/opt/least-finance/REVISION` (the one it replaces goes to `REVISION.previous`) and prints both. The first build takes several minutes. If it never gets there it prints the logs of every service that is not healthy and exits non-zero. The SSH user needs to read the env file and use Docker, which in practice means `root`, so pass `root@HOST`, not a bare address.

The stack is not running yet, so take the first backup by hand and check the file exists. On the VPS:

```bash
cd /opt/least-finance/deploy
docker compose --env-file /etc/least-finance/server.env exec -T backup bash /lf-backup/backup.sh --now
ls -lh /var/backups/least-finance
```

Then check it from outside: open `https://least.finance`, sign in, and look at `ssh root@HOST 'cd /opt/least-finance/deploy && docker compose --env-file /etc/least-finance/server.env ps'`: every service should be `running`, and `server`, `web` and `mongo` `healthy`.

In the rest of this file, `compose` on the VPS means:

```bash
cd /opt/least-finance/deploy
alias compose='docker compose --env-file /etc/least-finance/server.env'
```

## 7. Update

Run `deploy/deploy.sh root@HOST` again from the commit you want live. Compose rebuilds only the images whose inputs changed and recreates only those containers. The database and the certificates stay on their volumes.

Watch the logs after an update with `compose logs -f --tail 100 server` on the VPS.

## 8. Roll back

Redeploy the previous commit, named in `REVISION.previous` (`ssh root@HOST cat /opt/least-finance/REVISION.previous`). From a separate worktree, so your working copy stays as it is:

```bash
git worktree add ../least-finance-rollback <previous-commit>
../least-finance-rollback/deploy/deploy.sh root@HOST
git worktree remove ../least-finance-rollback
```

A rollback does not undo data changes. If the bad release wrote bad data, restore a backup too (step 10).

## 9. Backups

The `backup` service writes a gzip'd `mongodump` archive at 03:00 UTC every night to `/var/backups/least-finance` on the VPS (mode 600, named `least-finance-<timestamp>.archive.gz`) and deletes the ones older than 14 days. To take one now, on the VPS:

```bash
compose exec -T backup bash /lf-backup/backup.sh --now
ls -lh /var/backups/least-finance
```

Every deploy of a running stack takes one first, and `deploy/status.sh` reports the newest backup's age and warns when it is over 26 hours:

```bash
ssh root@HOST 'bash -s' < deploy/status.sh
```

The backups share the server's disk, so copy them off it. This line goes in the crontab of your own machine (`crontab -e`). Every night at 07:00 it pulls the newest archive over SSH into `~/least-finance-backups` and deletes local copies older than 30 days. Replace `HOST`:

```cron
0 7 * * * mkdir -p ~/least-finance-backups && rsync -a --chmod=F600 "root@HOST:$(ssh root@HOST 'ls -1t /var/backups/least-finance/least-finance-*.archive.gz | head -n 1')" ~/least-finance-backups/ && find ~/least-finance-backups -name 'least-finance-*.archive.gz' -mtime +30 -delete
```

A weekly check that the newest local copy is under 26 hours old (it fails, and cron mails you, when it is not):

```cron
0 8 * * 1 test -n "$(find ~/least-finance-backups -name 'least-finance-*.archive.gz' -mmin -1560 | head -n 1)"
```

Keep the copies somewhere encrypted. They hold every account and balance.

## 10. Restore, and the restore drill

`deploy/restore.sh <archive>` replaces the collections in the running database with the ones in the archive, after you type `yes` (`--yes` skips the question). Anything written since the backup is lost, so stop the API first for a real restore: `compose stop server`, restore, then `compose start server`.

Do a drill once after the first deploy and again from time to time, so you know the backups work. The drill stops the API first so nothing is written between the backup and the restore. On the VPS, with the stack running:

```bash
cd /opt/least-finance/deploy
alias compose='docker compose --env-file /etc/least-finance/server.env'
count='db.getCollectionNames().sort().forEach(c => print(c, db[c].countDocuments()))'

compose stop server

compose exec -T backup bash /lf-backup/backup.sh --now
compose exec -T mongo bash -c "mongosh --quiet -u root -p \"\$MONGO_ROOT_PASSWORD\" --authenticationDatabase admin \"\$MONGODB_DB\" --eval '$count'" > /tmp/counts-before.txt

./restore.sh "$(ls -1t /var/backups/least-finance/least-finance-*.archive.gz | head -n 1)"
compose exec -T mongo bash -c "mongosh --quiet -u root -p \"\$MONGO_ROOT_PASSWORD\" --authenticationDatabase admin \"\$MONGODB_DB\" --eval '$count'" > /tmp/counts-after.txt
compose start server

diff /tmp/counts-before.txt /tmp/counts-after.txt && echo "restore drill passed: every collection has the same document count"
```

No diff output means every collection came back with the same number of documents. To restore a copy from your machine, `scp` the archive to the VPS first and pass its path to `restore.sh`.

## 11. Local smoke test

`deploy/smoke.sh` builds the whole stack on your machine as compose project `lf-smoke` on ports 18080 and 18443 with dummy secrets, checks it through Caddy (web, `/health`, a real socket.io websocket, the built API URL, a backup and its restore) and tears it down. Run it before a deploy that changes the Dockerfiles, the compose file or the Caddyfile. `deploy/deploy.test.sh` tests `deploy.sh`, `preflight.sh`, `status.sh` and `backup.sh` against stub commands.

## Not included

CI, alerting, a KMS for the keys, a second API instance (rate limits and socket rooms live in memory), high availability and a staging server.
