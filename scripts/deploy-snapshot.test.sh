#!/usr/bin/env bash
# Exercises scripts/deploy-snapshot.sh against a fake `gh` so the per-target
# run lookup, PR resolution and issue-identifier extraction are pinned without
# network access.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$TMP/bin"
cat >"$TMP/bin/gh" <<'FAKE'
#!/usr/bin/env bash
# Fake gh: `gh api <path> --jq <expr>` over canned bodies.
path=$2
case "$path" in
  repos/acme/alpha/actions/workflows/deploy-staging.yml/runs*)
    body='{"workflow_runs":[{"name":"Deploy to staging","status":"completed","conclusion":"success","html_url":"https://github.com/acme/alpha/actions/runs/1","head_sha":"1a30d1c0000","created_at":"2026-09-05T10:00:00Z","updated_at":"2026-09-05T10:05:00Z","actor":{"login":"amhed"}}]}' ;;
  repos/acme/alpha/commits/1a30d1c0000/pulls)
    body='[{"number":195,"title":"fix(SEG-222): decode every bytea read","html_url":"https://github.com/acme/alpha/pull/195"}]' ;;
  repos/acme/beta/actions/workflows/deploy-staging.yml/runs*)
    body='{"workflow_runs":[{"name":"Deploy staging","status":"in_progress","conclusion":null,"html_url":"https://github.com/acme/beta/actions/runs/2","head_sha":"190e40b0000","created_at":"2026-09-06T00:20:00Z","updated_at":"2026-09-06T00:23:00Z","actor":{"login":"amhed"}}]}' ;;
  repos/acme/beta/commits/190e40b0000/pulls)
    body='[]' ;;
  *) echo "unexpected path $path" >&2; exit 1 ;;
esac
jq "$4" <<<"$body"
FAKE
chmod +x "$TMP/bin/gh"

export PATH="$TMP/bin:$PATH"
export DEPLOY_TARGETS="acme/alpha:deploy-staging.yml acme/beta:deploy-staging.yml" DEPLOY_OUT="$TMP/deploy.json"
bash "$ROOT_DIR/scripts/deploy-snapshot.sh"

expect() {
  local expr=$1 want=$2 got
  got=$(jq -r "$expr" "$DEPLOY_OUT")
  if [ "$got" != "$want" ]; then
    echo "deploy.json $expr: want $want, got $got"
    exit 1
  fi
}
expect '.schema' 'multica.deploy.v2'
expect '.deploys | length' '2'
expect '.deploys[0].repo' 'acme/alpha'
expect '.deploys[0].workflow' 'Deploy to staging'
expect '.deploys[0].run.conclusion' 'success'
expect '.deploys[0].run.actor' 'amhed'
expect '.deploys[0].pr.number' '195'
expect '.deploys[0].issueIdentifier' 'SEG-222'
# Second target: running, no PR for the commit, so no links.
expect '.deploys[1].repo' 'acme/beta'
expect '.deploys[1].run.status' 'in_progress'
expect '.deploys[1].run.conclusion' 'null'
expect '.deploys[1].pr' 'null'
expect '.deploys[1].issueIdentifier' 'null'
echo "deploy-snapshot.test.sh: ok"
