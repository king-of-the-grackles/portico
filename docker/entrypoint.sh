#!/bin/sh
# The image's entrypoint and its `portico` command, in one launcher. Whoever starts it (the container itself,
# `docker exec`, Render's shell or `fly ssh console`), Portico runs as the unprivileged "portico" user with the data
# folder at /data, so `portico setup` writes to the same database the server uses, and every file stays readable by it.
set -e
BIN=/usr/local/lib/portico/portico
export PORTICO_DB_PATH="${PORTICO_DB_PATH:-/data/portico.db}"

# `docker run <image> portico setup` works the same as `docker run <image> setup`.
if [ "$1" = "portico" ]; then
  shift
fi

if [ "$(id -u)" = "0" ]; then
  # Host disks (Render, Fly) usually mount /data owned by root. Hand the folder to the portico user, then drop root.
  chown -R portico:portico /data
  export HOME=/data
  exec setpriv --reuid=portico --regid=portico --init-groups "$BIN" "$@"
fi
# The platform already runs the container as a non-root user.
exec "$BIN" "$@"
