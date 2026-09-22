# Design: trigger the host-pressure reaper from the Active board

Date: 2026-09-22.
Branch: `chill-python`.
Status: approved design, pre-implementation.

## Problem

The Active board shows a Host health card.
When a host is under load it shows an amber "Under pressure" badge (red "Saturated" when worse).
Separately, `scripts/multica-reap.sh` kills leaked agent child processes (hung vitest/esbuild/tsc, stale MCP servers, workspace embedded postgres) that pin CPU and exhaust swap.
The two are not connected today.
An operator must SSH to the host and run the script by hand.

This design wires a preview-then-confirm trigger onto the "Under pressure" card so an admin or owner can run the reaper from the UI.

## Locked requirements (decided before this design, not re-litigated)

1. Preview then confirm.
   The first action runs the reaper in dry-run and shows what would be killed (structured process list plus count).
   The operator reviews, then confirms a second action to actually apply (SIGTERM, then SIGKILL after a grace period).
2. Admins and owners only for the apply step.
3. Leaked tooling only.
   Mirror the script's safe default: 30-minute age gate, no `--include-runtime`.
   Do not expose a runtime opt-in in this iteration.

## Decisions made during brainstorming

1. Execution path: the daemon shells out to `multica-reap.sh` with a new additive `--json` mode (approach A1), rather than porting the kill logic to Go (A2).
   The script is the tested source of truth for what gets killed.
   A single implementation of destructive selection logic outweighs the cleanliness of a native port.
2. Preview to apply consistency: apply re-selects fresh on the host rather than acting on the exact previewed PIDs.
   This matches the script's own behavior and is safe against PID reuse.
3. Gating: both the preview and the apply steps require owner or admin.
   The process list includes full untruncated command lines that can leak workspace and repo paths, so members do not see it.
4. Transport: reuse the existing runtime-keyed `model_list` request/response machinery, resolving `daemon_id` to a live runtime server-side (approach T1), rather than building daemon-level addressing (T2).

## Architecture finding that shapes the transport

Host health rides per-runtime heartbeat frames keyed by `RuntimeID` (`server/internal/daemon/wakeup.go:316,320-322`).
There is no `byDaemon` index in the hub (only `byRuntime`, `byWorkspace`, `byUser` at `server/internal/daemonws/hub.go:334-336`) and no server-initiated request/response channel to a daemon.
A daemon with zero live runtimes reports no host health at all, and a plain daemon-token WebSocket with no runtimes is rejected on upgrade (`server/internal/daemonws/hub.go:429-433`).

This constraint dissolves rather than blocks the feature.
The reaper trigger lives on the host-health card, and a host only appears on that card because it is reporting health, which requires at least one live runtime.
So at the moment an admin sees "Under pressure" and clicks, that daemon provably has at least one live runtime and an open socket.
The reaper can therefore reuse the runtime-keyed machinery: the server resolves the `daemon_id` the client already holds to a live runtime of that daemon and routes the request through the existing pending-work hint, HTTP-heartbeat claim, and HTTP-POST-result path.

### Accepted limitation

A fully-wedged host with zero live runtimes does not appear on the host-health card, so the UX trigger cannot reach it.
That host still requires a manual SSH invocation of the script.
This is an accepted boundary for this iteration, not a defect.

## Reference implementation to mirror: `model_list`

The `model_list` round-trip is the proven pattern for "client asks the server for something only the host daemon can produce, and receives the result asynchronously".
Hop by hop:

- Client POSTs to enqueue: `packages/core/api/client.ts:2501` `initiateListModels()`.
- Client polls a GET result endpoint inside one react-query `queryFn` loop until a terminal status: `packages/core/runtimes/models.ts:68` `resolveRuntimeModels()` (loop at lines 78-84, timeout at `POLL_TIMEOUT_MS`).
  There is no WebSocket push for the result; the client discovers it by polling.
- Server enqueues into a DB-backed store and sends a lossy hint down: `server/internal/handler/runtime_models.go:346` `InitiateListModels`, then `requestDaemonPendingWork(...)` at line 389.
- Hint routes by `runtimeID`: `server/internal/daemonws/hub.go:483` `NotifyPendingWork`.
- Daemon claims via an immediate HTTP heartbeat whose response carries the work: `server/internal/daemon/daemon.go:4564` `handleHeartbeatActions`, `if resp.PendingModelList != nil` at 4588-4592.
- Daemon executes on the host and POSTs the result up: `server/internal/daemon/client.go:697` `ReportModelListResult` to `POST /api/daemon/runtimes/{id}/models/{requestId}/result`.
- Server ingests and stores the terminal result: `server/internal/handler/runtime_models.go:482` `ReportModelListResult`; the client's next poll sees it.

The reaper mirrors this shape end to end.

## Design

### 1. Script: additive `--json` mode

Add a `--json` flag to `scripts/multica-reap.sh`.
When set, the script emits a single JSON document to stdout instead of the fixed-width text table, for both dry-run and apply.

Shape:

```json
{
  "mode": "dryrun",
  "min_age_minutes": 30,
  "include_runtime": false,
  "count": 2,
  "load_before": "1.80 1.62 1.44",
  "load_after": "0.40 0.98 1.20",
  "sigkilled": 1,
  "processes": [
    {
      "pid": 12345,
      "age_seconds": 5400,
      "pcpu": "98.5",
      "reason": "workspace verification tooling",
      "command": "node .../vitest ... (full untruncated)"
    }
  ]
}
```

Rules:

- `load_after` and `sigkilled` are present only for apply; omitted (or null) for dry-run.
- `command` is the full untruncated args string.
  The existing text path truncates to 90 characters via `%.90s`; the JSON path must not truncate.
- The existing text output remains the default when `--json` is absent.
  `scripts/multica-reap.test.sh` continues to exercise the text path unchanged.
- JSON is emitted with a small dependency-free helper (bash string building with proper escaping, or `jq` only if already required on the host; prefer no new dependency).
- The empty-result case still emits valid JSON (`"count": 0`, `"processes": []`), not the prose "no leaked processes" line.

### 2. Protocol and store

- New DB-backed `ReapRequestStore` mirroring `ModelListStore`.
  A request row: `{id, daemon_id, workspace_id, mode (dryrun|apply), status (pending|completed|failed), result_json (nullable), error (nullable), requested_by, created_at, updated_at}`.
  Follow the migration rules in AGENTS.md: no foreign keys, `CREATE INDEX CONCURRENTLY` in its own single-statement migration for any new index.
- New advisory pending-work kind `PendingWorkKindHostReap = "host_reap"` in `server/pkg/protocol/messages.go`.
  It only prompts an immediate heartbeat; the daemon reacts identically to every kind, so it stays safe to lose or duplicate.
- New field `PendingReap *PendingReapRequest` on the HTTP heartbeat response payload, carrying `{ID string, Mode string}`.
  Dispatched in `handleHeartbeatActions` alongside `PendingModelList`.

### 3. Server endpoints

Client-facing (both gated with `requireWorkspaceRole(w, r, workspaceID, "workspace not found", "owner", "admin")` and a check that `daemonId` appears in this workspace's `WorkspaceHostHealth`, so a caller cannot target an arbitrary daemon):

- `POST /api/host-health/{daemonId}/reap`
  Body `{mode: "dryrun" | "apply"}`.
  Resolves `daemonId` to a live runtime of that daemon via the hub, creates a `ReapRequestStore` row (status `pending`), sends the `host_reap` pending-work hint to that runtime, and returns `{requestId}`.
- `GET /api/host-health/{daemonId}/reap/{requestId}`
  Returns `{status, result}` where `result` is the parsed script JSON once terminal.
  This is the endpoint the client polls.

Daemon-facing:

- `POST /api/daemon/runtimes/{id}/reap/{requestId}/result`
  Gated with `requireDaemonRuntimeAccess`.
  Accepts the structured script result, marks the store row `completed` (or `failed`), and ignores stale reports for already-terminal requests (mirror `ReportModelListResult` at `runtime_models.go:503`).

The `daemonId` in the client-facing routes is a pure UUID request input, parsed with `parseUUIDOrBadRequest`.
The runtime id resolved server-side is used only for hint routing and heartbeat attribution; the reaper operation itself is host-wide and does not depend on which runtime carried it.

### 4. Daemon execution

When a heartbeat response carries `PendingReap`, the daemon:

- Runs `scripts/multica-reap.sh --json` for `dryrun`, or `scripts/multica-reap.sh --json --apply` for `apply`, through the `execenv` exec path (`server/internal/daemon/execenv/isolation.go`).
  Tooling-only, 30-minute gate, no `--include-runtime`.
- Parses the script's stdout JSON and POSTs it to the daemon result endpoint.
- On non-zero exit or unparseable output, reports `failed` with the captured stderr.

The script path is resolved relative to the daemon's known checkout root, consistent with how other host-side scripts and binaries are located.

### 5. API schema and compatibility

- Add a zod schema for the reap result in the core API schema module (`packages/core/api/schemas.ts`, alongside `HostHealthSchema`), consumed via `parseWithFallback`, not an `as T` cast.
  Provide defaults for optional fields (`load_after`, `sigkilled`) and tolerate unknown extra fields.
- Add a malformed-response test for the new schema.

### 6. Client query layer

- `packages/core/api/client.ts`: `initiateHostReap(daemonId, mode)` (POST) and `getHostReapResult(daemonId, requestId)` (GET).
- A `resolveHostReap(daemonId, mode)` state machine mirroring `resolveRuntimeModels` (`packages/core/runtimes/models.ts:68`): POST once, then poll the GET endpoint on a fixed interval until terminal or timeout.
- A mutation hook that the dialog calls for preview and again for apply, exposing pending, result, and timeout/offline states.

### 7. UI on `HostRow`

- In `packages/views/agents/components/host-health-card.tsx`, when `deriveHostStatus` returns amber or red, render a "Reap leaked processes" action on the row.
  The action is visible only to owners and admins (read the caller's workspace role from the existing role source used elsewhere in views).
- The action opens a dialog (follow `packages/ui/docs/dialog.md` and `packages/ui/docs/button.md`):
  - On open, fire the preview (dry-run) and show a loading state.
  - Render the process list: pid, age, %cpu, reason, full command (with deliberate overflow handling for long commands, per the Web/Desktop UI rules).
  - Show the count and a one-line explanation that apply re-selects fresh, so the final set may differ if the host changes.
  - A confirm button fires apply with a visible pending state, then closes and toasts the result: `reaped N (M needed SIGKILL)`, plus load before and after.
  - If either request times out, show a "daemon did not respond" state with a retry, and make clear no processes were killed on a preview timeout.
- `HostRow` already receives the whole `host` record and thus `host.daemon_id` (`host-health-card.tsx:41,99`); no new identifier needs to be surfaced to the client.

### 8. i18n

Add copy under `packages/views/locales/en/agents.json` near the existing host-health keys (`993-997`) for the action label, dialog title, column headers, confirm button, the re-select note, the result toast, and the timeout state.
Provide the Chinese translations per the conventions pages.
Follow the UI copy rules: state each fact once beside its control, keep the destructive consequence visible, do not restate labels in a description.

## Error handling

- Daemon offline or the resolved runtime disconnects between hint and heartbeat: the request stays `pending`; the client poll hits its timeout and shows the offline state.
  No partial kill occurs because apply only runs when the daemon claims and executes.
- Script exits non-zero or emits unparseable JSON: the daemon reports `failed` with stderr; the dialog surfaces the error.
- Stale result for a terminal request: ignored server-side, mirroring `model_list`.
- Caller lacks owner/admin, or targets a daemon not in the workspace: rejected at the endpoint gate before any enqueue.

## Testing

- `scripts/multica-reap.test.sh`: add `--json` assertions for dry-run and apply against the fixture `ps` (schema shape, full untruncated command, empty-result JSON, `load_after`/`sigkilled` only on apply).
  The existing text-path assertions stay unchanged.
- Go handler tests (`server/internal/testutil`, `testutil.Call(...).Want(...).JSON(...)`): the owner/admin gate, rejection of a daemon not in the workspace, store lifecycle (pending to completed and to failed), and stale-result ignore.
  Use a fake or missing executable path per the AGENTS.md no-real-agent rule; do not resolve or run the real script.
- Go daemon dispatch test: a heartbeat response carrying `PendingReap` triggers the exec with the correct flags (`--json`, plus `--apply` only for apply mode, never `--include-runtime`), using a fake script path.
- Views tests: `HostRow` action gating by role, dialog preview-to-confirm wiring, poll and timeout states.
  Mock the API at `@multica/core/api`; do not mock `next/*` or `react-router-dom`.
- Malformed-response test for the reap result schema via `parseWithFallback`.

## Out of scope

- Killing hung agent runtimes (`--include-runtime`).
- Reaching hosts with zero live runtimes from the UI.
- Sharing selection logic between the script and Go (the phase-2 convergence note in `docs/superpowers/specs/2026-09-21-multica-server-health-design.md`).
- Any daemon-level addressing (`byDaemon` index) or server-initiated daemon RPC.

## Implementation notes log

During implementation of this spec, maintain a running `docs/superpowers/specs/2026-09-22-reaper-ux-trigger-implementation-notes.md` file alongside the spec.
Update it incrementally, not at the end, every time you:

- Make a decision that wasn't in the spec.
- Change something the spec specified differently.
- Hit a tradeoff and pick a side.
- Notice anything else the reviewer should know before reading the diff.

Each entry: short heading, 1-3 sentences, timestamp optional.
The file is for the human reviewing the PR, not a design doc.
Be terse and concrete.
