#!/usr/bin/env bash
# Exercises scripts/multica-reap.sh against a fake `ps` so the leak-selection,
# age-gate, descendant pickup and hard exclusions are pinned without touching
# real processes. Always runs in dry-run mode, so nothing is ever killed.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$ROOT_DIR/scripts/multica-reap.sh"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

WS="/home/multica/multica_workspaces/kanban-abc/kan-1/workdir/carro-pana"

# Fixture process table: pid ppid etimes pcpu args
# etimes is seconds; default --min-age is 30m (1800s).
cat >"$TMP/proctable" <<EOF
1001 1788 36000 55.0 node $WS/node_modules/.bin/../eslint/bin/eslint.js . --cache
1002 1788 36000 33.0 $WS/node_modules/.pnpm/@esbuild+linux-x64@0.21.5/node_modules/@esbuild/linux-x64/bin/esbuild
1003 1788 35000 20.0 node $WS/node_modules/.bin/../typescript/bin/tsc --noEmit
1004 1 40000 0.0 node /home/multica/.local/bin/pnpm dlx @railway/cli@5.54.0 mcp local
1005 1 120000 1.8 node /home/multica/.npm/_npx/x/node_modules/.bin/mcp-remote https://mcp.neon.tech/mcp --header Authorization:redacted
1006 1050 50000 4.5 $WS/pg-scratch/node_modules/@embedded-postgres/linux-x64/native/bin/postgres
1010 1001 34000 10.0 /bin/sh -c internal-child-of-eslint
1788 1 130000 17.0 multica daemon start --profile default
2001 1 200000 0.5 /usr/lib/postgresql/16/bin/postgres -D /var/lib/postgresql/data
2002 1 200000 0.0 /usr/sbin/sshd -D
2003 1 300000 0.1 /usr/bin/dockerd --host=fd://
2004 1788 600 50.0 node $WS/node_modules/.bin/vitest
2005 1788 39000 68.0 /home/multica/.grok/downloads/grok-1.0.25-linux-x86_64 --no-auto-update agent --always-approve stdio
EOF

mkdir -p "$TMP/bin"
cat >"$TMP/bin/ps" <<EOF
#!/usr/bin/env bash
cat "$TMP/proctable"
EOF
chmod +x "$TMP/bin/ps"
export PATH="$TMP/bin:$PATH"

# Reaped PIDs are the all-digit first column of the printed table.
selected() { grep -oE '^[0-9]+' <<<"$1" | sort -n | paste -sd, -; }

fail() {
	echo "FAIL: $1" >&2
	echo "--- output ---" >&2
	echo "$2" >&2
	exit 1
}

# --- default flags -----------------------------------------------------------
out=$(bash "$SCRIPT")
got=$(selected "$out")
want="1001,1002,1003,1004,1005,1006,1010"
[[ "$got" == "$want" ]] || fail "default selection: got [$got] want [$want]" "$out"

for protected in 1788 2001 2002 2003; do
	[[ ",$got," == *",$protected,"* ]] && fail "protected pid $protected was selected" "$out"
done
[[ ",$got," == *",2004,"* ]] && fail "under-age pid 2004 was selected" "$out"
[[ ",$got," == *",2005,"* ]] && fail "runtime pid 2005 selected without --include-runtime" "$out"

# --- --include-runtime -------------------------------------------------------
out=$(bash "$SCRIPT" --include-runtime)
got=$(selected "$out")
[[ ",$got," == *",2005,"* ]] || fail "runtime pid 2005 not selected with --include-runtime" "$out"

# --- --min-age raises the gate ----------------------------------------------
# 1004 is a base target at 40000s (~666m) with no targeted parent; a 700m gate
# drops it while keeping the 2000m mcp-remote 1005. (Descendants are reaped
# with their parent regardless of their own age, so the gate is tested on a
# base target, not a child.)
out=$(bash "$SCRIPT" --min-age 700)
got=$(selected "$out")
[[ ",$got," == *",1004,"* ]] && fail "--min-age 700 should exclude the 666m base target 1004" "$out"
[[ ",$got," == *",1005,"* ]] || fail "--min-age 700 should keep the 2000m mcp-remote 1005" "$out"

# --- dry run never claims to have killed ------------------------------------
[[ "$out" == *"DRY RUN"* ]] || fail "default run should announce DRY RUN" "$out"
[[ "$out" == *"reaped"* ]] && fail "dry run must not report reaping" "$out"

# --- --json dry run: single valid JSON document ------------------------------
out=$(bash "$SCRIPT" --json)
echo "$out" | jq -e . >/dev/null 2>&1 || fail "--json dry run is not valid JSON" "$out"
[[ "$(echo "$out" | jq -r .mode)" == "dryrun" ]] || fail "--json mode != dryrun" "$out"
[[ "$(echo "$out" | jq -r .load_after)" == "null" ]] || fail "--json dry run must not set load_after" "$out"
[[ "$(echo "$out" | jq -r .sigkilled)" == "null" ]] || fail "--json dry run must not set sigkilled" "$out"
want_count=$(tr ',' '\n' <<<"$want" | wc -l | tr -d ' ')
[[ "$(echo "$out" | jq -r .count)" == "$want_count" ]] || fail "--json count mismatch, want $want_count" "$out"
# Full untruncated command for pid 1001 (fixture command is > 90 chars).
cmd=$(echo "$out" | jq -r '.processes[] | select(.pid==1001) | .command')
[[ ${#cmd} -gt 90 ]] || fail "--json command was truncated to <=90 chars" "$out"
[[ "$(echo "$out" | jq -r '.processes[] | select(.pid==1001) | .reason')" == "workspace verification tooling" ]] ||
	fail "--json wrong reason for pid 1001" "$out"

# --- --json empty result -----------------------------------------------------
out=$(bash "$SCRIPT" --json --min-age 100000)
echo "$out" | jq -e . >/dev/null 2>&1 || fail "--json empty is not valid JSON" "$out"
[[ "$(echo "$out" | jq -r .count)" == "0" ]] || fail "--json empty count != 0" "$out"
[[ "$(echo "$out" | jq -c .processes)" == "[]" ]] || fail "--json empty processes != []" "$out"

echo "PASS: all multica-reap selection cases"
