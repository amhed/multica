#!/usr/bin/env bash
# Exercises scripts/deploy-snapshot.sh against a fake `gh` so the run-name
# parsing and issue-identifier extraction are pinned without network access.
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
  repos/acme/mono/actions/workflows/staging-deploy.yml/runs*)
    body='{"workflow_runs":[{"name":"Deploy to Staging","display_title":"Deploy fix/p3-9 to staging","status":"completed","conclusion":"success","html_url":"https://github.com/acme/mono/actions/runs/1","created_at":"2026-09-05T10:00:00Z","updated_at":"2026-09-05T10:05:00Z","actor":{"login":"amhed"}}]}' ;;
  repos/acme/mono/pulls?head=acme:fix/p3-9*)
    body='[{"number":197,"title":"fix(P3-9): simulator responds directly (LAP-304)","html_url":"https://github.com/acme/mono/pull/197"}]' ;;
  repos/acme/mono/pulls?head=acme:nopr*)
    body='[]' ;;
  *) echo "unexpected path $path" >&2; exit 1 ;;
esac
jq "$4" <<<"$body"
FAKE
chmod +x "$TMP/bin/gh"

export PATH="$TMP/bin:$PATH"
export DEPLOY_REPO=acme/mono DEPLOY_WORKFLOW=staging-deploy.yml DEPLOY_OUT="$TMP/deploy.json"
bash "$ROOT_DIR/scripts/deploy-snapshot.sh"

expect() {
  local expr=$1 want=$2 got
  got=$(jq -r "$expr" "$DEPLOY_OUT")
  if [ "$got" != "$want" ]; then
    echo "deploy.json $expr: want $want, got $got"
    exit 1
  fi
}
expect '.schema' 'multica.deploy.v1'
expect '.run.conclusion' 'success'
expect '.run.actor' 'amhed'
expect '.run.ref' 'fix/p3-9'
expect '.pr.number' '197'
# Last KEY-123 token wins: the conventional-commit scope P3-9 is skipped.
expect '.issueIdentifier' 'LAP-304'
echo "deploy-snapshot.test.sh: ok"
