# Sourced by run.sh and local.sh: exports DESCOPE_PROJECT_ID and DESCOPE_MANAGEMENT_KEY. When they are unset, they are
# read from ~/.descope/projects.json (entry portico-dev, or the one E2E_DESCOPE_ENTRY names). Never printed.
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
fi
export DESCOPE_PROJECT_ID DESCOPE_MANAGEMENT_KEY
