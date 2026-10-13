# Deployment: design

2026-10-14. These are the owner's choices, made on 2026-10-13. This document is the plan we build from.

## Decisions

| | |
| --- | --- |
| Hosting | One VPS running Docker Compose, in a country Polymarket allows. The pool trades from the server's IP, and proxies are never used. |
| Database | MongoDB in Docker on the same VPS: a single-node replica set (transactions need one), with authentication on and no port open to the internet. |
| Keys | A root-only env file on the server, `/etc/least-finance/server.env` with mode 600. A KMS can come later, before a public launch. |
| CI and alerts | None, by the owner's choice. Deploys run from the owner's machine. Health shows in Docker health checks and the logs. |
| Domains | `least.finance` for the web app and `api.least.finance` for the API and its websockets. Caddy gets the TLS certificates automatically. |
| Instances | One API server. Rate limits and socket rooms live in memory, so there's never a second instance. |

## Services (`deploy/docker-compose.yml`)

- **caddy** is the only service with open ports (80 and 443). It sends `least.finance` to `web:3000` and `api.least.finance` to `server:4500`, with websockets passed through. It adds HSTS. Its certificates live on a volume.
- **web** is the Next.js app built with `output: "standalone"` and run as `node server.js`. `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_PRIVY_APP_ID` and `NEXT_PUBLIC_PRIVY_CLIENT_ID` are build arguments, because Next bakes them into the client bundle.
- **server** is the Node 26 image running `node src/index.ts`. The env file comes from `/etc/least-finance/server.env`. The compose file fixes `NODE_ENV=production`, `TRUST_PROXY=1` and `HOST=0.0.0.0`. Its health check is `/health`.
- **mongo** is `mongo:7.0` with `--replSet rs0 --keyFile`, a root user and an app user. The replica set starts itself on first boot. Its data lives on a named volume, and it's reachable only on the compose network.
- **backup** runs `mongodump --archive --gzip` every night to `/var/backups/least-finance` on the host, keeping 14 days. The files are mode 600.

Every service restarts `unless-stopped`, and Docker's json-file logs rotate (10 MB, 5 files).

## The server refuses unsafe production settings

When `NODE_ENV=production`, `loadConfig` refuses to start (naming each problem, the way it already names bad variables) when:
- `CORS_ORIGINS` contains `localhost` or `127.0.0.1`, or anything that isn't `https://`;
- `TRUST_PROXY` is 0;
- `MONGODB_URI` has no credentials.

It also logs a warning, but still starts, for every chain whose RPC list is still only the built-in public defaults.

## Running it (`deploy/`)

**Scripts:**
- `deploy/deploy.sh <ssh-host>` rsyncs the repo to `/opt/least-finance`. It leaves out `node_modules`, `.next`, `.env*`, test output and `.superpowers`. It then runs `docker compose up -d --build` and waits until `https://api.least.finance/ready` answers 200. If that never happens it prints the logs of the failing service, and the previous containers are still running.
- `deploy/restore.sh <archive>` restores a dump into the running Mongo, after a confirmation prompt.
- `deploy/preflight.sh` runs on the VPS. It checks Docker, the env file's mode and owner, DNS for both names, and Polymarket's geoblock answer for the server's IP.
- `deploy/smoke.sh` runs locally. It builds the images and runs the whole stack under the compose project `lf-smoke`, on ports 18080 and 18443 with Caddy's internal TLS and dummy secrets (trading off). It checks that the web app answers 200, `/health` answers 200, the websocket upgrades, and a backup is written and restores into an empty Mongo. Then it tears everything down.

**Runbook** (`deploy/README.md`):
- Provisioning a VPS: Ubuntu 24.04 LTS, SSH keys only, `ufw` allowing 22, 80 and 443, unattended upgrades, and Docker.
- Choosing an allowed region, and confirming it with `preflight.sh`.
- DNS and creating the env file from `server/.env.example`.
- The first deploy, updates, rollback (redeploy the previous commit), and copying a backup off the server (`scp`).
- A restore drill.

## Not included

CI, alerting, KMS, a second instance or high availability, and a staging server.
