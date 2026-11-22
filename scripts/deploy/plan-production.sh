#!/usr/bin/env bash
# Decides whether deploying <commit> to production may change the database, by comparing it with the commit that is
# live now (GET <live url>/healthz, read-only). Needs the full git history (fetch-depth: 0).
#
#   plan-production.sh <commit> [live url, default https://app.portico.chat]
#
# migration=true when the live commit is unknown or missing, is not an ancestor of <commit>, or when the changes
# between the two touch one of MIGRATION_PATHS. Otherwise migration=false.
# Writes migration, live_commit and reason to $GITHUB_OUTPUT and a line to $GITHUB_STEP_SUMMARY when those are set.
# PLAN_LIVE_COMMIT, when set, stands in for the answer of /healthz (for trying the script by hand).
set -euo pipefail

target="${1:?usage: plan-production.sh <commit> [live url]}"
live_url="${2:-https://app.portico.chat}"
MIGRATION_PATHS=(server/src/migrations.ts server/src/db.ts)

if [ -n "${PLAN_LIVE_COMMIT+x}" ]; then
  live="$PLAN_LIVE_COMMIT"
else
  body="$(curl -fsS --max-time 10 --retry 3 --retry-delay 5 "${live_url%/}/healthz" 2>/dev/null || true)"
  live="$(jq -r '.commit // empty' <<<"$body" 2>/dev/null || true)"
fi

migration=true
if [ -z "$live" ] || [ "$live" = "unknown" ]; then
  live="${live:-missing}"
  reason="the live app does not say which commit it runs ($live)"
elif ! [[ "$live" =~ ^[0-9a-f]{7,40}$ ]]; then
  # Whatever /healthz answered goes no further than this message: it is never handed to git.
  live="unreadable"
  reason="the live app's commit is not a git commit ID"
elif ! git cat-file -e "$live^{commit}" 2>/dev/null; then
  reason="the live commit $live is not in this repository's history"
elif ! git merge-base --is-ancestor "$live" "$target"; then
  reason="the live commit $live is not an ancestor of $target"
else
  touched="$(git diff --name-only "$live" "$target" -- "${MIGRATION_PATHS[@]}")"
  if [ -n "$touched" ]; then
    reason="the changes since the live commit $live touch $(paste -sd' ' <<<"$touched")"
  else
    migration=false
    reason="the live commit $live is an ancestor of $target and nothing between them touches ${MIGRATION_PATHS[*]}"
  fi
fi

echo "migration=$migration: $reason"
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "migration=$migration"
    echo "live_commit=$live"
    echo "reason=$reason"
  } >>"$GITHUB_OUTPUT"
fi
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### Production plan"
    echo "- Commit to deploy: \`$target\`"
    echo "- Commit live now: \`$live\`"
    echo "- **migration=$migration**: $reason"
  } >>"$GITHUB_STEP_SUMMARY"
fi
