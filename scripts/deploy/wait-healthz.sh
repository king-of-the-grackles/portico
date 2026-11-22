#!/usr/bin/env bash
# Polls <base url>/healthz until it answers {"ok":true} and, when a commit is given, "commit" equal to it.
# Read-only: one GET per try. Exits 1 when the timeout passes first.
#
#   wait-healthz.sh https://dev.portico.chat <commit> [timeout seconds, default 300]
#   wait-healthz.sh https://app.portico.chat ""       any commit, only ok:true
set -euo pipefail

base="${1:?usage: wait-healthz.sh <base url> <commit or ''> [timeout seconds]}"
want="${2:-}"
timeout="${3:-300}"
url="${base%/}/healthz"
deadline=$((SECONDS + timeout))
last="(no answer)"

while :; do
  if body="$(curl -fsS --max-time 10 "$url" 2>/dev/null)"; then
    last="$body"
    ok="$(jq -r '.ok // false' <<<"$body" 2>/dev/null || echo false)"
    commit="$(jq -r '.commit // "missing"' <<<"$body" 2>/dev/null || echo missing)"
    if [ "$ok" = "true" ] && { [ -z "$want" ] || [ "$commit" = "$want" ]; }; then
      echo "$url answers ok:true, commit $commit."
      exit 0
    fi
  fi
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "$url did not answer ok:true${want:+ with commit $want} within ${timeout}s. Last answer: $last" >&2
    exit 1
  fi
  sleep 5
done
