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
  and the separate Carropana/SeguroHQ mobile build settings remain.
- For native voice availability, see the [mobile README](../apps/mobile/README.md#voice-support).

## Database upgrade

Upstream uses migration 468, which collided with the fork's task-summary
migration. The fork migration is now `500_pstack_agent_task_summary` and retains
`ADD COLUMN IF NOT EXISTS`. The runner records the full migration name, so an
existing `468_pstack_agent_task_summary` ledger row does not suppress upstream's
`468_drop_reference_only_column`. Existing summary values survive migration 500;
new databases create the column there. Leave historical ledger rows intact.

Regenerate database bindings with `make sqlc`. Before deployment, back up the
target database and run the merged migrations with the matching release runner.
For status migration and compatibility constraints, see the
[lifecycle rollout](issue-status-lifecycle-rollout.md).
See [maintenance jobs](maintenance-jobs.md) for large, staged deployments.

Rolling back migration 500 drops the summary column, including pre-existing
values; do not use schema rollback as a routine way to switch app versions.

## Deployment settings

- Review the [self-host telemetry policy and opt-out](../SELF_HOSTING.md#anonymous-deployment-telemetry).
- OpenCode runtimes require OpenCode 1.1.54 or newer.
- Review [session lifetime](../apps/docs/content/docs/auth-setup.mdx#session-lifetime)
  if the deployment depends on a fixed sign-in expiration.

This integration changes source and tests. Production deployment and native
mobile releases are separate operations.

## Validation after native voice removal

- Frontend: all 8,388 tests across 701 files passed after generating web MDX
  with `pnpm --filter @multica/web mdx` and running with two Vitest workers.
  The full rerun used `pnpm exec turbo test --filter='!@multica/mobile' --force
  --concurrency=1 --cache-dir=.turbo/test-cache -- --maxWorkers=2`; after isolating
  the desktop config-loader tests from Electron, the desktop suite passed with
  `pnpm --filter @multica/desktop exec vitest run --maxWorkers=2`.
  Missing generated MDX was setup-related; timeouts under the initial high
  concurrency did not recur. The config-loader tests now mock the unused
  Electron API so they do not require a downloaded native binary.
- Mobile: `pnpm --filter @multica/mobile test` passed all 212 remaining tests
  across 29 files and the iOS build-wrapper shell assertions.
- Expo: `EXPO_NO_DOTENV=1 pnpm exec expo config --type introspect --json`
  passed identity and permission assertions with explicit production overrides
  for Carropana and SeguroHQ. Neither configuration grants microphone access;
  both retain their existing names, bundle identifiers, and icons.
- The lockfile passed frozen offline validation. Secure storage remains for
  authentication and preferences; Expo still uses file-system transitively.
- Typecheck, lint, and other static analysis were not run in this test-only
  round, as requested. No native build or device session was performed.
- Earlier browser, backend race, and migration-preservation evidence applies
  to the unchanged integration paths. The reviewed resize-focus and database
  clock test fixes and the fork integration E2E suite are retained.
