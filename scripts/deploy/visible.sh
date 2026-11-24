#!/usr/bin/env bash
# Decides whether deploying <commit> to production puts a visible change in front of users: one whose pull request
# carried the label 'visible'. Such a deploy waits, after dev, for a person who has watched the recording made on dev
# (e2e/smoke.sh). Needs the full git history (fetch-depth: 0) and read access to the repository's pull requests.
#
#   visible.sh <commit> <live commit, as plan-production.sh reported it>
#
# visible=true when a merged pull request behind one of the commits going out (live..commit) has the label, and also
# whenever that can't be worked out: the live commit is unknown or not an ancestor, GitHub does not answer, or more
# than MAX_COMMITS go out at once. Then it is better to wait for a person than to guess.
# When visible=true, the environment the wait happens in must exist with a required reviewer, or the script fails:
# GitHub makes a missing environment on the spot, without one, and the deploy would walk straight through.
#
# Writes visible, visible_reason, visible_prs and smoke_flows to $GITHUB_OUTPUT and a section to $GITHUB_STEP_SUMMARY
# when those are set. smoke_flows are the flow names the pull requests ask for on a line "Smoke flows: join, share",
# kept only when e2e/smoke/flows/<name>.flow.ts exists. Nothing a pull request says is ever run or handed to a shell.
#
# Reads: GITHUB_REPOSITORY, GH_TOKEN, GITHUB_API_URL. VISIBLE_API_DIR, when set, stands in for GitHub: the answer to
# GET /repos/<repo>/<path> is read from <dir>/<path with / as _>.json (for the tests and for trying it by hand).
set -euo pipefail

target="${1:?usage: visible.sh <commit> <live commit>}"
live="${2:-}"
LABEL=visible
ENVIRONMENT=visible-change
MAX_COMMITS=30
root="$(cd "$(dirname "$0")/../.." && pwd)"

api() {
  if [ -n "${VISIBLE_API_DIR:-}" ]; then
    cat "$VISIBLE_API_DIR/${1//\//_}.json" 2>/dev/null
  else
    curl -fsS --max-time 20 --retry 2 --retry-delay 3 \
      -H "Accept: application/vnd.github+json" -H "X-GitHub-Api-Version: 2022-11-28" \
      ${GH_TOKEN:+-H "Authorization: Bearer $GH_TOKEN"} \
      "${GITHUB_API_URL:-https://api.github.com}/repos/${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is not set}/$1"
  fi
}

visible=false
reason=""
prs=""
flows=""
unknown_flows=""

if ! [[ "$live" =~ ^[0-9a-f]{7,40}$ ]] || ! git cat-file -e "$live^{commit}" 2>/dev/null || ! git merge-base --is-ancestor "$live" "$target"; then
  visible=true
  reason="the commit live now is unknown or not an ancestor of $target, so which changes go out can't be listed"
else
  mapfile -t commits < <(git rev-list "$live..$target")
  if [ ${#commits[@]} -eq 0 ]; then
    reason="nothing new goes out: $target is the commit live now"
  elif [ ${#commits[@]} -gt "$MAX_COMMITS" ]; then
    visible=true
    reason="${#commits[@]} commits go out at once, more than the $MAX_COMMITS this check reads"
  else
    for sha in "${commits[@]}"; do
      if ! pulls="$(api "commits/$sha/pulls")" || ! jq -e 'type == "array"' <<<"$pulls" >/dev/null 2>&1; then
        visible=true
        reason="GitHub did not say which pull request commit ${sha:0:7} came from"
        break
      fi
      # Merged pull requests with the label. Numbers are numbers; flow names are checked below before they are used.
      labelled="$(jq -c --arg label "$LABEL" '[.[] | select(.merged_at != null) | select(any(.labels[]?; .name == $label))]' <<<"$pulls")"
      [ "$(jq 'length' <<<"$labelled")" -gt 0 ] || continue
      visible=true
      prs="$prs $(jq -r '[.[].number | select(type == "number") | "#\(.)"] | join(" ")' <<<"$labelled")"
      asked="$(jq -r '[.[].body // "" | split("\n")[] | (capture("^[\\s>*-]*smoke flows?\\s*:\\s*(?<names>.*)$"; "i") // empty) | .names | ascii_downcase | [scan("[a-z0-9]+(?:-[a-z0-9]+)*")] | .[]] | unique | .[]' <<<"$labelled")"
      for name in $asked; do
        [[ "$name" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]] || continue
        if [ -f "$root/e2e/smoke/flows/$name.flow.ts" ]; then
          case " $flows " in *" $name "*) ;; *) flows="$flows $name" ;; esac
        else
          case " $unknown_flows " in *" $name "*) ;; *) unknown_flows="$unknown_flows $name" ;; esac
        fi
      done
    done
    prs="$(xargs <<<"$prs")"
    flows="$(xargs <<<"$flows")"
    unknown_flows="$(xargs <<<"$unknown_flows")"
    if [ -z "$reason" ]; then
      if [ "$visible" = "true" ]; then
        reason="pull request $prs carries the label '$LABEL'"
      else
        reason="none of the ${#commits[@]} commits going out came from a pull request with the label '$LABEL'"
      fi
    fi
  fi
fi

echo "visible=$visible: $reason"

if [ "$visible" = "true" ]; then
  if ! env_json="$(api "environments/$ENVIRONMENT")" \
    || ! jq -e 'any(.protection_rules[]?; .type == "required_reviewers" and ((.reviewers // []) | length > 0))' <<<"$env_json" >/dev/null 2>&1; then
    echo "The environment '$ENVIRONMENT' is missing, unreadable or has no required reviewer, so nothing would wait for a person: not deploying. Create it in the repository's settings (see 'Deploys' in the README)." >&2
    exit 1
  fi
fi

record="e2e/smoke.sh --commit ${target:0:12} ${flows:-<flow>}"
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "visible=$visible"
    echo "visible_reason=$reason"
    echo "visible_prs=$prs"
    echo "smoke_flows=$flows"
  } >>"$GITHUB_OUTPUT"
fi
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### Visible change"
    echo "- **visible=$visible**: $reason"
    if [ "$visible" = "true" ]; then
      echo "- Production waits in the environment \`$ENVIRONMENT\` until its reviewer has watched the recording made on dev."
      echo "- Flows the pull requests ask for: ${flows:-none named}"
      if [ -n "$unknown_flows" ]; then echo "- Named but not in \`e2e/smoke/flows/\`: $unknown_flows"; fi
      echo "- To record, on a computer with the repository: \`$record\`"
    fi
  } >>"$GITHUB_STEP_SUMMARY"
fi
