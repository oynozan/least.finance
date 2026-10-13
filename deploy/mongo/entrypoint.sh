#!/usr/bin/env bash
# Makes the replica set key on first boot, starts the one-time setup alongside mongod, then runs the image's entrypoint.
set -euo pipefail

if [ ! -s /keys/keyfile ]; then
    openssl rand -base64 756 >/keys/keyfile
fi
chown mongodb:mongodb /keys/keyfile
chmod 400 /keys/keyfile

bash /lf-mongo/setup.sh &

exec docker-entrypoint.sh "$@"
