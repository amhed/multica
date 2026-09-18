# Upgrading this fork to upstream v0.5.0

The integration merges upstream commit `2df765a3c8f39789c9fb76316378bcffc20d22d9`
(v0.5.0, September 18, 2026) into the fork's September 17 main branch.

## Fork integration

- Parent/child inbox grouping works with upstream's paginated archive, including
  parent context on every page and deep-link lookup, collapse state, keyboard
  navigation, and realtime ancestor updates.
- Command-palette Todo, In Progress, In Review, and Blocked actions retain their
  concrete built-in status keys. The four lifecycle categories cannot distinguish
  these actions. Done/Cancelled can still resolve to custom terminal statuses.
- French translations cover the fork's active-agent board, status/assignment
  commands, inbox hierarchy, deploy/quota sidebar, and subscription pricing.
- Active-agent summaries, subscription cost controls, deploy/quota indicators,
  voice support, and the separate Carropana/SeguroHQ mobile build settings remain.

## Database upgrade

Upstream uses migration 468, which collided with the fork's task-summary
migration. The fork migration is now `500_pstack_agent_task_summary` and retains
`ADD COLUMN IF NOT EXISTS`. The runner records the full migration name, so an
existing `468_pstack_agent_task_summary` ledger row does not suppress upstream's
`468_drop_reference_only_column`. Existing summary values survive migration 500;
new databases create the column there. Leave historical ledger rows intact.

Regenerate database bindings with `make sqlc`. Before deployment, back up the
target database and run the merged migrations with the matching release runner.
Status categories are backfilled to `unstarted`, `started`, `done`, and `closed`.
Custom statuses retain lifecycle meaning but no longer inherit built-in
automation behavior. Use the built-in In Review status for autopilot completion.
See [maintenance jobs](maintenance-jobs.md) for large, staged deployments.

Rolling back migration 500 drops the summary column, including pre-existing
values; do not use schema rollback as a routine way to switch app versions.

## Deployment settings

- Upstream enables anonymous daily self-host telemetry. To disable it, set
  `DO_NOT_TRACK=1` on the backend and restart it. `ANALYTICS_DISABLED` is separate.
- OpenCode runtimes require OpenCode 1.1.54 or newer.
- Active UI sessions renew automatically; review the existing `AUTH_TOKEN_TTL`
  setting if the deployment depends on a fixed sign-in expiration.

This integration changes source and tests. Production deployment and native
mobile releases are separate operations.
