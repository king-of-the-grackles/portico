#!/bin/sh
# Host disks (Render, Fly) usually mount /data owned by root. Take ownership, then run the hub as the
# unprivileged "bridge" user. When the platform already runs the container as non-root, run the hub directly.
set -e
if [ "$(id -u)" = "0" ]; then
  chown -R bridge:bridge /data
  # Secret files on some hosts (Render) are readable by root only. Hand the hub a private copy it can read.
  CONFIG_PATH="${BRIDGE_CONFIG:-./bridge.yaml}"
  if [ -f "$CONFIG_PATH" ] && ! setpriv --reuid=bridge --regid=bridge --init-groups test -r "$CONFIG_PATH"; then
    install -o bridge -g bridge -m 600 "$CONFIG_PATH" /tmp/bridge.yaml
    export BRIDGE_CONFIG=/tmp/bridge.yaml
  fi
  exec setpriv --reuid=bridge --regid=bridge --init-groups /usr/local/bin/bridge "$@"
fi
exec /usr/local/bin/bridge "$@"
