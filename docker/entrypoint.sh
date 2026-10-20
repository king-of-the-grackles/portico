#!/bin/sh
# Host disks (Render, Fly) usually mount /data owned by root. Take ownership, then run the hub as the
# unprivileged "bridge" user. When the platform already runs the container as non-root, run the hub directly.
set -e
if [ "$(id -u)" = "0" ]; then
  chown -R bridge:bridge /data
  exec setpriv --reuid=bridge --regid=bridge --init-groups /usr/local/bin/bridge "$@"
fi
exec /usr/local/bin/bridge "$@"
