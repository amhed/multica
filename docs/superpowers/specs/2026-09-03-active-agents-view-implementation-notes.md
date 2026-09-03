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

## Stop button not wired

`onStop` exists as a prop shape but is not wired to anything; the Stop control stays hidden.
No cancel-task mutation has been confirmed to exist for this flow, so wiring it was left out of v1.

## Real-app check not performed

`make up` was not run against the actual app because a native `postgresql@14` install owns port 5432 on this machine, making the default `DATABASE_URL` unreachable.
All Go verification instead ran against a scratch Docker Postgres (`pgvector/pgvector:pg17`) on port 15433, created and torn down per task.
This is an open item: nobody has clicked through the real `/active` page end to end in this checkout.

## Pre-existing gofmt finding

`gofmt -l` flags `server/internal/handler/issue_table_query.go` (and several other unrelated files).
This predates the `active-agents-view` branch — unchanged since `main` — and was left alone.
