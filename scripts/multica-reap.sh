#!/usr/bin/env bash
# Finds and kills *leaked* agent child processes that the local agent runtime
# daemon spawned but never reaped — hung workspace verification tooling and
# stale per-run MCP servers that pin CPU and exhaust swap, freezing every
# queued agent (0 running / N queued in the Active board).
#
# Runs on the host, outside the app, in the same spirit as the deploy and
# provider-quota collectors. It NEVER touches the daemon itself, the Docker
# engine/containers, the workspace-independent Postgres container, sshd, or
# itself; selection is scoped to the workspaces root and a small set of
# known-leak process signatures, and is age-gated so live runs are left alone.
#
# Usage:
#   scripts/multica-reap.sh [--apply] [--min-age MIN] [--include-runtime]
#
#   (default)          dry run: print what WOULD be reaped and exit 0.
#   --apply            actually reap (TERM, then KILL after a grace period).
#   --min-age MIN      only match processes older than MIN minutes (default 30).
#   --include-runtime  also reap hung agent runtimes (grok/opencode `agent`),
#                      which are OFF by default because they are the work,
#                      not the leak.
#
# Exit status: 0 on success (including a clean dry run), non-zero on a usage
# or runtime error. In dry-run mode the exit status does not depend on whether
# any leaks were found.
set -euo pipefail

MIN_AGE_MINUTES=30
APPLY=0
INCLUDE_RUNTIME=0
GRACE_SECONDS=5

usage() {
	sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'
}

while [[ $# -gt 0 ]]; do
	case "$1" in
	--apply) APPLY=1 ;;
	--include-runtime) INCLUDE_RUNTIME=1 ;;
	--min-age)
		shift
		[[ ${1:-} =~ ^[0-9]+$ ]] || {
			echo "multica-reap: --min-age needs a whole number of minutes" >&2
			exit 2
		}
		MIN_AGE_MINUTES=$1
		;;
	-h | --help)
		usage
		exit 0
		;;
	*)
		echo "multica-reap: unknown argument: $1" >&2
		usage >&2
		exit 2
		;;
	esac
	shift
done

MIN_AGE_SECONDS=$((MIN_AGE_MINUTES * 60))
SELF_PID=$$

# Process enumeration is isolated in one function so the test suite can shim it
# with a fixture `ps` on PATH. Columns: pid ppid etimes pcpu args (args last so
# it may contain spaces).
enumerate_processes() {
	ps -eo pid=,ppid=,etimes=,pcpu=,args= 2>/dev/null || true
}

# Hard exclusions applied to every candidate regardless of age or match. These
# are the processes a reaper must never kill.
is_protected() {
	local args="$1"
	case "$args" in
	*multica-daemon* | *"daemon start"* | *"daemon --foreground"*) return 0 ;;
	*dockerd* | *containerd* | *docker-proxy*) return 0 ;;
	*sshd*) return 0 ;;
	esac
	return 1
}

# Returns 0 and echoes a human reason when args match a known leak signature.
# Every workspace-scoped signature also requires the workspaces path, so the
# Postgres *container* (not under multica_workspaces) can never match.
classify_leak() {
	local args="$1"

	if ((INCLUDE_RUNTIME)); then
		if [[ "$args" =~ grok-[0-9].*[[:space:]]agent([[:space:]]|$) ]] ||
			[[ "$args" =~ (^|/)opencode([[:space:]]|$) ]]; then
			echo "hung agent runtime"
			return 0
		fi
	fi

	if [[ "$args" == *multica_workspaces/* ]] &&
		[[ "$args" =~ (vitest|esbuild|eslint|tsc|vite) ]]; then
		echo "workspace verification tooling"
		return 0
	fi

	if [[ "$args" == *multica_workspaces/* ]] &&
		[[ "$args" =~ (@embedded-postgres|/postgres([[:space:]]|$)) ]]; then
		echo "workspace embedded postgres"
		return 0
	fi

	if [[ "$args" =~ @railway/cli@[0-9.]+[[:space:]]mcp[[:space:]]local ]] ||
		[[ "$args" == *"mcp-remote https://mcp.neon.tech"* ]] ||
		[[ "$args" == *jev-mcp/mcp-server* ]]; then
		echo "stale MCP server"
		return 0
	fi

	return 1
}

# ---- pass 1: snapshot every process ----------------------------------------
declare -A PPID_OF=() ETIMES_OF=() PCPU_OF=() ARGS_OF=()
declare -A CHILDREN_OF=()
ALL_PIDS=()

while read -r pid ppid etimes pcpu args; do
	[[ "$pid" =~ ^[0-9]+$ ]] || continue
	PPID_OF["$pid"]="$ppid"
	ETIMES_OF["$pid"]="$etimes"
	PCPU_OF["$pid"]="$pcpu"
	ARGS_OF["$pid"]="$args"
	CHILDREN_OF["$ppid"]+=" $pid"
	ALL_PIDS+=("$pid")
done < <(enumerate_processes)

# ---- pass 2: classify base targets -----------------------------------------
declare -A REASON_OF=()
for pid in "${ALL_PIDS[@]}"; do
	[[ "$pid" == "$SELF_PID" ]] && continue
	args="${ARGS_OF[$pid]}"
	[[ "$args" == *"ps -eo pid="* ]] && continue # our own enumerator
	is_protected "$args" && continue
	((ETIMES_OF["$pid"] < MIN_AGE_SECONDS)) && continue
	if reason="$(classify_leak "$args")"; then
		REASON_OF["$pid"]="$reason"
	fi
done

# ---- pass 3: pull in descendants so children (esbuild, tsc) don't orphan ----
queue=("${!REASON_OF[@]}")
while ((${#queue[@]})); do
	parent="${queue[0]}"
	queue=("${queue[@]:1}")
	for child in ${CHILDREN_OF[$parent]:-}; do
		[[ -n "${REASON_OF[$child]:-}" ]] && continue
		is_protected "${ARGS_OF[$child]:-}" && continue
		REASON_OF["$child"]="descendant of ${parent}"
		queue+=("$child")
	done
done

# ---- report -----------------------------------------------------------------
TARGET_PIDS=("${!REASON_OF[@]}")

load_now() { awk '{print $1" "$2" "$3}' /proc/loadavg 2>/dev/null || echo "n/a"; }

if ((${#TARGET_PIDS[@]} == 0)); then
	echo "multica-reap: no leaked processes older than ${MIN_AGE_MINUTES}m found."
	exit 0
fi

# Stable ordering: oldest first.
mapfile -t TARGET_PIDS < <(
	for pid in "${TARGET_PIDS[@]}"; do echo "${ETIMES_OF[$pid]} $pid"; done |
		sort -rn | awk '{print $2}'
)

printf '%-8s %8s %6s  %-30s %s\n' PID AGE %CPU REASON COMMAND
for pid in "${TARGET_PIDS[@]}"; do
	age_min=$((ETIMES_OF["$pid"] / 60))
	cmd="${ARGS_OF[$pid]}"
	printf '%-8s %7sm %6s  %-30s %.90s\n' \
		"$pid" "$age_min" "${PCPU_OF[$pid]}" "${REASON_OF[$pid]}" "$cmd"
done
echo

if ((!APPLY)); then
	echo "DRY RUN: would reap ${#TARGET_PIDS[@]} process(es). Re-run with --apply to act."
	exit 0
fi

echo "load before: $(load_now)"
echo "reaping ${#TARGET_PIDS[@]} process(es)..."
for pid in "${TARGET_PIDS[@]}"; do kill -TERM "$pid" 2>/dev/null || true; done
sleep "$GRACE_SECONDS"
survivors=0
for pid in "${TARGET_PIDS[@]}"; do
	if kill -0 "$pid" 2>/dev/null; then
		kill -KILL "$pid" 2>/dev/null || true
		((survivors++)) || true
	fi
done
echo "reaped ${#TARGET_PIDS[@]} process(es) (${survivors} needed SIGKILL)."
echo "load after:  $(load_now)"
