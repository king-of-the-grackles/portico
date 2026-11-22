#!/usr/bin/env bash
# Runs the suite against a deployed Portico (./local.sh runs it against this checkout instead). Credentials come from
# the environment; when they are unset, the Descope ones are read from ~/.descope/projects.json (entry portico-dev).
# The management key is never printed.
#
#   ./run.sh                    the whole suite
#   ./run.sh tests/05-*         one scenario (any Playwright arguments pass through)
#   E2E_KEEP=1 ./run.sh         keep the test people and agents, and use them again next time
#   ./run.sh --cleanup          delete what kept or crashed runs left behind
set -euo pipefail
cd "$(dirname "$0")"

export E2E_BASE_URL="${E2E_BASE_URL:-https://dev.portico.chat}"
host="$(printf '%s' "$E2E_BASE_URL" | sed -E 's#^[a-zA-Z]+://##; s#[/:?].*$##' | tr '[:upper:]' '[:lower:]')"
if [ "$host" = "portico.chat" ] || [ "$host" = "www.portico.chat" ] || [ "$host" = "app.portico.chat" ]; then
  echo "E2E_BASE_URL points at production ($host). This suite never runs there." >&2
  exit 2
fi

. lib/descope-env.sh

if [ "${1:-}" = "--cleanup" ]; then
  exec bun lib/teardown.ts
fi
exec bunx playwright test "$@"
