# Active agents view — implementation notes

Terse record of the non-obvious decisions made across Tasks 1–12.

## No zod schema for the snapshot endpoint

`GET /api/agent-task-snapshot` has no zod schema.
`pstack_summary` is optional on the TypeScript `AgentTask` type and every read of it is defensive (`task.pstack_summary?.trim()`).

## sqlc import path and issue identifier

The generated sqlc package is imported as `pkg/db/generated`, not `pkg/db`.
`db.Issue` has no `Identifier` field, so the summary prompt builds the human-readable identifier ("MUL-42") through the existing `IssueIdentifier(prefix, number)` helper, fed by `TaskService.getIssuePrefix`.

## Active task check constraint in test seeds

Migration `251_agent_runtime_unbind.up.sql` added `CHECK (runtime_id IS NOT NULL OR completed_at IS NOT NULL)` on `agent_task_queue`.
Test fixtures inserting active (non-terminal) task rows must set `runtime_id`, or the insert fails against a real Postgres.

## Summary sanitizer heading regex

The task-summary sanitizer strips markdown headings with `(^|\s)#+\s*`.
This anchors on whitespace before the `#` run, so "C#" and similar inline uses of `#` survive unaltered.

## Step description uses the full file path

`describeStep` reports the full `input.file_path` for the edited and read verbs, not the shortened path `traceToolArgSummary` produces for narrow table rows.
A card has room for the whole path, so truncation was judged to lose information for no benefit here.

## Command outcome is always null

Transcript results carry no success/failure flag, so `commandOutcome` always resolves to `null`.
Command rows in the card show a neutral dot rather than a colored success/failure indicator.

## Locale parity and plural keys

zh-Hans copy follows the conventions glossary: issue → 任务, agent → 智能体.
Dead `_one` plural keys were removed from the ja, ko, and zh-Hans locale files because the parity test rejects locale-specific plural forms that the base English file doesn't define.

## Card is not a button

The card container itself does not carry `role="button"`.
The headline text is the keyboard-accessible opener for the `AgentWindow` overlay; the rest of the card is not independently interactive.

## Trigger actor label

The trigger bubble always shows `trigger_label_unknown` in v1.
There is no comment-author lookup wired up yet to resolve who triggered a task.

## AgentWindowBody keying and layout

`AgentWindowBody` is keyed by `task.id` so switching tasks remounts its local state cleanly.
The command span uses `min-w-0` so long command text truncates inside its flex row instead of overflowing.

## Active page data fetching

The `/active` page uses `useQueries` with a module-level `combine` function, so step parsing across queries is memoized instead of recomputed on every render.

## Stop button wired (fix wave, 2026-09-03)

`onStop` is now wired: `useCancelTask(wsId)` in `packages/core/agents/use-cancel-task.ts` calls the existing `api.cancelTaskById(taskId)` and invalidates `agentTaskSnapshotKeys.all(wsId)` on settle.
No confirmation dialog, matching the other `cancelTaskById` call sites.

## Real-app check not performed

`make up` was not run against the actual app because a native `postgresql@14` install owns port 5432 on this machine, making the default `DATABASE_URL` unreachable.
All Go verification instead ran against a scratch Docker Postgres (`pgvector/pgvector:pg17`) on port 15433, created and torn down per task.
This is an open item: nobody has clicked through the real `/active` page end to end in this checkout.

## Removed the "does not recompute" memo-guard test (fix wave, 2026-09-03)

The hand-rolled `useQueries` mock deep-compared results itself, so it could return a stable reference even when the production `combine` was unstable, making the test unable to fail for the bug it was meant to guard.
Its module-level `lastCombined` also leaked state between test cases.
Deleted the test and the mock's memoization; the production `combine` fix in `active-board-page.tsx` is unaffected.

## openTask resolved from candidates, not cards (fix wave, 2026-09-03)

`openTask` in `active-board-page.tsx` now resolves from `candidates` (the snapshot-derived, transcript-independent list), not `cards` (the `sortBoardCards` output, which drops a completed task with no `waiting` steps yet).
Resolving from `cards` meant a fresh load of `?task=<completed task>` could see no matching card before its messages fetch resolved, and the clearing effect would remove the param before the window opened.
The window fetches its own messages, so it never needed the card to exist.

## task_summary broadcasts task:progress, not task:running (fix wave, 2026-09-03)

`maybeGenerateTaskSummaryAsync` in `task_summary.go` now re-broadcasts `protocol.EventTaskProgress` instead of `protocol.EventTaskRunning` after writing `pstack_summary`.
Re-broadcasting `task:running` made `plugin_event_bridge.go`'s `EventTaskRunning` subscription fire a duplicate `task.started` webhook.
`task:progress` still reaches the open board: it is not in `use-realtime-sync.ts`'s `specificEvents` exclusion set, so it falls through to the generic `task:` prefix handler (around line 887) that invalidates `agentTaskSnapshotKeys.list(wsId)`.

## Pre-existing gofmt finding

`gofmt -l` flags `server/internal/handler/issue_table_query.go` (and several other unrelated files).
This predates the `active-agents-view` branch — unchanged since `main` — and was left alone.

## task_summary.go was an undisclosed LLM consumer (fix wave, 2026-09-03)

`TestDocumentedConsumersAreTheOnlyCallers` in `server/pkg/llm/outbound_contract_test.go` failed because `task_summary.go` calls `GenerateText` but was never added to the disclosed consumer inventory.
Added it to `documentedConsumers`, the `pkg/llm` package doc comment, `.env.example`, and all four `environment-variables*.mdx` locales.
The disclosed content: the issue identifier and title, the first 1500 characters of the issue description, the task's trigger summary, and the handoff note.

## Real-app check performed (2026-09-03 evening)

The native postgresql@14 was stopped for the session so `make up` could bind 5432; it is restarted afterwards.
Seeded four tasks against real agents and issues in the dev database; running tasks needed the runtime's `last_seen_at` in the future or the offline sweeper failed them within seconds.
Verified in Chrome: grid with the waiting card first, generated headline, templated "right now" line, stale tone, click-through with `?task=`, deep link straight to a completed task, Escape and backdrop close, long command truncation, Reply posting a comment (201), Stop cancelling a task.
Found and fixed: the Open issue link button needed `nativeButton={false}`; conversation blocks shrank inside the scroller (now `shrink-0`); the stale line read "No activity for 24m ago" and now reads "Last activity 24m ago"; focus left the composer after Send, so Escape hit the transcript tooltip first (now refocused).
Known v1 limit confirmed live: only an agent's newest terminal task can appear as waiting, because the snapshot carries one terminal task per agent.
