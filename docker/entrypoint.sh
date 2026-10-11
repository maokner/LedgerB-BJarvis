#!/bin/sh
# Runs as root only long enough to make the data volume writable, then drops to the unprivileged "node" user.
# Fly volumes are mounted owned by root, which hides the /data ownership baked into the image.
set -eu
if [ "$(id -u)" = 0 ]; then
  mkdir -p /data
  [ "$(stat -c %U /data)" = node ] || chown -R node:node /data
  exec setpriv --reuid=node --regid=node --init-groups --inh-caps=-all "$@"
fi
exec "$@"
