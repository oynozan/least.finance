#!/usr/bin/env bash
# Starts the single-node replica set and creates the root and app users, safe to run on every boot.
set -uo pipefail

ROOT_USER=root
APP_USER=app
DB="${MONGODB_DB:?}"

root_shell() {
    mongosh --quiet -u "$ROOT_USER" -p "$MONGO_ROOT_PASSWORD" --authenticationDatabase admin "$@"
}

until mongosh --quiet --eval 'db.hello().ok' >/dev/null 2>&1; do sleep 1; done

if ! root_shell --eval 'db.hello().ok' >/dev/null 2>&1; then
    # No root user yet: the localhost exception allows starting the set and creating the first user.
    until mongosh --quiet --eval "
        try { rs.initiate({ _id: 'rs0', members: [{ _id: 0, host: 'mongo:27017' }] }) } catch (e) { if (e.codeName !== 'AlreadyInitialized') throw e }
        const deadline = Date.now() + 30000;
        while (!db.hello().isWritablePrimary) { if (Date.now() > deadline) quit(1); sleep(500) }
        db.getSiblingDB('admin').createUser({ user: '$ROOT_USER', pwd: process.env.MONGO_ROOT_PASSWORD, roles: ['root'] })
    " >/dev/null 2>&1; do sleep 2; done
fi

until root_shell --eval 'quit(db.hello().isWritablePrimary ? 0 : 1)' >/dev/null 2>&1; do sleep 1; done

root_shell --eval "
    const target = db.getSiblingDB('$DB');
    const pwd = process.env.MONGO_APP_PASSWORD;
    if (target.getUser('$APP_USER')) target.updateUser('$APP_USER', { pwd });
    else target.createUser({ user: '$APP_USER', pwd, roles: [{ role: 'readWrite', db: '$DB' }] });
" >/dev/null
echo "mongo setup done"
