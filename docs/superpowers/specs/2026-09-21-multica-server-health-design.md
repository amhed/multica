# Multica server-health surface — design

## Revision note (2026-09-21)

The first draft of this spec assumed the agent-task-snapshot response was a wrapper object, that a per-daemon in-memory record existed to stash host data, and that a process-tree walker existed to reuse.
Grounding in the code showed all three are false: the snapshot response is a bare JSON array (`server/internal/handler/agent.go:3006`), there is no per-daemon record (only `RuntimeLease` + a Redis TTL), and there is no process enumeration anywhere in the daemon.
This revision reflects the corrected, leaner design that was chosen: a **separate** `/api/host-health` endpoint (no breaking change to the snapshot wire shape), a small addition to backend per-runtime state, and **`/proc`-based load/mem/swap only in phase 1**, with the stale-process count/list deferred to phase 2.

## Problem

Agents on a self-hosted Multica droplet froze: the Active board showed `0 running · 5 queued` while the host sat at load 65 on 8 cores with swap fully exhausted.
The cause was leaked agent child processes that pinned every core, so the daemon could not schedule queued runs.
Nothing in the Multica UX showed host pressure, so the only way to notice was to SSH in and read `uptime`.
This feature makes host saturation visible inside the product.

The remediation tool (`scripts/multica-reap.sh`, shipped separately) is out of scope; phase 2 below shares its 30-minute default age threshold.

## Goals

- Surface host CPU load, memory, and swap pressure for the daemon host(s) serving a workspace, live, in the Active view (phase 1).
- Surface a count of stale workspace processes with an expandable list of the worst offenders (phase 2).
- Reuse the existing daemon → backend → UI transport; add no new listener and no database table.
- Never change the shape of an existing API response (AGENTS.md API compatibility); new data rides a new endpoint.
- Degrade cleanly when a daemon does not report health (older daemon, non-Linux host).

## Non-goals

- No historical time-series, charts, or alerting; current-state indicator only.
- No remote kill/reap from the UI; remediation stays on the host.
- No change to the agent-task-snapshot response shape.

## Architecture

The daemon is the only component that can see host pressure (it runs on the host, outside the container) and it already holds a WebSocket channel to the backend via the per-runtime heartbeat.
The backend already fans workspace-scoped data to the UI; the Active board already renders a header and grid we can pin a card above.

```
daemon (host)                         backend                         web/desktop
  hosthealth.Collect() ──┐
  /proc/loadavg          ├─▶ heartbeat{host} ─▶ Hub: store host on    GET /api/host-health
  /proc/meminfo          │   (once per host,     runtime connection ─▶  (new endpoint) ─────▶ useQuery(hostHealthOptions)
  runtime.NumCPU()      ─┘    not per runtime)    state                                        └─▶ Health card (Active board)
```

Host health is live telemetry attached to existing per-runtime connection state; nothing is persisted to the database.

## Phasing

- **Phase 1 (this build):** load / memory / swap end to end, via a new `/api/host-health` endpoint and a Health card. No process enumeration.
- **Phase 2 (fast-follow):** add `stale_procs` + `top[]` to the same `host` payload and card, built on a new `/proc` process walker in the daemon that shares selection logic with `scripts/multica-reap.sh`. Tracked separately; not built here.

## Component design (phase 1)

### Daemon (`server/internal/daemon/`)

- New self-contained collector `hosthealth.go`: `Collect() (*HostHealth, bool)` reads `/proc/loadavg` (load1/5/15) and `/proc/meminfo` (mem total/available, swap total/free), and `runtime.NumCPU()`. On a non-Linux host or unreadable `/proc`, returns `ok=false` and the heartbeat omits the block.
- Extend `protocol.DaemonHeartbeatRequestPayload` (`server/pkg/protocol/messages.go:390`) with `Host *DaemonHost \`json:"host,omitempty"\``, and mirror it on the HTTP `DaemonHeartbeatRequest` (`server/internal/handler/daemon.go:1023`) so both transports match.
- Populate it at the WS send site (`server/internal/daemon/wakeup.go:311`). The heartbeat loops per runtime, but host metrics are machine-wide, so `Collect()` runs once per heartbeat tick and the same block is attached to each runtime's frame (the backend dedupes by storing per connection; identical values are idempotent). Collection is two small file reads on a 15s tick.

### Backend (`server/internal/daemonws/` + `server/internal/handler/`)

- Widen `HeartbeatHandler` (`daemonws/hub.go:288`) to receive the whole `DaemonHeartbeatRequestPayload` (or an added `host` parameter) instead of just `runtimeID, supportsBatchImport`; update the WS receipt (`hub.go:1068`) and the handler impl (`handler/daemon.go` `processHeartbeat`).
- Store the latest `host` block on the connection's `RuntimeLease` (`daemonws/hub.go:47`) under its mutex, with a `SetHost`/`Host` accessor; add a Hub method `WorkspaceHostHealth(workspaceID) []HostHealthEntry` that enumerates the workspace's connected runtimes and returns their stored host blocks (deduped by host/device).
- New endpoint `GET /api/host-health` (workspace-scoped, auth'd, registered next to the snapshot route in `server/cmd/server/router.go`): resolves workspace + member, calls `h.DaemonHub.WorkspaceHostHealth(...)`, returns `{ hosts: [...] }`. New response type, so no existing contract changes.

### Core (`packages/core/`)

- New `HostHealthSchema` + `HostHealthResponseSchema` in `packages/core/api/schemas.ts` (`{ hosts: HostHealthSchema[] }`, each host `.loose()`), and a client method `getHostHealth()` in `client.ts` using `parseWithFallback` with fallback `{ hosts: [] }` (mirroring `getWorkspaceAgentActivity30d`).
- New query `hostHealthOptions(wsId)` in `packages/core/agents/queries.ts`: workspace-scoped key including `wsId`, `refetchInterval: 15s` (its own cadence, since it does not ride the snapshot's WS invalidation), `staleTime: 10s`.
- `deriveHostStatus(host)` helper (sibling to `active-board.ts`) mapping a host to `green | amber | red` per the thresholds below, unit-tested in one place.

### Views (`packages/views/agents/`)

- New `HealthCard` component, pinned below `CollectionPageHeader` and above the scroll region in `active-board-page.tsx` (which reads it via its own `useQuery(hostHealthOptions(wsId))`; the component takes no new props, matching the page's hook-driven style).
- Compact state: overall `green | amber | red`, load-vs-cores, memory and swap pressure. Empty `hosts` → muted "host metrics unavailable", never an error. One row per host (one on the single-tenant droplets).
- The expandable process detail is phase 2; phase 1 renders the metrics only.

## Data contract (phase 1)

Heartbeat `host` block and each `/api/host-health` `hosts[]` entry:

```
host {
  daemon_id: string        // hosts[] entry only (runtime/device id)
  device_name: string      // hosts[] entry only
  ncpu: number
  load1: number
  load5: number
  load15: number
  mem_total_kb: number
  mem_available_kb: number
  swap_total_kb: number
  swap_free_kb: number
  // phase 2 adds: stale_procs: number, top: [{pid, age_s, pcpu, workspace, cmd}]
}
```

## Thresholds (`deriveHostStatus`)

Overall status is the worst of the signals; `load15` drives the headline so a brief spike does not flip it red (`load1` shown in detail).

| Signal | green | amber | red |
| --- | --- | --- | --- |
| load15 ÷ ncpu | < 0.7 | 0.7–1.0 | > 1.0 |
| swap used (1 − free/total) | < 25% | 25–75% | > 75% |

## API compatibility and fork isolation

- No existing response shape changes; `/api/host-health` is a new endpoint and `host` is a new optional field on the heartbeat.
- Older daemon + new backend → empty `hosts[]` → "unavailable" card. New daemon + old backend → the extra heartbeat field is ignored. No version coupling.
- The daemon collector is its own file; the widened `HeartbeatHandler` is the one intrusive change and is additive.

## Testing

- Daemon: unit-test the `/proc` parsers over fixture files (`hosthealth_test.go`), including malformed input → `ok=false`.
- Backend: a heartbeat carrying `host` makes `WorkspaceHostHealth` return it; a heartbeat without `host` leaves it empty; `/api/host-health` returns `{hosts:[...]}` for a member and 403/empty appropriately (`testutil.Call`).
- Core: schema parses a response with and without `hosts`; `deriveHostStatus` covers each green/amber/red boundary including the load-65 / swap-100% incident values.
- Views: `HealthCard` component test for each status and the missing-data state (views testing rules: no `next/*` mock; stores mocked with their Zustand callable shape; API mocked at `@multica/core/api`).

## Rollout and verification (tinydevs)

- Backend change ships via the container deploy; the daemon change needs the host `multica` binary rebuilt, reinstalled to `/usr/local/bin/multica`, and `systemctl restart multica-daemon.service`.
- Verify: the Health card reads green under normal load; a short synthetic load burst flips it amber/red; `/api/host-health` returns a populated `hosts[]`.

## Implementation notes log

During implementation of this spec, maintain a running `docs/superpowers/specs/2026-09-21-multica-server-health-implementation-notes.md` file alongside the spec.
Update it incrementally — not at the end — every time you:

- Make a decision that wasn't in the spec
- Change something the spec specified differently
- Hit a tradeoff and pick a side
- Notice anything else the reviewer should know before reading the diff

Each entry: short heading, 1-3 sentences, timestamp optional.
The file is for the human reviewing the PR, not a design doc — be terse and concrete.
