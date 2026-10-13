# Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Least Finance deployable to one VPS with Docker Compose, with production settings checked at startup, nightly database backups, a tested restore, and a runbook.

**Architecture:**
- Caddy is the only service with open ports. Behind it run the Next.js standalone web image, the Node API image, and an authenticated single-node Mongo replica set, plus a backup service.
- `deploy/smoke.sh` runs the same stack locally on spare ports, so every task is verified without a VPS.

**Tech Stack:** Docker 29 and Compose v5, Caddy 2, `mongo:7.0`, Node 26, Next.js 16 (`output: "standalone"`), bash.

**Spec:** `docs/superpowers/specs/2026-10-14-deployment-design.md`

## Global Constraints

- **Never touch the owner's running dev setup:** ports 3000 (Next dev), 4500 (the API) and 27018 (the dev Mongo in `server/docker-compose.yml`), or the `mongo-data` volume.
- **Local stacks use only the compose project `lf-smoke`, on ports 18080 and 18443.** Always tear them down (`docker compose -p lf-smoke down -v`), including when a test fails.
- **Dummy secrets only.** Never read or print any `.env` file, and never put a real key in the repo.
- **The scripts:**
  - start with `set -euo pipefail` and pass `shellcheck` if it's installed;
  - never print a secret;
  - never run `docker system prune` or anything that touches containers or volumes outside `lf-smoke`.
- **Server checks:** `cd server && npx vitest run <file>`, then `npm test` and `npx tsc --noEmit`.
- **App checks:** `npx tsc --noEmit -p .` and `npm run build` must still pass. Don't run the e2e suite in the repo tree.
- **Comments** are one line each and describe the code as it is.
- **Commits:** no Co-Authored-By trailer. Commit by path, with only your own hunks.
- **Shared files:** a parallel plan (predictions money safety) edits `server/src/predictions/*`, `server/src/db/mongo.ts` and `server/src/server.ts`. This plan doesn't touch them.

## Review Focus

1. **A secret printed into deploy output or logs.** The scripts never echo env contents.
2. **A restore that silently drops data.** The restore drill compares document counts per collection.
3. **Websockets through Caddy.** The smoke test must show a real socket.io connection succeeding, not just HTTP 200.
4. **A Next public variable left at its development default** in the production image. The smoke test checks the built bundle has the API URL it was given.
5. **The server starting in production with `TRUST_PROXY=0`.** It must refuse.

---

### Task 1: Refuse unsafe production settings

**Files:** Modify `server/src/config.ts`. Test `server/test/unit/config.test.ts`.

**Interfaces:**
- `loadConfig` adds the spec's production refusals: localhost or non-https CORS origins, `TRUST_PROXY=0`, and a `MONGODB_URI` without credentials.
- It adds `publicRpcWarnings(config): string[]`, which names each chain still on only the built-in public RPCs. `index.ts` logs them at startup as warnings.

- [ ] **Tests**
  - With `NODE_ENV=production`, each unsafe setting is refused, and the error names all of them at once.
  - With `NODE_ENV` development or test, nothing changes.
  - `publicRpcWarnings` names exactly the defaulted chains.
  - Watch them fail, implement, and run the server suite and tsc.
- [ ] **Commit:** "Refuse to start in production with localhost CORS, no trusted proxy or an unauthenticated database"

### Task 2: Container images

**Files:**
- Create `deploy/server.Dockerfile`, `deploy/web.Dockerfile` and `.dockerignore`.
- Modify `next.config.ts` (`output: "standalone"`).

**Interfaces:**
- The images are `least-finance-server` and `least-finance-web`.
- The web image takes the build args `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_PRIVY_APP_ID` and `NEXT_PUBLIC_PRIVY_CLIENT_ID`.
- Both run as a non-root user.

- [ ] Build both images locally (`docker build -f deploy/<x>.Dockerfile .`) and watch them succeed.
- [ ] Run the web image on port 18080 and check `/` answers 200.
- [ ] Grep the built client bundle for the API URL passed at build time.
- [ ] Check `npm run build` and the app's tsc still pass.
- [ ] **Commit:** "Build the web app and the API as production Docker images"

### Task 3: The production compose stack and smoke test

**Files:** Create `deploy/docker-compose.yml`, `deploy/Caddyfile`, `deploy/mongo/` (keyfile generation and user setup), `deploy/compose.smoke.yml` (the override), `deploy/smoke.sh` and `deploy/smoke.env` (dummy values only).

**Interfaces:** the spec's services: caddy, web, server and mongo (backup comes in Task 4). Mongo starts its replica set itself and creates its users from env. The smoke override uses `tls internal`, ports 18080 and 18443, and project `lf-smoke`.

- [ ] Write `smoke.sh` first. It brings the stack up, then checks:
  - web 200 through Caddy;
  - `/health` 200 through Caddy;
  - a socket.io handshake and connection through Caddy (`node -e` with `socket.io-client`, accepting the internal certificate);
  - that the server refuses to start when `TRUST_PROXY=0` is injected.

  It tears down on exit through a `trap`.
- [ ] Run it, watch it fail, build the stack, and run it until it passes.
- [ ] **Commit:** "Run Least Finance as one Docker Compose stack behind Caddy, smoke-tested locally"

### Task 4: Backups and restore

**Files:** Add the `backup` service to `deploy/docker-compose.yml`. Create `deploy/backup.sh` (the service's entry point) and `deploy/restore.sh`. Extend `deploy/smoke.sh`.

**Interfaces:**
- A nightly `mongodump --archive --gzip` to a host directory, with 14-day retention and mode 600.
- `backup.sh --now` runs one backup at once.
- `restore.sh <archive>` asks for confirmation; `--yes` skips it, for the smoke test.

- [ ] Extend `smoke.sh`:
  1. Seed documents through the API, or straight into Mongo.
  2. Run `backup.sh --now`.
  3. Wipe and restore into a fresh database.
  4. Compare the per-collection counts.

  Watch it fail, implement, and run it until it passes.
- [ ] **Commit:** "Back up MongoDB nightly with 14 days kept, and prove a restore in the smoke test"

### Task 5: Deploy script, preflight and runbook

**Files:**
- Create `deploy/deploy.sh`, `deploy/preflight.sh` and `deploy/README.md`.
- Modify `README.md` (link the runbook, and fix the stale "positions are mock data" line) and `server/README.md` (fix the stale "This first part covers accounts and deposits" line, and point to the runbook).

**Interfaces:**
- `deploy.sh <ssh-host>` and `preflight.sh`, as the spec describes.
- `preflight.sh`'s Polymarket check calls Polymarket's public geoblock endpoint. Find the current one in Polymarket's docs and cite it in the runbook.

- [ ] Test `deploy.sh` against a local sshd-in-Docker target if that's practical. If not, run it with `--dry-run`, which prints the rsync and compose commands, and show its output.
- [ ] Run `shellcheck` on every script if it's installed.
- [ ] Have someone who hasn't seen the stack read the runbook end to end: every command must be copy-pasteable.
- [ ] **Commit:** "Add the deploy script, the VPS preflight check and the deployment runbook"
