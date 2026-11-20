#!/usr/bin/env bash
# Runs the suite against a deployed Portico. Credentials come from the environment; when they are unset, the Descope
# ones are read from ~/.descope/projects.json (entry portico-dev). The management key is never printed.
#
#   ./run.sh                    the whole suite
#   ./run.sh tests/05-*         one scenario (any Playwright arguments pass through)
#   E2E_KEEP=1 ./run.sh         keep the test people and agents, and use them again next time
#   ./run.sh --cleanup          delete what kept or crashed runs left behind
set -euo pipefail
cd "$(dirname "$0")"

export E2E_BASE_URL="${E2E_BASE_URL:-https://dev.portico.chat}"
host="$(printf '%s' "$E2E_BASE_URL" | sed -E 's#^[a-zA-Z]+://##; s#[/:?].*$##' | tr '[:upper:]' '[:lower:]')"
if [ "$host" = "portico.chat" ] || [ "$host" = "www.portico.chat" ]; then
  echo "E2E_BASE_URL points at production ($host). This suite never runs there." >&2
  exit 2
fi

if [ -z "${DESCOPE_PROJECT_ID:-}" ] || [ -z "${DESCOPE_MANAGEMENT_KEY:-}" ]; then
  projects="$HOME/.descope/projects.json"
  entry="${E2E_DESCOPE_ENTRY:-portico-dev}"
  if [ ! -r "$projects" ] || ! command -v jq >/dev/null; then
    echo "Set DESCOPE_PROJECT_ID and DESCOPE_MANAGEMENT_KEY (or have jq and $projects with a $entry entry)." >&2
    exit 2
  fi
  DESCOPE_PROJECT_ID="$(jq -r --arg e "$entry" '.projects[$e].id // empty' "$projects")"
  DESCOPE_MANAGEMENT_KEY="$(jq -r --arg e "$entry" '.projects[$e].management_key // empty' "$projects")"
  if [ -z "$DESCOPE_PROJECT_ID" ] || [ -z "$DESCOPE_MANAGEMENT_KEY" ]; then
    echo "No $entry entry with id and management_key in $projects." >&2
    exit 2
  fi
  export DESCOPE_PROJECT_ID DESCOPE_MANAGEMENT_KEY
fi

if [ "${1:-}" = "--cleanup" ]; then
  exec bun lib/teardown.ts
fi
exec bunx playwright test "$@"
