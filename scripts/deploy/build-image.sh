#!/usr/bin/env bash
# Builds the image for a Fly app and pushes it to the app's registry. Deploys nothing: no release is made and no
# machine is touched, so trying again is always safe. The release is a separate step, from the image this prints.
#
# A build that hangs is the reason this exists: flyctl never gives up by itself, and twice a production deploy sat in
# the build or the push until the job's timeout. Each try is cut off after BUILD_TIMEOUT seconds (default 480). The
# first try uses flyctl's default builder (Depot). When it fails or is cut off, one more try uses Fly's own builder.
#
#   build-image.sh <fly config> <app> <commit>
#
# Prints the image as `image=registry.fly.io/<app>:<label>` on the last line, and to $GITHUB_OUTPUT when set.
set -euo pipefail

config="${1:?usage: build-image.sh <fly config> <app> <commit>}"
app="${2:?usage: build-image.sh <fly config> <app> <commit>}"
commit="${3:?usage: build-image.sh <fly config> <app> <commit>}"
limit="${BUILD_TIMEOUT:-480}"
# A label per run and try: a try that was cut off halfway through its push can never be taken for a finished image.
run="${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1}"

build() {
  local label="$1"
  shift
  # TERM first; KILL 30 seconds later for a flyctl that doesn't stop.
  timeout --kill-after=30 "$limit" flyctl deploy -c "$config" -a "$app" --build-only --push \
    --image-label "$label" --build-arg "PORTICO_COMMIT=$commit" "$@"
}

done_with() {
  local image="registry.fly.io/$app:$1"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "image=$image" >>"$GITHUB_OUTPUT"; fi
  echo "image=$image"
}

first="commit-${commit:0:12}-$run-1"
second="commit-${commit:0:12}-$run-2"

code=0
build "$first" || code=$?
if [ "$code" = "0" ]; then
  done_with "$first"
  exit 0
fi
if [ "$code" = "124" ] || [ "$code" = "137" ]; then
  why="was cut off after ${limit}s without finishing"
else
  why="failed (exit $code)"
fi
echo "::warning title=Image build tried again::The first build of $app $why. Trying once more with Fly's own builder instead of Depot."

code=0
build "$second" --depot=false || code=$?
if [ "$code" = "0" ]; then
  done_with "$second"
  exit 0
fi
echo "The second build of $app also did not finish (exit $code). Nothing was deployed." >&2
exit 1
