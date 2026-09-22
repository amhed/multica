# Reaper UX Trigger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin or owner run the `multica-reap.sh` leaked-process reaper from the Active board's "Under pressure" host card, with a dry-run preview then a confirmed apply.

**Architecture:** The daemon shells out to `scripts/multica-reap.sh` with a new additive `--json` mode. The request/response crosses server↔daemon by reusing the existing runtime-keyed `model_list` machinery: the client POSTs with the `daemon_id` it already holds, the server resolves that to a live runtime of the daemon and enqueues into an in-memory `HostReapStore`, the daemon claims the work on its next HTTP heartbeat (which carries a new `PendingReap` field), runs the script, and POSTs the structured result back up. The client polls a GET result endpoint until terminal.

**Tech Stack:** Bash, Go (Chi, in-memory stores, daemon WS/heartbeat), TypeScript, React, TanStack Query, Zustand, zod.

**Spec:** `docs/superpowers/specs/2026-09-22-reaper-ux-trigger-design.md`

**Deviation from spec (locked in during planning):** The spec called for a "DB-backed `ReapRequestStore`" plus a migration. The reference `model_list` implementation this design mirrors uses an **in-memory** store behind an interface (`ModelListStore` / `InMemoryModelListStore`, `server/internal/handler/runtime_models.go:172-183,214`), with a Redis impl for multi-node. Reaper requests are transient (seconds-long lifecycle, ~2 minute retention) and need not survive a restart, so this plan mirrors the in-memory pattern and creates **no migration**. Everything else follows the spec.

## Global Constraints

- Leaked tooling only: the daemon never passes `--include-runtime`; the 30-minute age gate is the script default and is not overridden.
- Both the preview (dry-run) and apply endpoints are gated to `"owner"` / `"admin"` via `requireWorkspaceRole`.
- The `--json` output carries the **full untruncated** process command (the text path's `%.90s` truncation must not leak into JSON).
- The existing text output of `multica-reap.sh` stays the default; `scripts/multica-reap.test.sh` text-path assertions stay unchanged.
- UI-consumed JSON passes through a zod schema and `parseWithFallback`, never an `as T` cast (`packages/core/api/schemas.ts`).
- New copy is added in both `en` and `zh` locales per the conventions pages; state each fact once beside its control.
- Default tests must not resolve or execute a real agent CLI or the real reaper script: pass a fake or missing executable path (AGENTS.md Testing rules).
- Views tests must not mock `next/*` or `react-router-dom`; mock API at `@multica/core/api`; mock stores with their Zustand callable-plus-`getState` shape.
- Code comments are English. Commits are atomic and conventional. End every commit message with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

### Task 1: Script `--json` output mode

**Files:**
- Modify: `scripts/multica-reap.sh` (arg parser lines 37-60; report block lines 161-203)
- Test: `scripts/multica-reap.test.sh`

**Interfaces:**
- Produces: a `--json` flag. When set, the script writes ONE JSON document to stdout instead of the text table, for both dry-run and apply. Shape:
  `{ "mode": "dryrun"|"apply", "min_age_minutes": int, "include_runtime": bool, "count": int, "load_before": string, "load_after": string|null, "sigkilled": int|null, "processes": [ { "pid": int, "age_seconds": int, "pcpu": string, "reason": string, "command": string } ] }`
  `load_after` and `sigkilled` are present only for apply. `processes` is `[]` and `count` is `0` when nothing matches. `command` is the full untruncated args string.

- [ ] **Step 1: Write the failing test**

Add to `scripts/multica-reap.test.sh` (follow the file's existing fixture-`ps`-on-PATH harness). Two cases:

```bash
test_json_dryrun_shape() {
  # Arrange: fixture ps yields one leaked vitest process older than 30m under multica_workspaces.
  output="$(PATH="$FIXTURE_BIN:$PATH" "$REAP" --json)"
  # A single valid JSON object:
  echo "$output" | jq -e . >/dev/null || fail "dry-run --json is not valid JSON"
  # Mode + dry-run fields:
  [ "$(echo "$output" | jq -r .mode)" = "dryrun" ] || fail "mode != dryrun"
  [ "$(echo "$output" | jq -r .count)" = "1" ] || fail "count != 1"
  [ "$(echo "$output" | jq -r '.load_after')" = "null" ] || fail "dry-run must not set load_after"
  # Full untruncated command (fixture command is > 90 chars):
  cmd="$(echo "$output" | jq -r '.processes[0].command')"
  [ "${#cmd}" -gt 90 ] || fail "command was truncated to <=90 chars"
  [ "$(echo "$output" | jq -r '.processes[0].reason')" = "workspace verification tooling" ] || fail "wrong reason"
}

test_json_empty() {
  output="$(PATH="$EMPTY_FIXTURE_BIN:$PATH" "$REAP" --json)"
  [ "$(echo "$output" | jq -r .count)" = "0" ] || fail "empty count != 0"
  [ "$(echo "$output" | jq -c '.processes')" = "[]" ] || fail "empty processes != []"
}
```

If the existing test file has no `jq` dependency, mirror its existing assertion style instead (grep on stable substrings) and keep `jq` usage out; but prefer `jq` if the repo's test env already has it. Register both cases in the file's test runner list.

- [ ] **Step 2: Run test to verify it fails**

Run: `scripts/multica-reap.test.sh`
Expected: FAIL — `--json` is an unknown argument (parser exits 2), so no JSON is produced.

- [ ] **Step 3: Implement `--json`**

In the arg parser (around line 39) add:

```bash
	--json) JSON=1 ;;
```

Add `JSON=0` to the defaults block (near line 28). Add a JSON emit helper and branch the report. Emit with dependency-free bash string building (no new runtime dependency); escape `command` for JSON. Replace the report/apply tail so that when `JSON=1` the text `printf`/`echo` lines are skipped and a single JSON document is emitted instead:

```bash
# JSON string escaper: backslash, double-quote, control chars.
json_escape() {
	local s=$1
	s=${s//\\/\\\\}
	s=${s//\"/\\\"}
	s=${s//$'\t'/\\t}
	s=${s//$'\n'/\\n}
	s=${s//$'\r'/\\r}
	printf '%s' "$s"
}

emit_json() {
	local mode=$1 load_after=$2 sigkilled=$3
	local procs="" sep=""
	for pid in "${TARGET_PIDS[@]}"; do
		procs+="${sep}{\"pid\":${pid},\"age_seconds\":${ETIMES_OF[$pid]},\"pcpu\":\"$(json_escape "${PCPU_OF[$pid]}")\",\"reason\":\"$(json_escape "${REASON_OF[$pid]}")\",\"command\":\"$(json_escape "${ARGS_OF[$pid]}")\"}"
		sep=","
	done
	printf '{"mode":"%s","min_age_minutes":%s,"include_runtime":%s,"count":%s,"load_before":"%s",%s%s"processes":[%s]}\n' \
		"$mode" "$MIN_AGE_MINUTES" "$([ "$INCLUDE_RUNTIME" = 1 ] && echo true || echo false)" \
		"${#TARGET_PIDS[@]}" "$(json_escape "$(load_now)")" \
		"$([ -n "$load_after" ] && printf '"load_after":"%s",' "$(json_escape "$load_after")" || printf '"load_after":null,')" \
		"$([ -n "$sigkilled" ] && printf '"sigkilled":%s,' "$sigkilled" || printf '"sigkilled":null,')" \
		"$procs"
}
```

Then, in the report section: when `JSON=1` and there are zero targets, emit `emit_json "$([ "$APPLY" = 1 ] && echo apply || echo dryrun)" "" "$([ "$APPLY" = 1 ] && echo 0)"` with an empty `TARGET_PIDS` (the loop yields `[]`) and exit 0 before the text `printf` header. For the dry-run path (`!APPLY`), emit `emit_json dryrun "" ""` instead of the text table + `DRY RUN` line. For the apply path, capture `load_after="$(load_now)"` and `sigkilled` after the kill loop and emit `emit_json apply "$load_after" "$survivors"` instead of the text footer lines. Guard each text `printf`/`echo` in the report/apply tail with `((JSON)) || { ...text... }` so text output is unchanged when `--json` is absent.

- [ ] **Step 4: Run test to verify it passes**

Run: `scripts/multica-reap.test.sh`
Expected: PASS for the new cases AND all pre-existing text-path cases.

- [ ] **Step 5: Commit**

```bash
git add scripts/multica-reap.sh scripts/multica-reap.test.sh
git commit -m "feat(ops): add --json output mode to multica-reap.sh

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Protocol additions + in-memory `HostReapStore`

**Files:**
- Modify: `server/pkg/protocol/messages.go` (const block 154-159; `DaemonHeartbeatAckPayload` 426-440; add types near 455-457)
- Modify: `server/internal/daemon/client.go` (type-alias block 670-677)
- Create: `server/internal/handler/host_reap_store.go`
- Test: `server/internal/handler/host_reap_store_test.go`

**Interfaces:**
- Produces (protocol):
  - `protocol.PendingWorkKindHostReap = "host_reap"`
  - `type DaemonHeartbeatPendingReap struct { ID string \`json:"id"\`; Mode string \`json:"mode"\` }`
  - `DaemonHeartbeatAckPayload.PendingReap *DaemonHeartbeatPendingReap \`json:"pending_reap,omitempty"\``
  - `daemon.PendingReap = protocol.DaemonHeartbeatPendingReap` (alias)
- Produces (store):
  - `type HostReapStatus string` with `HostReapPending/Running/Completed/Failed/Timeout` = `"pending"/"running"/"completed"/"failed"/"timeout"`
  - `type HostReapMode string` with `HostReapDryRun = "dryrun"`, `HostReapApply = "apply"`
  - `type HostReapRequest struct { ID, DaemonID, WorkspaceID, RuntimeID string; Mode HostReapMode; Status HostReapStatus; Result json.RawMessage; Error string; RequestedBy string; CreatedAt, UpdatedAt time.Time; RunStartedAt *time.Time }`
  - `type HostReapStore interface { Create(ctx, daemonID, workspaceID, runtimeID string, mode HostReapMode, requestedBy string) (*HostReapRequest, error); Get(ctx, id string) (*HostReapRequest, error); HasPending(ctx, runtimeID string) (bool, error); PopPending(ctx, runtimeID string) (*HostReapRequest, error); Complete(ctx, id string, result json.RawMessage) error; Fail(ctx, id, errMsg string) error }`
  - `NewInMemoryHostReapStore() *InMemoryHostReapStore`

- [ ] **Step 1: Write the failing store test**

Create `server/internal/handler/host_reap_store_test.go`:

```go
package handler

import (
	"context"
	"encoding/json"
	"testing"
)

func TestHostReapStoreLifecycle(t *testing.T) {
	ctx := context.Background()
	s := NewInMemoryHostReapStore()

	req, err := s.Create(ctx, "daemon-1", "ws-1", "rt-1", HostReapDryRun, "user-1")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if req.Status != HostReapPending {
		t.Fatalf("new request status = %q, want pending", req.Status)
	}

	has, _ := s.HasPending(ctx, "rt-1")
	if !has {
		t.Fatal("HasPending(rt-1) = false, want true")
	}

	popped, _ := s.PopPending(ctx, "rt-1")
	if popped == nil || popped.ID != req.ID {
		t.Fatalf("PopPending returned %v, want request %s", popped, req.ID)
	}
	if again, _ := s.PopPending(ctx, "rt-1"); again != nil {
		t.Fatal("second PopPending should be nil (already claimed)")
	}

	if err := s.Complete(ctx, req.ID, json.RawMessage(`{"count":0}`)); err != nil {
		t.Fatalf("Complete: %v", err)
	}
	got, _ := s.Get(ctx, req.ID)
	if got.Status != HostReapCompleted || string(got.Result) != `{"count":0}` {
		t.Fatalf("after Complete: status=%q result=%s", got.Status, got.Result)
	}
}

func TestHostReapStoreFail(t *testing.T) {
	ctx := context.Background()
	s := NewInMemoryHostReapStore()
	req, _ := s.Create(ctx, "d", "w", "rt", HostReapApply, "u")
	if err := s.Fail(ctx, req.ID, "boom"); err != nil {
		t.Fatalf("Fail: %v", err)
	}
	got, _ := s.Get(ctx, req.ID)
	if got.Status != HostReapFailed || got.Error != "boom" {
		t.Fatalf("after Fail: status=%q err=%q", got.Status, got.Error)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `(cd server && go test ./internal/handler/ -run TestHostReapStore -count=1)`
Expected: FAIL — `NewInMemoryHostReapStore` and the types are undefined (does not compile).

- [ ] **Step 3: Implement protocol additions and the store**

In `server/pkg/protocol/messages.go`, add to the pending-work const block (154-159):

```go
	PendingWorkKindHostReap         = "host_reap"
```

Add the `PendingReap` field to `DaemonHeartbeatAckPayload` (alongside `PendingModelList`):

```go
	PendingReap             *DaemonHeartbeatPendingReap             `json:"pending_reap,omitempty"`
```

Add the type near `DaemonHeartbeatPendingModelList` (455):

```go
// DaemonHeartbeatPendingReap tells the daemon a host-reap request is queued.
// Mode is "dryrun" or "apply".
type DaemonHeartbeatPendingReap struct {
	ID   string `json:"id"`
	Mode string `json:"mode"`
}
```

In `server/internal/daemon/client.go` alias block (670-677), add:

```go
	PendingReap = protocol.DaemonHeartbeatPendingReap
```

Create `server/internal/handler/host_reap_store.go` mirroring `InMemoryModelListStore` (`runtime_models.go:214-320`): a `sync.Mutex`-guarded `map[string]*HostReapRequest`, `Create` inserts a `HostReapPending` row with `crypto/rand`-based id and timestamps (reuse whatever id helper `InMemoryModelListStore.Create` uses), `HasPending` returns true if any row for `runtimeID` is `HostReapPending`, `PopPending` atomically flips the oldest pending row for `runtimeID` to `HostReapRunning` (set `RunStartedAt`) and returns it (nil if none), `Complete`/`Fail` mutate by id under the lock. Include a lightweight GC-on-insert like `ModelListStore` (drop rows older than a 2-minute retention). Comments in English.

- [ ] **Step 4: Run test to verify it passes**

Run: `(cd server && go test ./internal/handler/ -run TestHostReapStore -count=1)`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/pkg/protocol/messages.go server/internal/daemon/client.go server/internal/handler/host_reap_store.go server/internal/handler/host_reap_store_test.go
git commit -m "feat(reap): add host_reap protocol fields and in-memory store

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Hub method to resolve `daemon_id` → live runtime id

**Files:**
- Modify: `server/internal/daemonws/hub.go` (near `WorkspaceHostHealth` 853-883)
- Test: `server/internal/daemonws/hub_test.go` (add a case; create the file if the package has none)

**Interfaces:**
- Produces: `func (h *Hub) RuntimeForDaemon(workspaceID, daemonID string) (string, bool)` — returns a live runtime id belonging to `daemonID` within `workspaceID`, or `("", false)` if that daemon has no live runtime in the workspace.

- [ ] **Step 1: Write the failing test**

Add to `server/internal/daemonws/hub_test.go` a test that registers a fake client connection with `identity.DaemonID = "d1"`, `identity.WorkspaceID/WorkspaceIDs` containing `"ws1"`, and a live runtime `"rt1"`, then asserts:

```go
func TestRuntimeForDaemon(t *testing.T) {
	h := NewHub( /* mirror existing hub test constructor args */ )
	// register a connection for daemon d1 / ws1 / runtime rt1 using the same
	// helper existing hub tests use to add a client (mirror them).
	rt, ok := h.RuntimeForDaemon("ws1", "d1")
	if !ok || rt != "rt1" {
		t.Fatalf("RuntimeForDaemon = %q,%v; want rt1,true", rt, ok)
	}
	if _, ok := h.RuntimeForDaemon("ws1", "nope"); ok {
		t.Fatal("unknown daemon should return ok=false")
	}
}
```

If the package has no existing hub test harness to register clients, mirror the setup used by whatever test exercises `WorkspaceHostHealth`; if none exists, construct the minimal `*client` with a populated `identity` and insert it into `h.byWorkspace["ws1"]` directly within the test (same package, so unexported access is allowed).

- [ ] **Step 2: Run test to verify it fails**

Run: `(cd server && go test ./internal/daemonws/ -run TestRuntimeForDaemon -count=1)`
Expected: FAIL — `RuntimeForDaemon` undefined.

- [ ] **Step 3: Implement**

Add to `hub.go`, mirroring `WorkspaceHostHealth`'s locking and iteration:

```go
// RuntimeForDaemon returns a live runtime id belonging to daemonID within
// workspaceID, or ("", false) if that daemon has no live runtime there. Used
// to route a daemon-scoped request (host reap) through the runtime-keyed
// pending-work path.
func (h *Hub) RuntimeForDaemon(workspaceID, daemonID string) (string, bool) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for c := range h.byWorkspace[workspaceID] {
		if c.identity.DaemonID != daemonID {
			continue
		}
		if rid, ok := c.anyLiveRuntimeID(); ok {
			return rid, true
		}
	}
	return "", false
}
```

Add a small helper `anyLiveRuntimeID()` on `*client` that returns a runtime id from the live `c.runtimes` map under `c.runtimeMu` (preferred, reflects heartbeat liveness); fall back to the first of `c.identity.RuntimeIDs` if the live map is empty. If a suitable helper already exists on `*client`, use it instead of adding one.

- [ ] **Step 4: Run test to verify it passes**

Run: `(cd server && go test ./internal/daemonws/ -run TestRuntimeForDaemon -count=1)`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/internal/daemonws/hub.go server/internal/daemonws/hub_test.go
git commit -m "feat(reap): resolve a daemon id to a live runtime in the hub

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Server enqueue endpoint (`POST /api/host-health/{daemonId}/reap`)

**Files:**
- Modify: `server/internal/handler/agent.go` (near `GetWorkspaceHostHealth` 3025) — add `InitiateHostReap`
- Modify: `server/cmd/server/router.go` (near the host-health route 2259)
- Modify: `server/internal/handler/handler.go` — add `HostReapStore HostReapStore` field to `Handler`; add a `RuntimeForDaemon(workspaceID, daemonID string) (string, bool)` method to whatever daemon-hub interface the handler already depends on (mirror how `DaemonHub`/`DaemonPendingWork` are declared), and wire `NewInMemoryHostReapStore()` where the handler is constructed
- Test: `server/internal/handler/host_reap_test.go`

**Interfaces:**
- Consumes: `HostReapStore` (Task 2), `RuntimeForDaemon` (Task 3), `protocol.PendingWorkKindHostReap` (Task 2), existing `requireWorkspaceRole` (`handler.go:997`), existing `requestDaemonPendingWork` (`runtime_models.go:446`), the workspace-id derivation used by `GetWorkspaceHostHealth`.
- Produces: `POST /api/host-health/{daemonId}/reap` accepting `{"mode":"dryrun"|"apply"}`, returning `200 {"request_id": "<id>"}`. On no live runtime for the daemon, `503 {"error":"daemon offline"}`.

- [ ] **Step 1: Write the failing test**

Create `server/internal/handler/host_reap_test.go`. Use `server/internal/testutil` fixtures and `testutil.Call(h, req).Want(status).JSON(&out)`. Mirror an existing handler test that sets `X-Workspace-ID` and a member role. Cases:

```go
func TestInitiateHostReapRequiresAdmin(t *testing.T) {
	// member (non-admin) → 403
}

func TestInitiateHostReapRejectsForeignDaemon(t *testing.T) {
	// admin, but daemonId not present in this workspace's host health → 404/403
}

func TestInitiateHostReapEnqueues(t *testing.T) {
	// admin + daemon has a live runtime (stub RuntimeForDaemon to return "rt1", true):
	// → 200, body has non-empty request_id, and HostReapStore has a pending row
	//   with DaemonID/WorkspaceID/RuntimeID/Mode set and RequestedBy = caller.
	// Assert the pending-work hint was requested for "rt1" with kind "host_reap"
	//   (use a fake DaemonPendingWork notifier that records calls).
}

func TestInitiateHostReapDaemonOffline(t *testing.T) {
	// admin, RuntimeForDaemon returns ("",false) → 503
}
```

For the daemon-membership check, seed host health so `WorkspaceHostHealth(ws)` (or the same source `GetWorkspaceHostHealth` reads) returns the target `daemonId`; mirror how existing host-health handler tests seed it. Use a fake hub/notifier implementing `RuntimeForDaemon` and `NotifyPendingWork` that records its arguments.

- [ ] **Step 2: Run test to verify it fails**

Run: `(cd server && go test ./internal/handler/ -run TestInitiateHostReap -count=1)`
Expected: FAIL — `InitiateHostReap` and the route are undefined.

- [ ] **Step 3: Implement the handler and route**

Add `InitiateHostReap` to `agent.go`, deriving `workspaceID` exactly as `GetWorkspaceHostHealth` does:

```go
// InitiateHostReap enqueues a host-reap request (dry-run preview or apply) for
// the daemon behind daemonId and asks it to run the reaper on its next
// heartbeat. Admin/owner only; the daemon must currently serve this workspace.
func (h *Handler) InitiateHostReap(w http.ResponseWriter, r *http.Request) {
	workspaceID := /* same derivation as GetWorkspaceHostHealth (X-Workspace-ID + membership) */
	if !h.requireWorkspaceRole(w, r, workspaceID, "workspace not found", "owner", "admin") {
		return
	}
	daemonID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "daemonId"))
	if !ok {
		return
	}
	// Confirm the daemon currently serves this workspace (visible on the card).
	if !h.daemonInWorkspaceHostHealth(workspaceID, daemonID) {
		writeError(w, http.StatusNotFound, "daemon not found")
		return
	}
	var body struct {
		Mode string `json:"mode"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid body")
		return
	}
	mode := HostReapDryRun
	if body.Mode == string(HostReapApply) {
		mode = HostReapApply
	} else if body.Mode != string(HostReapDryRun) {
		writeError(w, http.StatusBadRequest, "mode must be dryrun or apply")
		return
	}
	runtimeID, ok := h.DaemonHub.RuntimeForDaemon(workspaceID, daemonID)
	if !ok {
		writeError(w, http.StatusServiceUnavailable, "daemon offline")
		return
	}
	req, err := h.HostReapStore.Create(r.Context(), daemonID, workspaceID, runtimeID, mode, currentUserID(r))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to enqueue: "+err.Error())
		return
	}
	h.requestDaemonPendingWork(runtimeID, protocol.PendingWorkKindHostReap)
	writeJSON(w, http.StatusOK, map[string]string{"request_id": req.ID})
}
```

Implement `daemonInWorkspaceHostHealth` as a small helper reusing the same source `GetWorkspaceHostHealth` reads (the hub's `WorkspaceHostHealth`). Use `currentUserID(r)` or the same user-id accessor other handlers use. Register the route in `router.go` beside the existing `GET /api/host-health` (2259), under the same auth/workspace middleware:

```go
r.Post("/api/host-health/{daemonId}/reap", h.InitiateHostReap)
```

Add the `HostReapStore` field and `RuntimeForDaemon` to the handler/hub interface as described in Files, and construct `NewInMemoryHostReapStore()` at handler wiring.

- [ ] **Step 4: Run test to verify it passes**

Run: `(cd server && go test ./internal/handler/ -run TestInitiateHostReap -count=1)`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/internal/handler/agent.go server/internal/handler/handler.go server/cmd/server/router.go server/internal/handler/host_reap_test.go
git commit -m "feat(reap): add admin-gated host-reap enqueue endpoint

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Server GET result endpoint (`GET /api/host-health/{daemonId}/reap/{requestId}`)

**Files:**
- Modify: `server/internal/handler/agent.go` — add `GetHostReapRequest`
- Modify: `server/cmd/server/router.go`
- Test: `server/internal/handler/host_reap_test.go` (extend)

**Interfaces:**
- Consumes: `HostReapStore.Get`, `requireWorkspaceRole`, `daemonInWorkspaceHostHealth`.
- Produces: `GET /api/host-health/{daemonId}/reap/{requestId}` → `200` with the `HostReapRequest` JSON (`{id,status,mode,result,error,...}`). `404` if the request is unknown or its `DaemonID`/`WorkspaceID` do not match the route + workspace.

- [ ] **Step 1: Write the failing test**

Extend `host_reap_test.go`:

```go
func TestGetHostReapRequest(t *testing.T) {
	// admin: create a pending row via the store, GET it → 200 status "pending".
	// Complete the row with result JSON, GET again → 200 status "completed" + result.
}

func TestGetHostReapRequestNotFoundForWrongDaemon(t *testing.T) {
	// row exists for daemon A; GET under daemon B's path → 404.
}

func TestGetHostReapRequestRequiresAdmin(t *testing.T) {
	// member → 403.
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `(cd server && go test ./internal/handler/ -run TestGetHostReapRequest -count=1)`
Expected: FAIL — `GetHostReapRequest` undefined.

- [ ] **Step 3: Implement**

Mirror `GetModelListRequest` (`runtime_models.go:460`), gating on workspace role and checking ownership by daemon + workspace:

```go
func (h *Handler) GetHostReapRequest(w http.ResponseWriter, r *http.Request) {
	workspaceID := /* same derivation as InitiateHostReap */
	if !h.requireWorkspaceRole(w, r, workspaceID, "workspace not found", "owner", "admin") {
		return
	}
	daemonID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "daemonId"))
	if !ok {
		return
	}
	req, err := h.HostReapStore.Get(r.Context(), chi.URLParam(r, "requestId"))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load request: "+err.Error())
		return
	}
	if req == nil || req.DaemonID != daemonID || req.WorkspaceID != workspaceID {
		writeError(w, http.StatusNotFound, "request not found")
		return
	}
	writeJSON(w, http.StatusOK, req)
}
```

Register in `router.go`:

```go
r.Get("/api/host-health/{daemonId}/reap/{requestId}", h.GetHostReapRequest)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `(cd server && go test ./internal/handler/ -run TestGetHostReapRequest -count=1)`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/internal/handler/agent.go server/cmd/server/router.go server/internal/handler/host_reap_test.go
git commit -m "feat(reap): add host-reap result polling endpoint

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Server heartbeat claim wiring + daemon result-ingest endpoint

**Files:**
- Modify: the server HTTP heartbeat handler that builds `protocol.DaemonHeartbeatAckPayload` and sets `PendingModelList` (locate with `grep -rn "PendingModelList" server/internal/handler`) — add the `PendingReap` claim beside it
- Modify: `server/internal/handler/agent.go` — add `ReportHostReapResult`
- Modify: `server/cmd/server/router.go`
- Test: `server/internal/handler/host_reap_test.go` (extend)

**Interfaces:**
- Consumes: `HostReapStore.HasPending/PopPending/Complete/Fail`, `requireDaemonRuntimeAccess`.
- Produces:
  - Heartbeat ack now carries `PendingReap` when a host-reap request is pending for the heartbeating runtime.
  - `POST /api/daemon/runtimes/{id}/reap/{requestId}/result` accepting `{"status":"completed"|"failed","result":<script json>,"error":"..."}`, calling `Complete`/`Fail`, ignoring stale reports for terminal requests.

- [ ] **Step 1: Write the failing tests**

Extend `host_reap_test.go`:

```go
func TestHeartbeatClaimsHostReap(t *testing.T) {
	// Seed a pending reap row for rt1 in the store, drive one heartbeat for rt1
	// through the heartbeat handler, and assert the ack's PendingReap.ID matches
	// the row and PendingReap.Mode matches, and the row is now Running (popped).
}

func TestReportHostReapResultCompletes(t *testing.T) {
	// daemon posts status=completed + result → row Completed with result stored; 200.
}

func TestReportHostReapResultStaleIgnored(t *testing.T) {
	// row already Completed; a second report → 200 no-op, row unchanged.
}
```

Drive the heartbeat through whatever entrypoint existing heartbeat tests use (mirror the model-list heartbeat-claim test if one exists; `grep -rn "PendingModelList" server/internal/handler` will show the code path and its test).

- [ ] **Step 2: Run tests to verify they fail**

Run: `(cd server && go test ./internal/handler/ -run 'TestHeartbeatClaimsHostReap|TestReportHostReapResult' -count=1)`
Expected: FAIL — no `PendingReap` claim, `ReportHostReapResult` undefined.

- [ ] **Step 3: Implement**

At the located heartbeat ack-building site, beside the `PendingModelList` block, add (mirroring the `HasPending`-then-`PopPending` hot-path gating):

```go
if has, _ := h.HostReapStore.HasPending(ctx, runtimeID); has {
	if req, _ := h.HostReapStore.PopPending(ctx, runtimeID); req != nil {
		ack.PendingReap = &protocol.DaemonHeartbeatPendingReap{ID: req.ID, Mode: string(req.Mode)}
	}
}
```

Add `ReportHostReapResult` to `agent.go`, mirroring `ReportModelListResult` (`runtime_models.go:482-535`): gate with `requireDaemonRuntimeAccess`, load the request, ignore if already terminal, then `Complete`/`Fail`:

```go
func (h *Handler) ReportHostReapResult(w http.ResponseWriter, r *http.Request) {
	rt, ok := h.requireDaemonRuntimeAccess(w, r) // mirror the exact call model-list uses
	if !ok {
		return
	}
	requestID := chi.URLParam(r, "requestId")
	req, err := h.HostReapStore.Get(r.Context(), requestID)
	if err != nil || req == nil || req.RuntimeID != uuidToString(rt.ID) {
		writeError(w, http.StatusNotFound, "request not found")
		return
	}
	if req.Status == HostReapCompleted || req.Status == HostReapFailed || req.Status == HostReapTimeout {
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true}) // stale, ignore
		return
	}
	var body struct {
		Status string          `json:"status"`
		Result json.RawMessage `json:"result"`
		Error  string          `json:"error"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid body")
		return
	}
	if body.Status == "failed" {
		_ = h.HostReapStore.Fail(r.Context(), requestID, body.Error)
	} else {
		_ = h.HostReapStore.Complete(r.Context(), requestID, body.Result)
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
```

Register in `router.go` beside the model-list daemon result route:

```go
r.Post("/api/daemon/runtimes/{runtimeId}/reap/{requestId}/result", h.ReportHostReapResult)
```

Match the exact URL param names and daemon-auth middleware group the model-list result route uses.

- [ ] **Step 4: Run tests to verify they pass**

Run: `(cd server && go test ./internal/handler/ -run 'TestHeartbeatClaimsHostReap|TestReportHostReapResult' -count=1)`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/internal/handler/ server/cmd/server/router.go
git commit -m "feat(reap): claim host-reap on heartbeat and ingest daemon results

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: Daemon execution (run the script, report up)

**Files:**
- Modify: `server/internal/daemon/client.go` (alias block already done in Task 2) — add `ReportHostReapResult`
- Modify: `server/internal/daemon/daemon.go` — dispatch in `handleHeartbeatActions` (4564-4592); add `handleHostReap`
- Create: `server/internal/daemon/host_reap.go` (the exec + parse logic, so `daemon.go` stays focused)
- Test: `server/internal/daemon/host_reap_test.go`

**Interfaces:**
- Consumes: `resp.PendingReap *protocol.DaemonHeartbeatPendingReap` (Task 2), the `execenv` one-shot exec pattern (`execenv/git.go:92`), `Client.postJSON`.
- Produces:
  - `func (c *Client) ReportHostReapResult(ctx context.Context, runtimeID, requestID string, body map[string]any) error` — `POST /api/daemon/runtimes/%s/reap/%s/result`.
  - `func (d *Daemon) handleHostReap(ctx context.Context, rt Runtime, requestID, mode string)` — builds and runs the reaper command, parses stdout JSON, reports up.
  - `func reaperCommand(scriptPath, mode string) []string` — pure helper returning the argv: always `--json`; `--apply` only when `mode == "apply"`; never `--include-runtime`. This is the unit-tested seam.

- [ ] **Step 1: Write the failing test**

Create `server/internal/daemon/host_reap_test.go`:

```go
package daemon

import (
	"reflect"
	"testing"
)

func TestReaperCommandDryRun(t *testing.T) {
	got := reaperCommand("/opt/multica/scripts/multica-reap.sh", "dryrun")
	want := []string{"/opt/multica/scripts/multica-reap.sh", "--json"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("dryrun argv = %v, want %v", got, want)
	}
}

func TestReaperCommandApply(t *testing.T) {
	got := reaperCommand("/opt/multica/scripts/multica-reap.sh", "apply")
	want := []string{"/opt/multica/scripts/multica-reap.sh", "--json", "--apply"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("apply argv = %v, want %v", got, want)
	}
}

func TestReaperCommandNeverIncludesRuntime(t *testing.T) {
	for _, mode := range []string{"dryrun", "apply"} {
		for _, arg := range reaperCommand("s", mode) {
			if arg == "--include-runtime" {
				t.Fatalf("mode %q must never pass --include-runtime", mode)
			}
		}
	}
}
```

(Optionally add an exec-level test that points `handleHostReap` at a fake script printing fixed JSON and asserts the reported body; gate it so it uses a temp fake script path, never the real one, per the no-real-agent rule. Keep the pure `reaperCommand` test as the primary seam.)

- [ ] **Step 2: Run test to verify it fails**

Run: `(cd server && go test ./internal/daemon/ -run TestReaperCommand -count=1)`
Expected: FAIL — `reaperCommand` undefined.

- [ ] **Step 3: Implement**

Create `server/internal/daemon/host_reap.go`:

```go
package daemon

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
)

// reaperCommand builds the argv for the host reaper. Always JSON output;
// --apply only for the apply mode; never --include-runtime (leaked tooling
// only, per the UX-trigger design).
func reaperCommand(scriptPath, mode string) []string {
	argv := []string{scriptPath, "--json"}
	if mode == "apply" {
		argv = append(argv, "--apply")
	}
	return argv
}

func (d *Daemon) handleHostReap(ctx context.Context, rt Runtime, requestID, mode string) {
	scriptPath := d.reaperScriptPath() // resolve relative to the daemon checkout root
	argv := reaperCommand(scriptPath, mode)
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		_ = d.client.ReportHostReapResult(ctx, rt.ID(), requestID, map[string]any{
			"status": "failed",
			"error":  fmt.Sprintf("%s: %s", err, stderr.String()),
		})
		return
	}
	var result json.RawMessage = stdout.Bytes()
	if !json.Valid(result) {
		_ = d.client.ReportHostReapResult(ctx, rt.ID(), requestID, map[string]any{
			"status": "failed",
			"error":  "reaper produced invalid JSON",
		})
		return
	}
	_ = d.client.ReportHostReapResult(ctx, rt.ID(), requestID, map[string]any{
		"status": "completed",
		"result": result,
	})
}
```

Add `reaperScriptPath()` mirroring how the daemon resolves other bundled script/binary paths relative to its known checkout/install root (grep for how the daemon locates `scripts/` or its install dir; reuse it). Use the correct runtime-id accessor for `rt` (match the existing `handleModelList` call which passes `*rt` and uses `uuidToString(rt.ID)` server-side; here mirror the daemon-side accessor used by `reportModelListResult`).

Add `ReportHostReapResult` to `client.go` beside `ReportModelListResult`:

```go
// ReportHostReapResult sends the reaper result back to the server.
func (c *Client) ReportHostReapResult(ctx context.Context, runtimeID, requestID string, body map[string]any) error {
	return c.postJSON(ctx, fmt.Sprintf("/api/daemon/runtimes/%s/reap/%s/result", runtimeID, requestID), body, nil)
}
```

Dispatch in `handleHeartbeatActions` beside the `PendingModelList` block (daemon.go:4588):

```go
if resp.PendingReap != nil {
	go d.handleHostReap(ctx, *rt, resp.PendingReap.ID, resp.PendingReap.Mode)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `(cd server && go test ./internal/daemon/ -run TestReaperCommand -count=1)`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/internal/daemon/host_reap.go server/internal/daemon/host_reap_test.go server/internal/daemon/client.go server/internal/daemon/daemon.go
git commit -m "feat(reap): daemon runs the reaper and reports results

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: Core API client, zod schema, and query layer

**Files:**
- Modify: `packages/core/api/schemas.ts` (near `HostHealthSchema` 2028) — add `HostReapResultSchema`, `HostReapRequestSchema`, and a `MALFORMED_HOST_REAP_REQUEST` fallback
- Modify: `packages/core/api/client.ts` (near `getHostHealth` 2591; POST/GET siblings at 2501/2520) — add `initiateHostReap`, `getHostReapResult`
- Modify: `packages/core/types/agent.ts` (near `HostHealth` 231) — export `HostReapRequest`, `HostReapProcess` types
- Create: `packages/core/agents/host-reap.ts` — `resolveHostReap`, keys, `hostReapKeys` (mirror `packages/core/runtimes/models.ts`)
- Test: `packages/core/api/host-reap.test.ts` (malformed response); `packages/core/agents/host-reap.test.ts` (poll/timeout)

**Interfaces:**
- Consumes: `parseWithFallback`, existing fetch client.
- Produces:
  - `HostReapProcess = { pid: number; age_seconds: number; pcpu: string; reason: string; command: string }`
  - `HostReapResult = { mode: "dryrun"|"apply"; count: number; load_before: string; load_after: string|null; sigkilled: number|null; processes: HostReapProcess[] }`
  - `HostReapRequest = { id: string; status: "pending"|"running"|"completed"|"failed"|"timeout"; mode: "dryrun"|"apply"; result: HostReapResult|null; error?: string }`
  - `client.initiateHostReap(daemonId: string, mode: "dryrun"|"apply"): Promise<{ request_id: string }>`
  - `client.getHostReapResult(daemonId: string, requestId: string): Promise<HostReapRequest>`
  - `resolveHostReap(daemonId: string, mode: "dryrun"|"apply"): Promise<HostReapRequest>` — POST once then poll `getHostReapResult` on `POLL_INTERVAL_MS` until terminal or `POLL_TIMEOUT_MS`.

- [ ] **Step 1: Write the failing tests**

`packages/core/api/host-reap.test.ts` — malformed response yields the fallback, not a throw:

```ts
import { describe, expect, it } from "vitest";
import { HostReapRequestSchema, MALFORMED_HOST_REAP_REQUEST } from "./schemas";
import { parseWithFallback } from "./parse"; // match the actual import path used by other schema tests

describe("HostReapRequestSchema", () => {
  it("falls back on malformed payload", () => {
    const out = parseWithFallback(
      { garbage: true },
      HostReapRequestSchema,
      { ...MALFORMED_HOST_REAP_REQUEST, id: "r1" },
      { endpoint: "test" },
    );
    expect(out.id).toBe("r1");
    expect(out.status).toBe("failed");
  });

  it("parses a completed dry-run result", () => {
    const out = parseWithFallback(
      { id: "r1", status: "completed", mode: "dryrun", result: { mode: "dryrun", count: 0, load_before: "0 0 0", load_after: null, sigkilled: null, processes: [] } },
      HostReapRequestSchema,
      { ...MALFORMED_HOST_REAP_REQUEST, id: "r1" },
      { endpoint: "test" },
    );
    expect(out.result?.count).toBe(0);
  });
});
```

`packages/core/agents/host-reap.test.ts` — poll then resolve, and timeout. Mock `@multica/core/api` so `initiateHostReap` returns `{request_id:"r1"}` and `getHostReapResult` returns `pending` then `completed`; assert `resolveHostReap` returns the completed request. Add a case where it stays `pending` past the timeout and assert the returned status is `timeout` (mirror `resolveRuntimeModels`'s timeout handling in `packages/core/runtimes/models.ts`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @multica/core test -- host-reap`
Expected: FAIL — schemas/functions undefined.

- [ ] **Step 3: Implement**

Add the zod schemas to `schemas.ts` mirroring `HostHealthSchema` and the `RuntimeModelListRequestSchema`/`MALFORMED_*` pattern (tolerate unknown extra fields; default `load_after`/`sigkilled` to `null`; default `processes` to `[]`). Add the client methods to `client.ts` mirroring `initiateListModels`/`getListModelsResult` (`2501`/`2520`) but with paths `/api/host-health/${daemonId}/reap` (POST) and `/api/host-health/${daemonId}/reap/${requestId}` (GET), using `parseWithFallback` with `MALFORMED_HOST_REAP_REQUEST`. Create `packages/core/agents/host-reap.ts` mirroring `resolveRuntimeModels` + `runtimeModelsKeys` from `packages/core/runtimes/models.ts` (POST once, poll loop with `POLL_INTERVAL_MS`/`POLL_TIMEOUT_MS`, return terminal request; set status `timeout` on timeout). Export the types from `types/agent.ts`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @multica/core test -- host-reap`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/api/schemas.ts packages/core/api/client.ts packages/core/types/agent.ts packages/core/agents/host-reap.ts packages/core/api/host-reap.test.ts packages/core/agents/host-reap.test.ts
git commit -m "feat(reap): core client, schema, and polling for host reap

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 9: Views UI — `HostRow` action, confirm dialog, i18n

**Files:**
- Modify: `packages/views/agents/components/host-health-card.tsx` (`HostRow` 41-77; `HealthCard` 79)
- Create: `packages/views/agents/components/reap-dialog.tsx` — the preview→confirm dialog
- Modify: `packages/views/locales/en/agents.json` (near 993-997) and `packages/views/locales/zh/agents.json`
- Test: `packages/views/agents/components/reap-dialog.test.tsx`; extend `host-health-card` tests for role gating

**Interfaces:**
- Consumes: `resolveHostReap` / client methods (Task 8), `host.daemon_id` (already on `HostRow`'s `host` prop), the role-derivation pattern from `packages/views/settings/components/workspace-tab.tsx:69-70,78-81,145-153` (`useAuthStore((s)=>s.user)` from `@multica/core/auth`, `useCurrentWorkspace()` from `@multica/core/paths`, `memberListOptions` from `@multica/core/workspace/queries`), Button/Dialog primitives per `packages/ui/docs/{button,dialog}.md`.
- Produces: a role-gated "Reap leaked processes" action on amber/red host rows that opens `<ReapDialog daemonId=... onClose=... />`.

- [ ] **Step 1: Write the failing tests**

`packages/views/agents/components/reap-dialog.test.tsx` (mock `@multica/core/api`):

```tsx
// - On open, fires a dry-run preview and renders the returned process list + count.
// - Clicking Confirm fires apply (mode "apply"), shows pending, then the result toast text.
// - A preview timeout shows the "daemon did not respond" state and no kill happened.
```

Extend `host-health-card` tests:

```tsx
// - Amber/red row + admin/owner member → the reap action renders.
// - Amber/red row + plain member → the action does NOT render.
// - Green row → the action does NOT render regardless of role.
```

Mock stores with the Zustand callable-plus-`getState` shape; mock the members query so the current user's role is controllable; do not mock `next/*` or `react-router-dom`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @multica/views test -- reap-dialog host-health-card`
Expected: FAIL — component/action not implemented.

- [ ] **Step 3: Implement**

In `host-health-card.tsx`, compute `canManageWorkspace` with the workspace-tab pattern (find `currentMember` in the members query, role `owner`/`admin`), gate behind the member query having settled to avoid a flash. When `deriveHostStatus(host)` is `amber` or `red` AND `canManageWorkspace`, render a Button ("Reap leaked processes") that opens `ReapDialog` with `host.daemon_id`. Build `reap-dialog.tsx` per `packages/ui/docs/dialog.md`: on open call `resolveHostReap(daemonId, "dryrun")`, show loading, then render the process table (pid, age, %cpu, reason, full command with overflow handling per the Web/Desktop UI rules), the count, and a one-line note that apply re-selects fresh. A Confirm button (Button contract) calls `resolveHostReap(daemonId, "apply")` with visible pending state, then closes and toasts `reaped N (M needed SIGKILL)` plus load before/after from the result. Handle timeout/offline with a retry and a clear "no processes were killed" message on preview timeout. Pull all strings from i18n.

- [ ] **Step 4: Add i18n copy**

In `packages/views/locales/en/agents.json` near the `hostHealth` block (993-997) add keys for: action label, dialog title, column headers (pid/age/cpu/reason/command), count summary, the re-select note, confirm button, success toast (with `{count}`/`{sigkilled}`/`{loadBefore}`/`{loadAfter}` placeholders), pending label, and the timeout/offline state. Add the corresponding `zh` translations per the conventions pages. State each fact once beside its control; do not restate labels in help text.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @multica/views test -- reap-dialog host-health-card`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/views/agents/components/host-health-card.tsx packages/views/agents/components/reap-dialog.tsx packages/views/agents/components/reap-dialog.test.tsx packages/views/locales/en/agents.json packages/views/locales/zh/agents.json
git commit -m "feat(reap): admin trigger and confirm dialog on the host card

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Final verification (after all tasks)

- [ ] `pnpm typecheck && pnpm lint && pnpm test` (frontend excluding mobile)
- [ ] `(cd server && make test)` or `go test ./...` for the touched packages
- [ ] `scripts/multica-reap.test.sh`
- [ ] Manual smoke against a running environment (`make up`): amber/red card shows the action for an admin, preview lists processes, apply toasts the result, member sees no action.

## Implementation notes log

During implementation of this plan, maintain a running `docs/superpowers/specs/2026-09-22-reaper-ux-trigger-implementation-notes.md` file alongside the spec.
Update it incrementally, not at the end, every time you:

- Make a decision that wasn't in the spec.
- Change something the spec specified differently.
- Hit a tradeoff and pick a side.
- Notice anything else the reviewer should know before reading the diff.

Each entry: short heading, 1-3 sentences, timestamp optional.
The file is for the human reviewing the PR, not a design doc.
Be terse and concrete.
