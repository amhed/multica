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
