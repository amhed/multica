# Active agents view: grid overview and agent window

Date: 2026-09-03
Status: approved design, not yet implemented
Design canvas: https://claude.ai/code/artifact/28240328-f58d-4030-ab05-469c19993133

## Goal

Make the `/{workspace}/active` page answer two questions at a glance.
Which agents are working or blocked on me, and what is each one doing, in plain language.
Clicking an agent opens a window that reads like a conversation with that agent, with its code changes and test runs shown inline, and a composer that reaches the agent through an issue comment.

The reference is a concept video of an assistant narrating its work per app.
Multica keeps its own dark theme and component vocabulary; only the structure carries over.

## Decisions already made

- Overview layout is a dense grid, every agent visible at once. The carousel deck was rejected.
- Click-through is an overlay over the dimmed grid, addressed by a `?task=<id>` search param, not a route.
- Actions are static: Open issue, Transcript, Stop, and the comment composer. No generated reply chips in v1.
- "Waiting for you" is derived client-side from finished tasks. No new server-side task status.
- The human-language headline comes from a server-side summarizer using a cheap model, called once per task when the task starts. It never re-runs.
- The summary column is named `pstack_summary` and the migration file `450_pstack_agent_task_summary`, so a later upstream merge cannot collide on either name.

## Current state

- Page: `packages/views/agents/components/active-board-page.tsx`, card: `active-task-card.tsx`, pure helpers: `active-board.ts`.
- Data: `agentTaskSnapshotOptions(wsId)` for the task list, `taskMessagesOptions(taskId)` for the live transcript.
  Holding the transcript cache entry while a task runs is what lets the `task:message` websocket stream flow.
- Drill-in: `agent-transcript-dialog.tsx`, a raw seq-ordered timeline. It stays as the "Transcript" action.
- Server: `server/pkg/llm` wraps the OpenAI Go SDK with a configurable base URL and default model.
  Chat title generation in `server/internal/handler/chat_title.go` is the fire-and-forget precedent.
- `TaskService.StartTask` in `server/internal/service/task.go` flips a task to running and broadcasts `task:running`.

## 1. Backend: task summary

Migration `server/migrations/450_pstack_agent_task_summary.up.sql` adds `pstack_summary TEXT NULL` to `agent_task_queue`.
No index. The down migration drops the column.
Regenerate sqlc; the snapshot query and the task JSON gain a `pstack_summary` field.

In `TaskService.StartTask`, after the row is running and the event is broadcast, call `maybeGenerateTaskSummaryAsync(ctx, task)`.
It mirrors the chat-title flow.
It returns immediately when the LLM client is nil or not enabled.
Otherwise it runs in a goroutine with a detached context and a 20 second timeout, and never affects the request's result.

Prompt input, in this order: issue identifier and title, the first 1500 characters of the issue description, `trigger_summary`, `handoff_note`.
Missing pieces are omitted, not sent as empty labels.
The system prompt asks for one or two plain sentences in the present tense, describing what the agent is set to do and why, no markdown, no preamble, under 300 characters.
The response is trimmed, collapsed to single spaces, and truncated to 300 characters before storage.
An empty response is treated as failure.

On success the service writes `pstack_summary` and broadcasts the existing task update event so open cards refetch the snapshot.
On failure it logs at warn level and leaves the column null.
There is no retry beyond the client's own retry setting, and no regeneration on restart or on later runs of the same task.

Config: `MULTICA_LLM_SUMMARY_MODEL`, read next to the other `MULTICA_LLM_*` variables.
When unset, the default model is used.
The client speaks the OpenAI wire format only, so a non-OpenAI model must sit behind an OpenAI-compatible endpoint.
A separate base URL for the summary model is out of scope.

## 2. Overview grid

Same route, same snapshot query, same page component, new layout.
The grid has two columns at the dashboard's default width and one column below 900px.
Tasks are no longer grouped by issue; each task is one card.

Sort order: waiting cards first, then running by most recent transcript activity, then dispatched and queued by start time.

Card anatomy, top to bottom:

- Header row: agent avatar and name, the issue identifier as a link to the issue, and a status pill on the right.
  Pill states: Running with elapsed time in success tone, Waiting for you in warning tone, Queued or Dispatched in muted tone, Stale in warning tone.
- Headline paragraph: `pstack_summary` when present, else the existing trigger text chain (latest agent text is no longer used here).
- Right now line: one line describing the latest non-thinking transcript step, with a relative timestamp on the right.
  While running with no steps yet it reads "Waiting for activity".
  When stale it reads "No activity for N minutes" in the warning tone.
- Footer: Open issue, Transcript, Stop. Waiting cards show Reply instead of Stop.

The right now line is produced by a new pure function `describeStep(step)` in `active-board.ts`.
Tool calls map through a small table keyed on tool name to a verb phrase, with the existing `traceToolArgSummary` output as the object.
Examples: `Edited <path>`, `Read <path>`, `Ran <command>`, `Searched for <query>`.
Unknown tools fall back to `Used <tool> <summary>`.
Text steps render their plain summary as today. Error steps render in the destructive tone.

The transcript subscription rule is unchanged: `taskMessagesOptions` stays mounted while the task is running, and only then.

## 3. Waiting cards

A task is "waiting for you" when its status is completed, it completed within the last hour, and its last agent text step ends with a question mark.
This is a pure predicate `isWaitingForInput(task, steps, now)` in `active-board.ts`.

The snapshot already returns at most one terminal task per agent, so only that agent's latest finished task can appear as waiting.
That limit is accepted for v1.

Because the waiting predicate needs transcript steps for a finished task, the card fetches that task's messages once, lazily, using the existing terminal-task fetch path in `taskMessagesOptions`.
This is a one-shot fetch, not a live subscription.

## 4. Agent window overlay

Clicking anywhere on a card except its footer actions opens the window.
Opening sets `?task=<taskId>` through the navigation adapter; closing removes it.
Escape and backdrop click close it.
A page load with `?task=` present opens the window directly; if the task is not in the snapshot the param is cleared silently.

The window is a large centred dialog built on the shared dialog primitive, about 920px wide, with the grid dimmed behind it.
Header mirrors the card header, plus a close button.

Body is a conversation built from the task's transcript steps:

- The trigger, from the trigger summary or handoff note, renders as a right-aligned bubble labelled with the actor and time.
- Agent text steps render as left-aligned bubbles.
- Tool steps between two text steps are grouped into one block.
  Inside a block, file edit tools aggregate into one card headed "N files changed" with the file list.
  Command and test runs render one row each with the command and its outcome when the output exposes one.
  Every other step collapses into one line "N other steps" that expands to the `describeStep` prose for each.
- While the task is running, a typing indicator with the current `describeStep` text sits at the bottom.

Follow-scroll reuses the existing transcript follow helper.
The Transcript action in the header opens the existing raw transcript dialog for people who need the exact events.

The composer posts a comment on the task's issue through the existing comment mutation.
Nothing new is added server-side.
While the task is running the composer is disabled with the hint "The agent picks this up after its current run"; it is enabled for waiting and finished tasks.

## 5. Testing

Server, Go:

- `StartTask` test: with an enabled fake client, the summary generator is invoked with the expected prompt pieces and writes `pstack_summary`.
  With a nil or disabled client, nothing is called and the task still starts.
- Snapshot handler test includes the new field.
- Migration is exercised by the existing migrate tests.

Core, TypeScript:

- Zod schema for the task gains `pstack_summary` as optional nullable string, with a malformed-response test.

Views, TypeScript:

- `active-board.test.ts`: `describeStep` table and fallback, `isWaitingForInput` boundaries (question mark, one hour cut-off, non-completed status), and sort order.
- `active-board-page.test.tsx`: happy path renders one card per task with headline fallback, clicking a card sets the param and opens the window, Escape clears it, a page load with the param opens the window, an unknown param is cleared.
- Agent window test: grouping of tool steps into file and command blocks, composer disabled while running.

## Non-goals for v1

- Regenerating the summary during or after a run.
- Generated reply chips or suggested actions.
- A dedicated route for the agent window or a desktop tab destination.
- A server-side waiting status.
- Rendering diffs inline; the file card lists paths only.
- A separate base URL or provider client for the summary model.

## Implementation notes log

During implementation of this spec, maintain a running `docs/superpowers/specs/2026-09-03-active-agents-view-implementation-notes.md` file alongside the spec. Update it incrementally, not at the end, every time you:

- Make a decision that wasn't in the spec
- Change something the spec specified differently
- Hit a tradeoff and pick a side
- Notice anything else the reviewer should know before reading the diff

Each entry: short heading, 1-3 sentences, timestamp optional. The file is for the human reviewing the PR, not a design doc. Be terse and concrete.
