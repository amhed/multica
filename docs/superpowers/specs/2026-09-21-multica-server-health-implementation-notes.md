# Server-health — implementation notes

Terse notes for the PR reviewer; see the design spec for the plan.

## Backend storage: on the client, not via a widened HeartbeatHandler
The spec left the choice open between widening `HeartbeatHandler` and storing on connection state.
Chose the latter: the `host` block is stored on the `*client` in `handleHeartbeatFrame` (hub.go), so no handler signature changed across the HTTP/WS paths. `Hub.WorkspaceHostHealth` reads it back by iterating `byWorkspace`. Less invasive, keeps host state where its connection lifecycle already lives.

## device_name = daemon_id
`ClientIdentity` has `DaemonID` but no separate human device name, so the endpoint fills `device_name` with the daemon id. If a friendlier name is wanted later it can come from the runtime row; not worth a lookup for phase 1.

## Endpoint returns `{hosts: []}` never null
`GetWorkspaceHostHealth` initializes the slice so JSON is `[]`, matching the zod default and keeping the UI parse trivial.

## Heartbeat host block only overwrites when present
`handleHeartbeatFrame` sets the client host only when `payload.Host != nil`, so a transient beat without metrics (or an older daemon) does not wipe the last-known value.

## i18n added to all five locales
`active_board.host.*` added to en/zh-Hans/ja/ko/fr. `resources-types.ts` derives types from `typeof en/agents.json`, so no typegen step. CJK/fr strings are best-effort technical terms.

## HealthCard placement
Rendered as the first child inside the board's scroll region (with `mb-4`) rather than a truly fixed element above it — simpler than restructuring the flex column, still reads as the pinned top-of-board card. It uses its own `useQuery(hostHealthOptions)` and takes only `wsId`.

## Phase 1 scope
Load/memory/swap only. No `/proc` process walker, no `stale_procs`/`top[]`. The schema is `.loose()` and the contract has a documented slot so phase 2 adds fields without a breaking change.

## Phase 2a: saturation signals replace load15 as the status driver (2026-09-29)
On moni-hermes the card read "16.22 / 4" (red) five minutes after a daemon restart while the CPU was 98% idle and nothing was paging: load15 lags by ~15 minutes and counts processes waiting on disk, and swap occupancy stays high long after pressure ends.
The daemon now keeps its previous `/proc/stat` and `/proc/vmstat` counters (`hostsampler.go`) and reports CPU busy %, swap in/out KB/s, blocked processes, and its own cgroup's memory against the tightest of `memory.high`/`memory.max`.

## Status thresholds with rates
Swap-in > 1 MB/s amber, > 10 MB/s red; daemon cgroup memory >= 80% of its limit amber, > 95% red; CPU >= 90% amber only (a busy build is not a fault).
Daemons without rates (older builds, or a daemon's first sample) keep the load15 + swap-used rule, so there is no version coupling.

## Rates are nil on the first sample and cached within 1s
A rate needs two samples, so the first beat after start carries none (and the card falls back to the legacy rule for one tick). Concurrent heartbeat connections within a second reuse the previous sample instead of computing a rate over a near-zero window.

## Containerized daemons see only their own cgroup
With a private cgroup namespace (rootless podman on moni-hermes) the daemon sees the container's `memory.max` (18 GiB) but not a tighter `MemoryHigh` set on the parent systemd unit (15 GiB). The card shows what the daemon can see; aligning the container limit with the unit limit is a deploy-side fix.

## Phase 2b: per-task process breakdown instead of a flat top[] list (2026-09-29)
The spec sketched `stale_procs` + `top[{pid, age_s, pcpu, workspace, cmd}]`. What an operator needed during the PAI-322 thrash was "which issue is eating the box", so the host block carries `tasks[]` (one row per running task: issue key, agent, process count, RSS, CPU share, largest command) plus a single `stale` aggregate. Pids are not sent; the reaper already owns per-process selection.

## Attribution is by working directory
A process belongs to the running task whose env root contains its cwd (path-segment match), which also catches detached children that a process-tree walk from the agent pid would lose. A process that chdirs outside its task dir is missed. Orphans under the workspaces root are "stale" at the reaper's 30-minute default age.

## CPU share is ticks over machine ticks
Per-process utime+stime deltas are divided by the `/proc/stat` total delta, so CPU is a share of the whole machine and needs no CLK_TCK. Start times still use USER_HZ=100, a fixed kernel ABI constant. RSS is summed per group, so shared pages count once per process.

## Command lines are reduced, never sent raw
`sanitizeCmdline` keeps the executable (and an interpreter's script) base name plus up to four distinct flags and short lowercase words; flag values (`--token=x`, `-pSecret`), paths, ids and prompts are dropped.

## Tasks are filtered to the requesting workspace in the hub
A daemon can serve several workspaces and reports every running task. `Hub.WorkspaceHostHealth` narrows `tasks` to the requested workspace on a copy of the stored snapshot. The `stale` aggregate stays host-wide, like the reaper preview.
