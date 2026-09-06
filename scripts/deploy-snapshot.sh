#!/usr/bin/env bash
# Writes the latest run of a GitHub Actions workflow to a JSON snapshot that
# the Multica server relays at GET /api/deploy (see handler.GetDeploy).
#
# Runs from cron on the host, outside the app, in the same spirit as the
# provider quota collector. Needs `gh` (authenticated with actions:read and
# pull_requests:read on the repo) and `jq`.
#
#   DEPLOY_REPO      owner/repo                      (required)
#   DEPLOY_WORKFLOW  workflow file name, e.g. staging-deploy.yml (required)
#   DEPLOY_OUT       output path, default ~/.multica/deploy.json
#
# The deployed ref comes from the run name, so the workflow must declare
# `run-name: Deploy ${{ inputs.git_ref }} to staging`; the workflow_run API
# does not expose dispatch inputs. The PR is the one whose head is that ref,
# and the issue identifier is the last KEY-123 token in the PR title (the
# conventional-commit scope, e.g. "fix(P3-9): ... (LAP-304)", is skipped by
# taking the last match).
set -euo pipefail

: "${DEPLOY_REPO:?DEPLOY_REPO (owner/repo) is required}"
: "${DEPLOY_WORKFLOW:?DEPLOY_WORKFLOW (workflow file) is required}"
OUT="${DEPLOY_OUT:-$HOME/.multica/deploy.json}"
OWNER="${DEPLOY_REPO%%/*}"

run=$(gh api "repos/$DEPLOY_REPO/actions/workflows/$DEPLOY_WORKFLOW/runs?per_page=1" \
  --jq '.workflow_runs[0] // empty')
if [ -z "$run" ]; then
  echo "no runs found for $DEPLOY_REPO/$DEPLOY_WORKFLOW" >&2
  exit 1
fi

title=$(jq -r '.display_title // ""' <<<"$run")
ref=$(sed -nE 's/^Deploy (.+) to staging$/\1/p' <<<"$title")

pr="null"
issue="null"
if [ -n "$ref" ]; then
  pr=$(gh api "repos/$DEPLOY_REPO/pulls?head=$OWNER:$ref&state=all&per_page=1" \
    --jq '.[0] // null | if . == null then null else {number, title, url: .html_url} end')
  if [ "$pr" != "null" ]; then
    # Last KEY-123 token in the PR title. grep -o emits one match per line in
    # order of appearance, so tail picks the trailing one.
    issue=$(jq -r '.title' <<<"$pr" | grep -oE '\b[A-Z][A-Z0-9]*-[0-9]+\b' | tail -n 1 || true)
    if [ -n "$issue" ]; then issue=$(jq -Rn --arg v "$issue" '$v'); else issue="null"; fi
  fi
fi

mkdir -p "$(dirname "$OUT")"
tmp="$OUT.tmp"
jq -n \
  --argjson run "$run" \
  --argjson pr "$pr" \
  --argjson issue "$issue" \
  --arg ref "$ref" \
  --arg generatedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{
    schema: "multica.deploy.v1",
    generatedAt: $generatedAt,
    workflow: ($run.name // ""),
    run: {
      status: ($run.status // ""),
      conclusion: $run.conclusion,
      url: ($run.html_url // ""),
      createdAt: $run.created_at,
      updatedAt: $run.updated_at,
      actor: ($run.actor.login // null),
      ref: (if $ref == "" then null else $ref end),
      title: ($run.display_title // "")
    },
    pr: $pr,
    issueIdentifier: $issue
  }' >"$tmp"
mv "$tmp" "$OUT"
