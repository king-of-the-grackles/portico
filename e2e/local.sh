#!/usr/bin/env bash
# Runs the suite against a Portico started from this checkout, on this computer: how a branch is tested before it is
# merged. Nothing is deployed and no deployment is touched; the only thing outside this computer is the dev-only
# Descope project, where the run makes its test users and deletes them again.
#
#   ./local.sh                  the whole suite
#   ./local.sh tests/05-*       one scenario (any Playwright arguments pass through)
#
# Each run: a free port, a new empty data folder in the temp directory, a secrets key made for the run, no email and
# no bucket (files live in the data folder). The server is stopped and the folder removed when the run ends, also
# when it fails or is interrupted. A failed run leaves the server's log in test-results/server.log.
set -euo pipefail
cd "$(dirname "$0")"
repo="$(cd .. && pwd)"

. lib/descope-env.sh

for dir in "$repo" "$repo/e2e"; do
  [ -d "$dir/node_modules" ] || (cd "$dir" && bun install --frozen-lockfile >&2)
done

if command -v free-port >/dev/null; then
  port="$(free-port)"
else
  port="$(bun -e 'const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } }); console.log(s.port); s.stop();')"
fi
tmp="$(mktemp -d "${TMPDIR:-/tmp}/portico-local.XXXXXX")"
server_pid=""

# A run of its own, so the cleanup below deletes this run's test users and leaves a kept run against dev alone.
unset E2E_KEEP
export E2E_BASE_URL="http://localhost:$port"
export E2E_RUN_ID="$(bun -e 'const a = "abcdefghjkmnpqrstuvwxyz23456789"; console.log(Array.from(crypto.getRandomValues(new Uint8Array(5)), (b) => a[b % a.length]).join(""))')"

finish() {
  status=$?
  trap - EXIT INT TERM
  # Playwright's teardown deletes the run's Descope users; this covers a run that was interrupted before it got there.
  if [ -f ".state/$E2E_RUN_ID.json" ]; then
    bun lib/teardown.ts "$E2E_RUN_ID" || echo "Cleanup failed: run ./run.sh --cleanup to delete this run's Descope test users." >&2
  fi
  if [ -n "$server_pid" ]; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  if [ "$status" -ne 0 ] && [ -f "$tmp/server.log" ]; then
    mkdir -p test-results && cp "$tmp/server.log" test-results/server.log
    echo "The local server's log: e2e/test-results/server.log" >&2
  fi
  rm -rf "$tmp"
  exit "$status"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# A clean environment: nothing of this shell's PORTICO_*, AWS_* or platform settings reaches the server, so it can't
# send email, use a bucket, or take itself for a deployment.
env -i PATH="$PATH" HOME="$HOME" \
  PORT="$port" \
  PORTICO_DATA_DIR="$tmp/data" \
  PORTICO_PUBLIC_URL="$E2E_BASE_URL" \
  PORTICO_SECRETS_KEY="$(bun "$repo/server/src/cli.ts" key)" \
  PORTICO_DESCOPE_PROJECT_ID="$DESCOPE_PROJECT_ID" \
  PORTICO_COMMIT="$(git -C "$repo" rev-parse --short HEAD 2>/dev/null || echo local)" \
  bun "$repo/server/src/cli.ts" serve >"$tmp/server.log" 2>&1 &
server_pid=$!

for _ in $(seq 1 150); do
  if curl -fsS -o /dev/null "$E2E_BASE_URL/healthz" 2>/dev/null; then break; fi
  if ! kill -0 "$server_pid" 2>/dev/null; then
    echo "The local server stopped while starting:" >&2
    tail -n 40 "$tmp/server.log" >&2
    exit 1
  fi
  sleep 0.2
done
curl -fsS -o /dev/null "$E2E_BASE_URL/healthz" || { echo "The local server didn't answer on $E2E_BASE_URL/healthz within 30 seconds:" >&2; tail -n 40 "$tmp/server.log" >&2; exit 1; }
echo "e2e: local Portico from $(git -C "$repo" rev-parse --abbrev-ref HEAD 2>/dev/null || echo this checkout) on $E2E_BASE_URL (run $E2E_RUN_ID)" >&2

bunx playwright test "$@"
