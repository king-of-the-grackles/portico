#!/bin/sh
# Host disks (Render, Fly) usually mount /data owned by root. Take ownership, then run the hub as the
# unprivileged "portico" user. When the platform already runs the container as non-root, run the hub directly.
set -e
if [ "$(id -u)" = "0" ]; then
  chown -R portico:portico /data
  # Secret files on some hosts (Render) are readable by root only. Hand the hub a private copy it can read.
  CONFIG_PATH="${PORTICO_CONFIG:-./portico.yaml}"
  if [ -f "$CONFIG_PATH" ] && ! setpriv --reuid=portico --regid=portico --init-groups test -r "$CONFIG_PATH"; then
    install -o portico -g portico -m 600 "$CONFIG_PATH" /tmp/portico.yaml
    export PORTICO_CONFIG=/tmp/portico.yaml
  fi
  exec setpriv --reuid=portico --regid=portico --init-groups /usr/local/bin/portico "$@"
fi
exec /usr/local/bin/portico "$@"
