#!/usr/bin/env bash
# Records a visible flow on dev as a short phone-sized video, for a person to watch before production: smoke.mp4
# (H.264, a caption under each step), numbered screenshots and steps.md. See "Recording a visible change" in README.md.
#
#   ./smoke.sh --commit <commit> join            one flow: smoke/flows/join.flow.ts
#   ./smoke.sh --commit <commit> join share      several, each into its own folder
#   ./smoke.sh --list                            the flows there are
#
# --commit is the commit the recording is about, 7 to 40 characters of its ID. The run refuses to start unless dev's
# /healthz reports that commit, so a recording never shows an older or newer build than the one being approved.
# --out <folder> is where the recordings go: default ~/portico-smoke. Never inside the repository. Each flow writes to
# <folder>/<commit, 7 characters>/<flow>/, replacing what an earlier run of the same flow and commit left there.
#
# Runs on a person's or an agent's own computer (it needs ffmpeg and a font), against https://dev.portico.chat. It
# signs in as the browser suite does, with a test person made in the dev-only Descope project, and cleans up the same
# way: the test person's Descope user and their agents are removed, and nothing else on dev is touched.
set -euo pipefail
cd "$(dirname "$0")"
repo="$(cd .. && pwd -P)"

commit=""
out="${SMOKE_OUT:-$HOME/portico-smoke}"
flows=()
while [ $# -gt 0 ]; do
  case "$1" in
    --commit) commit="${2:?--commit needs a commit ID}"; shift 2 ;;
    --out) out="${2:?--out needs a folder}"; shift 2 ;;
    --list) ls smoke/flows | sed -n 's/\.flow\.ts$//p'; exit 0 ;;
    -*) echo "smoke: unknown option $1" >&2; exit 2 ;;
    *) flows+=("$1"); shift ;;
  esac
done

if ! [[ "$commit" =~ ^[0-9a-f]{7,40}$ ]]; then
  echo "smoke: say which commit the recording is about: --commit <7 to 40 characters of the commit ID>." >&2
  exit 2
fi
if [ ${#flows[@]} -eq 0 ]; then
  echo "smoke: name at least one flow. There are: $(ls smoke/flows | sed -n 's/\.flow\.ts$//p' | paste -sd' ')" >&2
  exit 2
fi
for flow in "${flows[@]}"; do
  if ! [[ "$flow" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]] || [ ! -f "smoke/flows/$flow.flow.ts" ]; then
    echo "smoke: there is no flow called '$flow'. There are: $(ls smoke/flows | sed -n 's/\.flow\.ts$//p' | paste -sd' ')" >&2
    exit 2
  fi
done
for tool in ffmpeg fc-match jq curl; do
  command -v "$tool" >/dev/null || { echo "smoke: $tool is needed and is not installed." >&2; exit 2; }
done

mkdir -p "$out"
out="$(cd "$out" && pwd -P)"
case "$out/" in
  "$repo"/*) echo "smoke: recordings never go inside the repository ($out). Pick another --out." >&2; exit 2 ;;
esac

# Dev, unless E2E_BASE_URL names another Portico (a local one, to try a new flow). Never production.
export E2E_BASE_URL="${E2E_BASE_URL:-https://dev.portico.chat}"
host="$(printf '%s' "$E2E_BASE_URL" | sed -E 's#^[a-zA-Z]+://##; s#[/:?].*$##' | tr '[:upper:]' '[:lower:]')"
if [ "$host" = "portico.chat" ] || [ "$host" = "www.portico.chat" ] || [ "$host" = "app.portico.chat" ]; then
  echo "smoke: E2E_BASE_URL points at production ($host). Flows make a test person and an agent: they never run there." >&2
  exit 2
fi

# Read-only: one GET. The recording is of this commit or of nothing.
body="$(curl -fsS --max-time 15 --retry 2 --retry-delay 3 "${E2E_BASE_URL%/}/healthz" 2>/dev/null || true)"
running="$(jq -r '.commit // empty' <<<"$body" 2>/dev/null || true)"
if ! [[ "$running" =~ ^[0-9a-f]{7,40}$ ]]; then
  echo "smoke: $E2E_BASE_URL/healthz does not say which commit it runs: not recording." >&2
  exit 1
fi
if [ "${running:0:${#commit}}" != "$commit" ]; then
  echo "smoke: $E2E_BASE_URL runs commit ${running:0:12}, not $commit: not recording. Wait until the Deploy run has put $commit there." >&2
  exit 1
fi
export SMOKE_COMMIT="$running"

. lib/descope-env.sh
[ -d node_modules ] || bun install --frozen-lockfile >&2

# A run of its own, as in local.sh: the cleanup deletes what this run made and leaves a kept suite run alone.
unset E2E_KEEP
export E2E_RUN_ID="$(bun -e 'const a = "abcdefghjkmnpqrstuvwxyz23456789"; console.log(Array.from(crypto.getRandomValues(new Uint8Array(5)), (b) => a[b % a.length]).join(""))')"

finish() {
  status=$?
  trap - EXIT INT TERM
  # Playwright's teardown already did this for a flow that ended; this covers a run that was interrupted.
  if [ -f ".state/$E2E_RUN_ID.json" ]; then
    bun lib/teardown.ts "$E2E_RUN_ID" || echo "smoke: cleanup failed. Run ./run.sh --cleanup to remove this run's test person and agents." >&2
  fi
  exit "$status"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

echo "smoke: recording ${flows[*]} on $E2E_BASE_URL at commit ${running:0:7} (run $E2E_RUN_ID)" >&2
for flow in "${flows[@]}"; do
  export SMOKE_OUT_DIR="$out/${running:0:7}/$flow"
  # Only what a flow writes is replaced: the video, its screenshots and steps.md.
  if [ -d "$SMOKE_OUT_DIR" ]; then
    find "$SMOKE_OUT_DIR" -maxdepth 1 -type f \( -name 'smoke.mp4' -o -name 'steps.md' -o -name 'steps.json' -o -name '[0-9][0-9]-*.png' \) -delete
  fi
  bunx playwright test --config smoke/playwright.config.ts "flows/$flow.flow.ts"
  bun smoke/render.ts "$SMOKE_OUT_DIR"
done
