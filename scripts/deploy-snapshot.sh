#!/usr/bin/env bash
# Writes the latest run of one or more GitHub Actions workflows to a JSON
# snapshot that the Multica server relays at GET /api/deploy (see
# handler.GetDeploy).
#
# Runs from cron on the host, outside the app, in the same spirit as the
# provider quota collector. Needs `gh` (authenticated with read access to
# actions and pull requests on each repo) and `jq`.
#
#   DEPLOY_TARGETS  space-separated owner/repo:workflow-file[:workspace-slug]
#                   entries (required), e.g.
#                   "acme/alpha:deploy-staging.yml:alpha acme/beta:deploy-staging.yml"
#                   The optional slug restricts the row to one Multica
#                   workspace; without it the row shows in every workspace.
#   DEPLOY_OUT      output path, default ~/.multica/deploy.json
#
# Each run's head commit is resolved to the PR that introduced it, and the
# issue identifier is the last KEY-123 token in that PR's title (so a
# conventional-commit scope like "fix(P3-9): ... (LAP-304)" yields LAP-304).
set -euo pipefail

: "${DEPLOY_TARGETS:?DEPLOY_TARGETS (owner/repo:workflow ...) is required}"
OUT="${DEPLOY_OUT:-$HOME/.multica/deploy.json}"

deploys="[]"
for target in $DEPLOY_TARGETS; do
  IFS=: read -r repo workflow workspace <<<"$target"
  run=$(gh api "repos/$repo/actions/workflows/$workflow/runs?per_page=1" \
    --jq '.workflow_runs[0] // empty')
  if [ -z "$run" ]; then
    echo "no runs found for $repo/$workflow" >&2
    continue
  fi

  sha=$(jq -r '.head_sha // ""' <<<"$run")
  pr="null"
  issue="null"
  if [ -n "$sha" ]; then
    pr=$(gh api "repos/$repo/commits/$sha/pulls" \
      --jq '.[0] // null | if . == null then null else {number, title, url: .html_url} end')
    if [ "$pr" != "null" ]; then
      # grep -o emits one match per line in order of appearance; tail keeps
      # the trailing one.
      issue=$(jq -r '.title' <<<"$pr" | grep -oE '\b[A-Z][A-Z0-9]*-[0-9]+\b' | tail -n 1 || true)
      if [ -n "$issue" ]; then issue=$(jq -Rn --arg v "$issue" '$v'); else issue="null"; fi
    fi
  fi

  entry=$(jq -n --arg repo "$repo" --arg workspace "${workspace:-}" \
    --argjson run "$run" --argjson pr "$pr" --argjson issue "$issue" '{
    repo: $repo,
    workspace: (if $workspace == "" then null else $workspace end),
    workflow: ($run.name // ""),
    run: {
      status: ($run.status // ""),
      conclusion: $run.conclusion,
      url: ($run.html_url // ""),
      createdAt: $run.created_at,
      updatedAt: $run.updated_at,
      actor: ($run.actor.login // null),
      headSha: ($run.head_sha // null)
    },
    pr: $pr,
    issueIdentifier: $issue
  }')
  deploys=$(jq --argjson e "$entry" '. + [$e]' <<<"$deploys")
done

mkdir -p "$(dirname "$OUT")"
tmp="$OUT.tmp"
jq -n --argjson deploys "$deploys" --arg generatedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{schema: "multica.deploy.v2", generatedAt: $generatedAt, deploys: $deploys}' >"$tmp"
mv "$tmp" "$OUT"
