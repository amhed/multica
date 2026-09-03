# Active Agents View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild `/{workspace}/active` as a grid of agent cards with a one-time model-written headline per task, and a click-through overlay that reads a task's transcript as a conversation with the agent.

**Architecture:** The Go server gains a nullable `pstack_summary` column on `agent_task_queue`, filled once by a fire-and-forget goroutine in `TaskService.StartTask` through the existing `pkg/llm` client, and exposed on the task snapshot. The views package rewrites the active board page into a grid, replaces the three-step peek with one templated "right now" line, derives "waiting for you" from recently completed tasks, and adds an `AgentWindow` dialog driven by a `?task=` search param. No new endpoints, no new websocket events, no new stores.

**Tech Stack:** Go 1.26, sqlc, pgx, chi; TypeScript strict, React, TanStack Query, Vitest, Testing Library; i18n JSON under `packages/views/locales/*`.

**Spec:** `docs/superpowers/specs/2026-09-03-active-agents-view-design.md`

## Global Constraints

- Column, sqlc field, JSON field, and TypeScript field are all named `pstack_summary` / `PstackSummary`. Migration files are `450_pstack_agent_task_summary.up.sql` and `.down.sql`.
- No foreign keys, no cascades, no index in the migration. Migration files run outside a transaction.
- The summary is generated once, in `StartTask`, never on later runs, restarts, or transcript batches. Summary text is at most 300 characters, single-spaced, plain text.
- Config variable is `MULTICA_LLM_SUMMARY_MODEL`; empty means "use the client's default model".
- `pkg/llm` stays the only importer of the OpenAI SDK. Services depend on a small interface, as `ChatQuickActionsLLM` does today.
- Frontend: TanStack Query owns server data; no Zustand for this feature; `?task=` is read and written only through `useNavigation()` from `packages/views/navigation`; no `next/*` or `react-router-dom` in `packages/views`.
- The transcript subscription rule is unchanged: `taskMessagesOptions(taskId)` is held live only while `status === "running"`.
- Every new UI string is added to `packages/views/locales/{en,ja,ko,zh-Hans}/agents.json`; `packages/views/locales/parity.test.ts` enforces key parity. Read `apps/docs/content/docs/developers/conventions.mdx` before writing zh-Hans copy.
- Use design tokens and the role-named type scale (`text-caption`, `text-body`, `text-body-lg`, `text-title`); no hardcoded Tailwind colours.
- Node-only `.test.ts` files start with `// @vitest-environment node`. Component tests use `// @vitest-environment jsdom`.
- Commit messages use conventional prefixes. Do not add an agent co-author line.
- Keep `docs/superpowers/specs/2026-09-03-active-agents-view-implementation-notes.md` updated as you go, per the spec's "Implementation notes log" section.

---

## File Structure

Server:

- Create `server/migrations/450_pstack_agent_task_summary.up.sql` and `.down.sql`: the column.
- Modify `server/pkg/db/queries/agent.sql`: one new `SetAgentTaskPstackSummary :one` query. sqlc regenerates `server/pkg/db/generated/*`.
- Modify `server/internal/handler/agent.go`: `AgentTaskResponse.PstackSummary` and its mapping in `taskToResponse`.
- Create `server/internal/service/task_summary.go`: `TaskSummaryLLM` interface, prompt builder, sanitizer, `maybeGenerateTaskSummaryAsync`.
- Create `server/internal/service/task_summary_test.go`: pure tests for prompt and sanitizer, plus one DB test through `StartTask`.
- Modify `server/internal/service/task.go`: two new `TaskService` fields and one call in `StartTask`.
- Modify `server/internal/handler/handler.go` and `server/cmd/server/router.go`: config plumbing for `MULTICA_LLM_SUMMARY_MODEL`.
- Modify `.env.example` and `apps/docs/content/docs/environment-variables.mdx` (plus `.zh`, `.ja`, `.ko`): document the variable.

Frontend:

- Modify `packages/core/types/agent.ts`: `pstack_summary?: string | null` on `AgentTask`.
- Modify `packages/views/agents/components/active-board.ts`: `taskSummary` prefers `pstack_summary`; new `describeStep`, `isWaitingForInput`, `selectBoardTasks`, `sortBoardTasks`, `RECENT_TERMINAL_MS`.
- Modify `packages/views/agents/components/active-board.test.ts`: tests for the above.
- Create `packages/views/agents/components/agent-window-conversation.ts` and `.test.ts`: pure grouping of transcript steps into conversation blocks.
- Rewrite `packages/views/agents/components/active-task-card.tsx`: the grid card.
- Create `packages/views/agents/components/agent-window.tsx`: the overlay dialog.
- Rewrite `packages/views/agents/components/active-board-page.tsx`: grid, sort, waiting detection, `?task=` wiring.
- Modify `packages/views/agents/components/active-board-page.test.tsx`: wiring tests.
- Create `packages/views/agents/components/agent-window.test.tsx`: composer state and block rendering.
- Modify `packages/views/locales/{en,ja,ko,zh-Hans}/agents.json`: new keys under `active_board`.

---

### Task 1: Column, query, and API field

**Files:**
- Create: `server/migrations/450_pstack_agent_task_summary.up.sql`
- Create: `server/migrations/450_pstack_agent_task_summary.down.sql`
- Modify: `server/pkg/db/queries/agent.sql` (append after the `StartAgentTask` query block that starts at line 985)
- Modify: `server/internal/handler/agent.go:455` (struct field) and `:802` (mapping)
- Test: `server/internal/handler/agent_task_response_pstack_summary_test.go`

**Interfaces:**
- Produces: `db.AgentTaskQueue.PstackSummary pgtype.Text`; `Queries.SetAgentTaskPstackSummary(ctx, db.SetAgentTaskPstackSummaryParams{ID pgtype.UUID, PstackSummary pgtype.Text}) (db.AgentTaskQueue, error)`; JSON field `pstack_summary` (string, omitted when null) on every task in `GET /api/agent-task-snapshot`.

- [ ] **Step 1: Write the migration pair**

`server/migrations/450_pstack_agent_task_summary.up.sql`:

```sql
-- One-time, model-written headline for the active board: what this task is set
-- to do, in one or two plain sentences. Written once by TaskService.StartTask
-- through the server-internal LLM layer; NULL when the LLM layer is disabled,
-- the call failed, or the task started before this column existed. The
-- pstack_ prefix keeps this fork's column clear of upstream names.
ALTER TABLE agent_task_queue ADD COLUMN IF NOT EXISTS pstack_summary TEXT;
```

`server/migrations/450_pstack_agent_task_summary.down.sql`:

```sql
ALTER TABLE agent_task_queue DROP COLUMN IF EXISTS pstack_summary;
```

- [ ] **Step 2: Add the sqlc query**

Append to `server/pkg/db/queries/agent.sql` directly after the `StartAgentTask` query block:

```sql
-- name: SetAgentTaskPstackSummary :one
-- Stores the one-time active-board headline. Only fills an empty slot: the
-- summary is written once per task and a later writer must never replace it.
UPDATE agent_task_queue
SET pstack_summary = @pstack_summary
WHERE id = @id AND pstack_summary IS NULL
RETURNING *;
```

- [ ] **Step 3: Regenerate sqlc and apply the migration locally**

Run from the repo root:

```bash
make sqlc
make up C=api
```

Expected: `server/pkg/db/generated/models.go` gains `PstackSummary pgtype.Text` on `AgentTaskQueue`, and `agent.sql.go` gains `SetAgentTaskPstackSummary`. `make up` applies migration 450 (check with `make status`).

- [ ] **Step 4: Write the failing response-mapping test**

`server/internal/handler/agent_task_response_pstack_summary_test.go`:

```go
package handler

import (
	"testing"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/multica-ai/multica/server/pkg/db"
)

func TestTaskToResponseCarriesPstackSummary(t *testing.T) {
	task := db.AgentTaskQueue{
		ID:            parseUUID("11111111-1111-1111-1111-111111111111"),
		AgentID:       parseUUID("22222222-2222-2222-2222-222222222222"),
		Status:        "running",
		PstackSummary: pgtype.Text{String: "Adding a --property flag to issue list.", Valid: true},
	}
	got := taskToResponse(task, "ws-1")
	if got.PstackSummary == nil || *got.PstackSummary != "Adding a --property flag to issue list." {
		t.Fatalf("pstack_summary not mapped: %#v", got.PstackSummary)
	}

	task.PstackSummary = pgtype.Text{}
	got = taskToResponse(task, "ws-1")
	if got.PstackSummary != nil {
		t.Fatalf("null column must map to nil, got %q", *got.PstackSummary)
	}
}
```

Check the module path used by sibling test files in `server/internal/handler/` and match their `db` import exactly.

- [ ] **Step 5: Run the test to verify it fails**

```bash
cd server && go test ./internal/handler -run TestTaskToResponseCarriesPstackSummary -count=1
```

Expected: compile error, `got.PstackSummary undefined`.

- [ ] **Step 6: Add the field and mapping**

In `server/internal/handler/agent.go`, directly after the `TriggerSummary` field of `AgentTaskResponse` (line 455):

```go
	PstackSummary *string `json:"pstack_summary,omitempty"` // one-time model-written active-board headline; nil until generated
```

In `taskToResponse`, directly after `TriggerSummary: textToPtr(t.TriggerSummary),` (line 802):

```go
		PstackSummary:          textToPtr(t.PstackSummary),
```

- [ ] **Step 7: Run the test and vet**

```bash
cd server && go test ./internal/handler -run TestTaskToResponseCarriesPstackSummary -count=1 && go vet ./internal/handler ./pkg/db/...
```

Expected: PASS, no vet output.

- [ ] **Step 8: Commit**

```bash
git add server/migrations/450_pstack_agent_task_summary.up.sql server/migrations/450_pstack_agent_task_summary.down.sql server/pkg/db/queries/agent.sql server/pkg/db/generated server/internal/handler/agent.go server/internal/handler/agent_task_response_pstack_summary_test.go
git commit -m "feat(agents): add pstack_summary to agent tasks and the task snapshot"
```

---

### Task 2: Summary prompt and sanitizer (pure)

**Files:**
- Create: `server/internal/service/task_summary.go`
- Create: `server/internal/service/task_summary_test.go`

**Interfaces:**
- Produces:
  - `type TaskSummaryLLM interface { Enabled() bool; GenerateText(ctx context.Context, model, systemPrompt, userPrompt string) (string, error) }` (satisfied by `*llm.Client`).
  - `type taskSummaryInput struct { Identifier, Title, Description, TriggerSummary, HandoffNote string }`
  - `func buildTaskSummaryPrompt(in taskSummaryInput) (string, bool)`: the user prompt and whether there is anything worth summarizing.
  - `func sanitizeTaskSummary(raw string) string`: trimmed, whitespace-collapsed, markdown-stripped, capped at 300 runes; empty when nothing usable remains.
  - `const taskSummarySystemPrompt string`, `const taskSummaryMaxRunes = 300`, `const taskSummaryDescriptionRunes = 1500`, `const taskSummaryTimeout = 20 * time.Second`.

- [ ] **Step 1: Write the failing tests**

`server/internal/service/task_summary_test.go`:

```go
package service

import (
	"strings"
	"testing"
)

func TestBuildTaskSummaryPromptIncludesEveryPresentPiece(t *testing.T) {
	prompt, ok := buildTaskSummaryPrompt(taskSummaryInput{
		Identifier:     "MUL-6771",
		Title:          "Filter issue list by custom property",
		Description:    "Add a --property flag.",
		TriggerSummary: "Please match how --label works.",
		HandoffNote:    "Keep it to the CLI package.",
	})
	if !ok {
		t.Fatal("expected a prompt")
	}
	for _, want := range []string{
		"Issue: MUL-6771 Filter issue list by custom property",
		"Description:\nAdd a --property flag.",
		"Trigger:\nPlease match how --label works.",
		"Handoff note:\nKeep it to the CLI package.",
	} {
		if !strings.Contains(prompt, want) {
			t.Errorf("prompt missing %q:\n%s", want, prompt)
		}
	}
}

func TestBuildTaskSummaryPromptOmitsEmptyLabels(t *testing.T) {
	prompt, ok := buildTaskSummaryPrompt(taskSummaryInput{Identifier: "MUL-1", Title: "Only a title"})
	if !ok {
		t.Fatal("a title alone is enough to summarize")
	}
	for _, label := range []string{"Description:", "Trigger:", "Handoff note:"} {
		if strings.Contains(prompt, label) {
			t.Errorf("empty section %q must be omitted:\n%s", label, prompt)
		}
	}
}

func TestBuildTaskSummaryPromptRefusesEmptyInput(t *testing.T) {
	if _, ok := buildTaskSummaryPrompt(taskSummaryInput{}); ok {
		t.Fatal("nothing to summarize must return ok=false")
	}
}

func TestBuildTaskSummaryPromptTruncatesDescription(t *testing.T) {
	long := strings.Repeat("é", 2000)
	prompt, _ := buildTaskSummaryPrompt(taskSummaryInput{Title: "t", Description: long})
	if strings.Count(prompt, "é") != taskSummaryDescriptionRunes {
		t.Fatalf("description must be cut at %d runes, got %d", taskSummaryDescriptionRunes, strings.Count(prompt, "é"))
	}
}

func TestSanitizeTaskSummary(t *testing.T) {
	cases := map[string]string{
		"  Adding   a flag.\n\nThen tests.  ": "Adding a flag. Then tests.",
		"**Bold** and `code` and # heading":  "Bold and code and heading",
		"Summary: Adding a flag.":            "Adding a flag.",
		"\n\t ":                              "",
	}
	for in, want := range cases {
		if got := sanitizeTaskSummary(in); got != want {
			t.Errorf("sanitizeTaskSummary(%q) = %q, want %q", in, got, want)
		}
	}
	long := strings.Repeat("a", 400)
	if got := sanitizeTaskSummary(long); len([]rune(got)) != taskSummaryMaxRunes {
		t.Fatalf("must cap at %d runes, got %d", taskSummaryMaxRunes, len([]rune(got)))
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd server && go test ./internal/service -run 'TestBuildTaskSummaryPrompt|TestSanitizeTaskSummary' -count=1
```

Expected: compile errors for undefined `buildTaskSummaryPrompt`, `taskSummaryInput`, `sanitizeTaskSummary`.

- [ ] **Step 3: Write the pure implementation**

`server/internal/service/task_summary.go`:

```go
package service

import (
	"context"
	"regexp"
	"strings"
	"time"
)

// TaskSummaryLLM is the slice of the server-internal LLM layer the active-board
// headline needs. *llm.Client satisfies it; tests pass a fake.
type TaskSummaryLLM interface {
	Enabled() bool
	GenerateText(ctx context.Context, model, systemPrompt, userPrompt string) (string, error)
}

const (
	taskSummaryMaxRunes         = 300
	taskSummaryDescriptionRunes = 1500
	taskSummaryTimeout          = 20 * time.Second
)

// taskSummarySystemPrompt is stable across calls so upstream prompt caching
// applies. It asks for a headline a teammate could read at a glance.
const taskSummarySystemPrompt = `You write one-line status headlines for a task board.
Given an issue and the instruction that started an AI agent on it, write what the agent is set to do and why.
Rules:
- One or two sentences, present tense, plain text.
- Under 300 characters.
- No markdown, no quotes, no preamble such as "Summary:".
- Name the concrete change, not the process. Say "Adds a --property flag to issue list" rather than "Works on the issue".
- If the input is unclear, describe the issue title only.`

type taskSummaryInput struct {
	Identifier     string
	Title          string
	Description    string
	TriggerSummary string
	HandoffNote    string
}

// buildTaskSummaryPrompt renders the user prompt. Sections with no content are
// left out entirely rather than sent as empty labels. ok is false when there is
// nothing at all to summarize.
func buildTaskSummaryPrompt(in taskSummaryInput) (string, bool) {
	title := strings.TrimSpace(in.Title)
	desc := truncateRunes(strings.TrimSpace(in.Description), taskSummaryDescriptionRunes)
	trigger := strings.TrimSpace(in.TriggerSummary)
	note := strings.TrimSpace(in.HandoffNote)
	if title == "" && desc == "" && trigger == "" && note == "" {
		return "", false
	}

	var b strings.Builder
	if title != "" {
		b.WriteString("Issue: ")
		if id := strings.TrimSpace(in.Identifier); id != "" {
			b.WriteString(id)
			b.WriteString(" ")
		}
		b.WriteString(title)
		b.WriteString("\n")
	}
	section := func(label, body string) {
		if body == "" {
			return
		}
		b.WriteString("\n")
		b.WriteString(label)
		b.WriteString(":\n")
		b.WriteString(body)
		b.WriteString("\n")
	}
	section("Description", desc)
	section("Trigger", trigger)
	section("Handoff note", note)
	return b.String(), true
}

var (
	summaryWhitespace = regexp.MustCompile(`\s+`)
	summaryBold       = regexp.MustCompile(`\*\*([^*]+)\*\*`)
	summaryCode       = regexp.MustCompile("`([^`]*)`")
	summaryHeading    = regexp.MustCompile(`(?m)^#+\s*`)
	summaryPreamble   = regexp.MustCompile(`(?i)^(summary|headline)\s*:\s*`)
)

// sanitizeTaskSummary turns raw model output into the stored headline: markdown
// stripped, whitespace collapsed, preamble removed, capped at taskSummaryMaxRunes.
func sanitizeTaskSummary(raw string) string {
	s := summaryHeading.ReplaceAllString(raw, "")
	s = summaryBold.ReplaceAllString(s, "$1")
	s = summaryCode.ReplaceAllString(s, "$1")
	s = summaryWhitespace.ReplaceAllString(s, " ")
	s = strings.TrimSpace(s)
	s = summaryPreamble.ReplaceAllString(s, "")
	s = strings.Trim(s, `"'`)
	return truncateRunes(strings.TrimSpace(s), taskSummaryMaxRunes)
}

func truncateRunes(s string, max int) string {
	r := []rune(s)
	if len(r) <= max {
		return s
	}
	return string(r[:max])
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd server && go test ./internal/service -run 'TestBuildTaskSummaryPrompt|TestSanitizeTaskSummary' -count=1
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/internal/service/task_summary.go server/internal/service/task_summary_test.go
git commit -m "feat(agents): add task summary prompt builder and sanitizer"
```

---

### Task 3: Generate the summary when a task starts

**Files:**
- Modify: `server/internal/service/task_summary.go` (append)
- Modify: `server/internal/service/task.go:39-80` (fields) and `:4089-4112` (`StartTask`)
- Modify: `server/internal/service/task_summary_test.go` (append)

**Interfaces:**
- Consumes: `buildTaskSummaryPrompt`, `sanitizeTaskSummary`, `TaskSummaryLLM` from Task 2; `Queries.SetAgentTaskPstackSummary` and `Queries.GetIssue` from sqlc; `s.broadcastTaskEvent(ctx, eventType string, task db.AgentTaskQueue)` at `task.go:7012`.
- Produces: `TaskService.Summaries TaskSummaryLLM`, `TaskService.SummaryModel string`, `func (s *TaskService) maybeGenerateTaskSummaryAsync(task db.AgentTaskQueue)`.

- [ ] **Step 1: Write the failing DB test**

Append to `server/internal/service/task_summary_test.go`. It reuses `newResolveOriginatorPool` from `resolve_originator_test.go:26` and `seedAttributionFixture` from `attribution_stamp_test.go`, both in the same package.

```go
type fakeSummaryLLM struct {
	calls chan string
	reply string
	err   error
}

func (f *fakeSummaryLLM) Enabled() bool { return true }
func (f *fakeSummaryLLM) GenerateText(_ context.Context, model, _ string, userPrompt string) (string, error) {
	f.calls <- model + "\n" + userPrompt
	return f.reply, f.err
}

func TestStartTaskWritesPstackSummaryOnce(t *testing.T) {
	pool := newResolveOriginatorPool(t)
	ctx := context.Background()
	q := db.New(pool)
	_, _, agentID, issueID := seedAttributionFixture(t, pool)

	var taskID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO agent_task_queue (agent_id, issue_id, status, priority, trigger_summary, handoff_note)
		VALUES ($1, $2, 'dispatched', 0, 'Please add the flag', 'Stay in the CLI package')
		RETURNING id`, agentID, issueID).Scan(&taskID); err != nil {
		t.Fatalf("seed task: %v", err)
	}
	t.Cleanup(func() { _, _ = pool.Exec(ctx, `DELETE FROM agent_task_queue WHERE id = $1`, taskID) })

	fake := &fakeSummaryLLM{calls: make(chan string, 1), reply: "  **Adds** the flag.\n"}
	svc := &TaskService{Queries: q, TxStarter: pool, Bus: events.New(), Summaries: fake, SummaryModel: "cheap-model"}

	if _, err := svc.StartTask(ctx, util.MustParseUUID(taskID)); err != nil {
		t.Fatalf("StartTask: %v", err)
	}

	select {
	case call := <-fake.calls:
		if !strings.HasPrefix(call, "cheap-model\n") {
			t.Fatalf("summary model not passed through: %q", call)
		}
		for _, want := range []string{"attr issue", "Please add the flag", "Stay in the CLI package"} {
			if !strings.Contains(call, want) {
				t.Errorf("prompt missing %q", want)
			}
		}
	case <-time.After(5 * time.Second):
		t.Fatal("summarizer was never called")
	}

	deadline := time.Now().Add(5 * time.Second)
	for {
		var got *string
		if err := pool.QueryRow(ctx, `SELECT pstack_summary FROM agent_task_queue WHERE id = $1`, taskID).Scan(&got); err != nil {
			t.Fatalf("read summary: %v", err)
		}
		if got != nil {
			if *got != "Adds the flag." {
				t.Fatalf("stored summary = %q", *got)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("pstack_summary never written")
		}
		time.Sleep(20 * time.Millisecond)
	}

	// A second writer must not replace the stored headline.
	if _, err := q.SetAgentTaskPstackSummary(ctx, db.SetAgentTaskPstackSummaryParams{
		ID:            util.MustParseUUID(taskID),
		PstackSummary: pgtype.Text{String: "replacement", Valid: true},
	}); err == nil {
		t.Fatal("SetAgentTaskPstackSummary must not match a row that already has a summary")
	}
}

func TestStartTaskWithoutSummarizerStillStarts(t *testing.T) {
	pool := newResolveOriginatorPool(t)
	ctx := context.Background()
	q := db.New(pool)
	_, _, agentID, issueID := seedAttributionFixture(t, pool)

	var taskID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO agent_task_queue (agent_id, issue_id, status, priority)
		VALUES ($1, $2, 'dispatched', 0) RETURNING id`, agentID, issueID).Scan(&taskID); err != nil {
		t.Fatalf("seed task: %v", err)
	}
	t.Cleanup(func() { _, _ = pool.Exec(ctx, `DELETE FROM agent_task_queue WHERE id = $1`, taskID) })

	svc := &TaskService{Queries: q, TxStarter: pool, Bus: events.New()}
	task, err := svc.StartTask(ctx, util.MustParseUUID(taskID))
	if err != nil {
		t.Fatalf("StartTask: %v", err)
	}
	if task.Status != "running" {
		t.Fatalf("status = %q, want running", task.Status)
	}
}
```

Add the imports the file now needs: `context`, `time`, `github.com/jackc/pgx/v5/pgtype`, and the repo's `db`, `events`, `util` packages. Copy their import paths from `attribution_stamp_test.go`.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd server && go test ./internal/service -run 'TestStartTaskWritesPstackSummaryOnce|TestStartTaskWithoutSummarizerStillStarts' -count=1
```

Expected: compile error, `unknown field Summaries in struct literal`.

- [ ] **Step 3: Add the service fields**

In `server/internal/service/task.go`, directly after the `QuickActions ChatQuickActionsLLM` field (line 79):

```go
	// Summaries writes the one-time active-board headline (pstack_summary)
	// when a task starts. Optional: nil or a disabled client leaves the column
	// NULL and the board falls back to the trigger text. Wired in handler.go
	// from the same *llm.Client that backs chat auto-titling.
	Summaries TaskSummaryLLM
	// SummaryModel overrides the client's default model for headlines. Maps to
	// MULTICA_LLM_SUMMARY_MODEL; empty means the client default.
	SummaryModel string
```

- [ ] **Step 4: Add the async generator**

Append to `server/internal/service/task_summary.go` (add `log/slog`, `util`, `db`, and `protocol` imports as the file's neighbours do):

```go
// maybeGenerateTaskSummaryAsync fills pstack_summary for a task that just
// started. It is best-effort and detached from the caller: a disabled client,
// an empty prompt, a model error, or a panic all leave the column NULL and the
// board keeps showing the trigger text.
func (s *TaskService) maybeGenerateTaskSummaryAsync(task db.AgentTaskQueue) {
	if s.Summaries == nil || !s.Summaries.Enabled() {
		return
	}
	go func() {
		defer func() {
			if rec := recover(); rec != nil {
				slog.Error("task summary generation panicked", "task_id", util.UUIDToString(task.ID), "panic", rec)
			}
		}()
		ctx, cancel := context.WithTimeout(context.Background(), taskSummaryTimeout)
		defer cancel()

		in := taskSummaryInput{
			TriggerSummary: task.TriggerSummary.String,
			HandoffNote:    task.HandoffNote.String,
		}
		if task.IssueID.Valid {
			if issue, err := s.Queries.GetIssue(ctx, task.IssueID); err == nil {
				in.Identifier = issue.Identifier
				in.Title = issue.Title
				in.Description = issue.Description.String
			} else {
				slog.Warn("task summary: issue lookup failed", "task_id", util.UUIDToString(task.ID), "error", err)
			}
		}
		prompt, ok := buildTaskSummaryPrompt(in)
		if !ok {
			return
		}
		raw, err := s.Summaries.GenerateText(ctx, s.SummaryModel, taskSummarySystemPrompt, prompt)
		if err != nil {
			slog.Warn("task summary generation failed", "task_id", util.UUIDToString(task.ID), "error", err)
			return
		}
		summary := sanitizeTaskSummary(raw)
		if summary == "" {
			return
		}
		updated, err := s.Queries.SetAgentTaskPstackSummary(ctx, db.SetAgentTaskPstackSummaryParams{
			ID:            task.ID,
			PstackSummary: pgtype.Text{String: summary, Valid: true},
		})
		if err != nil {
			// pgx.ErrNoRows here means another writer already filled the slot.
			slog.Warn("task summary write skipped", "task_id", util.UUIDToString(task.ID), "error", err)
			return
		}
		// Re-broadcast the running transition with the enriched row: clients
		// treat task:running as "refetch the snapshot", which is exactly what
		// an open board needs to pick up the headline.
		s.broadcastTaskEvent(ctx, protocol.EventTaskRunning, updated)
	}()
}
```

Check the exact field names on the generated `db.Issue` struct (`Identifier`, `Title`, `Description`) in `server/pkg/db/generated/models.go` and adjust if they differ; `Description` may be `pgtype.Text` or `string`.

- [ ] **Step 5: Call it from StartTask**

In `StartTask` (`task.go:4089`), directly after `s.broadcastTaskEvent(ctx, protocol.EventTaskRunning, task)`:

```go
	s.maybeGenerateTaskSummaryAsync(task)
```

- [ ] **Step 6: Run the tests**

```bash
cd server && go test ./internal/service -run 'TestStartTaskWritesPstackSummaryOnce|TestStartTaskWithoutSummarizerStillStarts|TestBuildTaskSummaryPrompt|TestSanitizeTaskSummary' -count=1 && go vet ./internal/service
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/internal/service/task.go server/internal/service/task_summary.go server/internal/service/task_summary_test.go
git commit -m "feat(agents): write the active-board headline when a task starts"
```

---

### Task 4: Config plumbing and docs

**Files:**
- Modify: `server/internal/handler/handler.go:139` (Config field) and `:418-440` (wiring)
- Modify: `server/cmd/server/router.go:437`
- Modify: `.env.example`
- Modify: `apps/docs/content/docs/environment-variables.mdx`, `.zh.mdx`, `.ja.mdx`, `.ko.mdx`

**Interfaces:**
- Consumes: `TaskService.Summaries`, `TaskService.SummaryModel` from Task 3.
- Produces: `handler.Config.LLMSummaryModel string`; env `MULTICA_LLM_SUMMARY_MODEL`.

- [ ] **Step 1: Add the config field**

In `server/internal/handler/handler.go`, directly after `LLMDefaultModel string` (line 139), matching the comment style of the block above it:

```go
	//   - LLMSummaryModel  -> MULTICA_LLM_SUMMARY_MODEL (active-board headlines; empty = LLMDefaultModel)
	LLMSummaryModel string
```

Put the comment line inside the existing comment block that lists the LLM variables (around line 135), and the field after `LLMDefaultModel`.

- [ ] **Step 2: Wire the service**

In `handler.go`, directly after `taskSvc.QuickActions = llmClient`:

```go
	// Active-board headlines share the client; only the model may differ so a
	// cheaper model can be pointed at this high-volume, low-stakes call.
	taskSvc.Summaries = llmClient
	taskSvc.SummaryModel = cfg.LLMSummaryModel
```

In `server/cmd/server/router.go`, directly after the `LLMDefaultModel:` line (437):

```go
		LLMSummaryModel:          strings.TrimSpace(os.Getenv("MULTICA_LLM_SUMMARY_MODEL")),
```

- [ ] **Step 3: Build and run the server package tests that touch config**

```bash
cd server && go build ./... && go test ./cmd/server -count=1
```

Expected: builds; tests PASS.

- [ ] **Step 4: Document the variable**

In `.env.example`, next to `MULTICA_LLM_DEFAULT_MODEL`:

```
# Model for the one-line agent headlines on the Active board. Empty uses
# MULTICA_LLM_DEFAULT_MODEL. Point it at a cheap model behind the same
# OpenAI-compatible base URL.
MULTICA_LLM_SUMMARY_MODEL=
```

In `apps/docs/content/docs/environment-variables.mdx`, add a row after `MULTICA_LLM_DEFAULT_MODEL` in the same table:

```
| `MULTICA_LLM_SUMMARY_MODEL` | Model used for the one-line agent headlines on the Active board. Falls back to `MULTICA_LLM_DEFAULT_MODEL` when empty. Must be served by the same OpenAI-compatible endpoint as `MULTICA_LLM_BASE_URL`. |
```

Add the equivalent row to the `.zh.mdx`, `.ja.mdx`, and `.ko.mdx` files, in the language of each file, following the phrasing of the adjacent `MULTICA_LLM_DEFAULT_MODEL` row in that file.

- [ ] **Step 5: Commit**

```bash
git add server/internal/handler/handler.go server/cmd/server/router.go .env.example apps/docs/content/docs/environment-variables.mdx apps/docs/content/docs/environment-variables.zh.mdx apps/docs/content/docs/environment-variables.ja.mdx apps/docs/content/docs/environment-variables.ko.mdx
git commit -m "feat(agents): configure the summary model with MULTICA_LLM_SUMMARY_MODEL"
```

---

### Task 5: Frontend type and headline preference

**Files:**
- Modify: `packages/core/types/agent.ts` (inside `interface AgentTask`, after `trigger_comment_id`)
- Modify: `packages/views/agents/components/active-board.ts:36-50`
- Modify: `packages/views/agents/components/active-board.test.ts`

**Interfaces:**
- Produces: `AgentTask.pstack_summary?: string | null`; `TaskSummary` gains the source `"pstack_summary"`.

Note for the implementation log: `getAgentTaskSnapshot` in `packages/core/api/client.ts:2345` returns raw JSON with no zod schema today, so there is no schema to extend. The field is optional on the type and every reader optional-chains it. Adding a full task schema to that endpoint is out of scope for this plan.

- [ ] **Step 1: Write the failing test**

Append to `packages/views/agents/components/active-board.test.ts`, inside the existing `describe("taskSummary")` block if there is one, otherwise as a new `describe`:

```ts
describe("taskSummary with pstack_summary", () => {
  it("prefers the generated headline over the handoff note and trigger", () => {
    expect(
      taskSummary(task({ pstack_summary: "Adds a flag.", handoff_note: "note", trigger_summary: "trigger" })),
    ).toEqual({ source: "pstack_summary", text: "Adds a flag." });
  });

  it("ignores a blank or missing headline", () => {
    expect(taskSummary(task({ pstack_summary: "   ", handoff_note: "note" }))).toEqual({
      source: "handoff_note",
      text: "note",
    });
    expect(taskSummary(task({ pstack_summary: null, trigger_summary: "trigger" }))).toEqual({
      source: "trigger_summary",
      text: "trigger",
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @multica/views exec vitest run agents/components/active-board.test.ts
```

Expected: type error on `pstack_summary` or assertion failure with `source: "handoff_note"`.

- [ ] **Step 3: Add the type field**

In `packages/core/types/agent.ts`, inside `interface AgentTask`, directly after the `trigger_comment_id?: string;` line:

```ts
  /**
   * One-time, model-written headline for the Active board: what the task is
   * set to do. Null or absent until the server has generated it, or forever
   * on deployments without an LLM configured. Fork-specific field.
   */
  pstack_summary?: string | null;
```

- [ ] **Step 4: Prefer it in taskSummary**

In `packages/views/agents/components/active-board.ts`, replace the `TaskSummary` type and `taskSummary` function:

```ts
export type TaskSummary =
  | { source: "pstack_summary" | "handoff_note" | "trigger_summary"; text: string }
  | { source: "kind"; kind: NonNullable<AgentTask["kind"]> | "unknown" };

/**
 * The best available one-liner for what a task is about. The generated
 * headline wins; then the assigner's note; then the triggering comment. With
 * none of those, the caller labels the task by how it was created.
 */
export function taskSummary(task: AgentTask): TaskSummary {
  const generated = task.pstack_summary?.trim();
  if (generated) return { source: "pstack_summary", text: generated };
  const note = task.handoff_note?.trim();
  if (note) return { source: "handoff_note", text: note };
  const trigger = task.trigger_summary?.trim();
  if (trigger) return { source: "trigger_summary", text: trigger };
  return { source: "kind", kind: task.kind ?? "unknown" };
}
```

- [ ] **Step 5: Run the tests and typecheck**

```bash
pnpm --filter @multica/views exec vitest run agents/components/active-board.test.ts && pnpm typecheck
```

Expected: PASS, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add packages/core/types/agent.ts packages/views/agents/components/active-board.ts packages/views/agents/components/active-board.test.ts
git commit -m "feat(agents): prefer the generated headline on active board cards"
```

---

### Task 6: Board selectors: describeStep, waiting, sort

**Files:**
- Modify: `packages/views/agents/components/active-board.ts`
- Modify: `packages/views/agents/components/active-board.test.ts`

**Interfaces:**
- Consumes: `TraceStep`, `TraceCallStep`, `TraceMessageStep` from `../../common/task-transcript/build-steps`; `traceToolArgSummary` from `../../common/task-transcript/trace-event-presenter`.
- Produces:
  - `type StepDescription = { verb: StepVerb; object: string; tone: "normal" | "error" }` with `type StepVerb = "edited" | "read" | "ran" | "searched" | "used" | "said" | "errored"`.
  - `function describeStep(step: TraceStep): StepDescription`
  - `const RECENT_TERMINAL_MS = 60 * 60 * 1000`
  - `function isWaitingForInput(task: AgentTask, steps: readonly TraceStep[], now?: number): boolean`
  - `function selectBoardTasks(snapshot: readonly AgentTask[], now?: number): AgentTask[]`: active tasks plus terminal tasks completed within `RECENT_TERMINAL_MS`.
  - `type BoardCard = { task: AgentTask; waiting: boolean; lastActivityAt: string | null }`
  - `function sortBoardCards(cards: readonly BoardCard[]): BoardCard[]`: waiting first, then running by `lastActivityAt` desc, then dispatched and queued by start time desc; recent terminal tasks that are not waiting are dropped.

The verb is a key, not English; the card translates it through i18n.

- [ ] **Step 1: Write the failing tests**

Append to `active-board.test.ts`. Extend the existing `task()` helper if it lacks `completed_at`, `handoff_note`, `trigger_summary`, `pstack_summary` (they are all optional or nullable, so add them as `null`/`undefined` defaults). Add a `step` helper:

```ts
import type { TraceStep } from "../../common/task-transcript/build-steps";
import {
  describeStep,
  isWaitingForInput,
  RECENT_TERMINAL_MS,
  selectBoardTasks,
  sortBoardCards,
} from "./active-board";

function callStep(tool: string, input: Record<string, unknown>, seq = 1): TraceStep {
  return {
    kind: "call",
    seq,
    tool,
    call: { seq, type: "tool_use", tool, input } as never,
    startedAt: "2026-09-03T10:00:00Z",
  };
}

function textStep(content: string, seq = 2): TraceStep {
  return { kind: "text", seq, item: { seq, type: "text", content } as never, startedAt: "2026-09-03T10:00:00Z" };
}

describe("describeStep", () => {
  it("maps file tools to edited/read with the path as object", () => {
    expect(describeStep(callStep("Edit", { file_path: "server/internal/cli/issue_list.go" }))).toEqual({
      verb: "edited",
      object: "server/internal/cli/issue_list.go",
      tone: "normal",
    });
    expect(describeStep(callStep("Write", { file_path: "a.ts" })).verb).toBe("edited");
    expect(describeStep(callStep("Read", { file_path: "a.ts" })).verb).toBe("read");
  });

  it("treats any call with a command string as ran", () => {
    expect(describeStep(callStep("Bash", { command: "go test ./internal/cli" }))).toEqual({
      verb: "ran",
      object: "go test ./internal/cli",
      tone: "normal",
    });
    expect(describeStep(callStep("shell", { command: "pnpm test" })).verb).toBe("ran");
  });

  it("maps search tools to searched", () => {
    expect(describeStep(callStep("Grep", { pattern: "pstack" })).verb).toBe("searched");
    expect(describeStep(callStep("WebSearch", { query: "sqlc narg" })).object).toBe("sqlc narg");
  });

  it("falls back to used with the tool name for unknown tools", () => {
    expect(describeStep(callStep("mcp__linear__get_issue", { id: "MUL-1" }))).toEqual({
      verb: "used",
      object: "mcp__linear__get_issue MUL-1",
      tone: "normal",
    });
  });

  it("renders text as said and errors with the error tone", () => {
    expect(describeStep(textStep("Fixing the sort **now**"))).toEqual({
      verb: "said",
      object: "Fixing the sort now",
      tone: "normal",
    });
    const err: TraceStep = { kind: "error", seq: 3, item: { seq: 3, type: "error", content: "boom" } as never };
    expect(describeStep(err)).toEqual({ verb: "errored", object: "boom", tone: "error" });
  });
});

describe("isWaitingForInput", () => {
  const now = Date.parse("2026-09-03T12:00:00Z");
  const done = task({ status: "completed", completed_at: "2026-09-03T11:30:00Z" });

  it("is true for a recently completed task whose last text asks a question", () => {
    expect(isWaitingForInput(done, [callStep("Edit", {}), textStep("Re-check on every run, or only at creation?")], now)).toBe(true);
  });

  it("is false when the last text is not a question", () => {
    expect(isWaitingForInput(done, [textStep("Done, PR is open.")], now)).toBe(false);
  });

  it("is false past the one hour cut-off", () => {
    const old = task({ status: "completed", completed_at: new Date(now - RECENT_TERMINAL_MS - 1000).toISOString() });
    expect(isWaitingForInput(old, [textStep("Which one?")], now)).toBe(false);
  });

  it("is false for running or failed tasks and when there is no text", () => {
    expect(isWaitingForInput(task({ status: "running" }), [textStep("Which one?")], now)).toBe(false);
    expect(isWaitingForInput(task({ status: "failed", completed_at: "2026-09-03T11:59:00Z" }), [textStep("Which one?")], now)).toBe(false);
    expect(isWaitingForInput(done, [callStep("Edit", {})], now)).toBe(false);
  });
});

describe("selectBoardTasks and sortBoardCards", () => {
  const now = Date.parse("2026-09-03T12:00:00Z");

  it("keeps active tasks and recently completed ones, drops old terminal tasks", () => {
    const snapshot = [
      task({ id: "run", status: "running" }),
      task({ id: "recent", status: "completed", completed_at: "2026-09-03T11:50:00Z" }),
      task({ id: "old", status: "completed", completed_at: "2026-09-03T09:00:00Z" }),
      task({ id: "cancelled", status: "cancelled", completed_at: "2026-09-03T11:59:00Z" }),
    ];
    expect(selectBoardTasks(snapshot, now).map((t) => t.id)).toEqual(["run", "recent"]);
  });

  it("orders waiting, then running by activity, then queued; drops non-waiting terminal tasks", () => {
    const cards = [
      { task: task({ id: "q", status: "queued", created_at: "2026-09-03T11:00:00Z" }), waiting: false, lastActivityAt: null },
      { task: task({ id: "r-old", status: "running" }), waiting: false, lastActivityAt: "2026-09-03T11:10:00Z" },
      { task: task({ id: "done", status: "completed", completed_at: "2026-09-03T11:55:00Z" }), waiting: false, lastActivityAt: null },
      { task: task({ id: "w", status: "completed", completed_at: "2026-09-03T11:50:00Z" }), waiting: true, lastActivityAt: null },
      { task: task({ id: "r-new", status: "running" }), waiting: false, lastActivityAt: "2026-09-03T11:59:00Z" },
    ];
    expect(sortBoardCards(cards).map((c) => c.task.id)).toEqual(["w", "r-new", "r-old", "q"]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm --filter @multica/views exec vitest run agents/components/active-board.test.ts
```

Expected: import failures for the new exports.

- [ ] **Step 3: Implement the selectors**

Append to `packages/views/agents/components/active-board.ts` (add the two imports at the top of the file):

```ts
import type { TraceStep } from "../../common/task-transcript/build-steps";
import { traceToolArgSummary } from "../../common/task-transcript/trace-event-presenter";

export type StepVerb = "edited" | "read" | "ran" | "searched" | "used" | "said" | "errored";

export interface StepDescription {
  /** i18n key under active_board.step; the card translates it. */
  verb: StepVerb;
  object: string;
  tone: "normal" | "error";
}

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "apply_patch", "edit_file", "write_file"]);
const READ_TOOLS = new Set(["Read", "read_file", "view", "cat"]);
const SEARCH_TOOLS = new Set(["Grep", "Glob", "WebSearch", "WebFetch", "search", "grep", "glob", "find"]);

/**
 * One transcript step as a verb and an object, ready to read as a sentence.
 * Shell-like calls are recognised by a `command` input, not a tool allowlist,
 * so the rule holds across agent backends.
 */
export function describeStep(step: TraceStep): StepDescription {
  if (step.kind === "call") {
    const input = step.call?.input as Record<string, unknown> | undefined;
    const summary = traceToolArgSummary(input);
    if (typeof input?.command === "string") return { verb: "ran", object: summary, tone: "normal" };
    if (EDIT_TOOLS.has(step.tool)) return { verb: "edited", object: summary, tone: "normal" };
    if (READ_TOOLS.has(step.tool)) return { verb: "read", object: summary, tone: "normal" };
    if (SEARCH_TOOLS.has(step.tool)) return { verb: "searched", object: summary, tone: "normal" };
    return { verb: "used", object: [step.tool, summary].filter(Boolean).join(" "), tone: "normal" };
  }
  const text = plainSummary(step.item.content ?? "");
  if (step.kind === "error") return { verb: "errored", object: text, tone: "error" };
  return { verb: "said", object: text, tone: "normal" };
}

/** A completed task stays on the board this long, so a question is not missed. */
export const RECENT_TERMINAL_MS = 60 * 60 * 1000;

function completedWithin(task: AgentTask, windowMs: number, now: number): boolean {
  if (!task.completed_at) return false;
  return now - new Date(task.completed_at).getTime() <= windowMs;
}

/**
 * A finished run whose last words were a question is blocked on a person.
 * Only completed tasks qualify: a failed run is an error, not a question.
 */
export function isWaitingForInput(task: AgentTask, steps: readonly TraceStep[], now: number = Date.now()): boolean {
  if (task.status !== "completed" || !completedWithin(task, RECENT_TERMINAL_MS, now)) return false;
  const lastText = steps.filter((s) => s.kind === "text").at(-1);
  if (!lastText || lastText.kind !== "text") return false;
  return /[?？]\s*$/.test(plainSummary(lastText.item.content ?? ""));
}

/** Active tasks plus completed tasks recent enough to still be waiting on someone. */
export function selectBoardTasks(snapshot: readonly AgentTask[], now: number = Date.now()): AgentTask[] {
  return snapshot.filter(
    (t) => ACTIVE_STATUSES.has(t.status) || (t.status === "completed" && completedWithin(t, RECENT_TERMINAL_MS, now)),
  );
}

export interface BoardCard {
  task: AgentTask;
  waiting: boolean;
  /** Last transcript activity for running tasks; null when unknown. */
  lastActivityAt: string | null;
}

/**
 * Waiting cards first, then running by most recent activity, then dispatched
 * and queued by start time. A recent terminal task that is not waiting has
 * nothing to show and is dropped.
 */
export function sortBoardCards(cards: readonly BoardCard[]): BoardCard[] {
  const startOf = (t: AgentTask) => t.started_at ?? t.dispatched_at ?? t.created_at;
  return cards
    .filter((c) => c.waiting || ACTIVE_STATUSES.has(c.task.status))
    .sort((a, b) => {
      if (a.waiting !== b.waiting) return a.waiting ? -1 : 1;
      const rank = (STATUS_RANK[a.task.status] ?? 9) - (STATUS_RANK[b.task.status] ?? 9);
      if (rank !== 0) return rank;
      const aAt = a.lastActivityAt ?? startOf(a.task);
      const bAt = b.lastActivityAt ?? startOf(b.task);
      return bAt.localeCompare(aAt);
    });
}
```

- [ ] **Step 4: Run the tests**

```bash
pnpm --filter @multica/views exec vitest run agents/components/active-board.test.ts && pnpm typecheck
```

Expected: PASS, typecheck clean. If `step.item.content` is not on `TimelineItem`, open `packages/views/common/task-transcript/build-timeline.ts` and use the field that carries text there.

- [ ] **Step 5: Commit**

```bash
git add packages/views/agents/components/active-board.ts packages/views/agents/components/active-board.test.ts
git commit -m "feat(agents): describe transcript steps and derive waiting cards for the active board"
```

---

### Task 7: Conversation grouping for the agent window (pure)

**Files:**
- Create: `packages/views/agents/components/agent-window-conversation.ts`
- Create: `packages/views/agents/components/agent-window-conversation.test.ts`

**Interfaces:**
- Consumes: `TraceStep`, `TraceCallStep` from `../../common/task-transcript/build-steps`; `describeStep`, `StepDescription` from `./active-board`.
- Produces:
  - `type ConversationBlock = { kind: "agent_text"; seq: number; text: string; at?: string } | { kind: "files"; seq: number; paths: string[] } | { kind: "commands"; seq: number; runs: { command: string; ok: boolean | null; seq: number }[] } | { kind: "other"; seq: number; steps: StepDescription[] } | { kind: "error"; seq: number; text: string }`
  - `function buildConversation(steps: readonly TraceStep[]): ConversationBlock[]`

- [ ] **Step 1: Write the failing tests**

`packages/views/agents/components/agent-window-conversation.test.ts`:

```ts
// @vitest-environment node
import { describe, it, expect } from "vitest";
import type { TraceStep } from "../../common/task-transcript/build-steps";
import { buildConversation } from "./agent-window-conversation";

let seq = 0;
function call(tool: string, input: Record<string, unknown>, output?: string, isError = false): TraceStep {
  seq += 1;
  return {
    kind: "call",
    seq,
    tool,
    call: { seq, type: "tool_use", tool, input } as never,
    result: output === undefined ? undefined : ({ seq: seq + 100, type: "tool_result", output, is_error: isError } as never),
  };
}
function text(content: string): TraceStep {
  seq += 1;
  return { kind: "text", seq, item: { seq, type: "text", content } as never, startedAt: "2026-09-03T10:00:00Z" };
}
function error(content: string): TraceStep {
  seq += 1;
  return { kind: "error", seq, item: { seq, type: "error", content } as never };
}

describe("buildConversation", () => {
  it("keeps agent text as bubbles and folds tool runs between them into typed blocks", () => {
    const blocks = buildConversation([
      text("Reading the list command first."),
      call("Read", { file_path: "a.go" }),
      call("Edit", { file_path: "a.go" }),
      call("Edit", { file_path: "a_test.go" }),
      call("Edit", { file_path: "a.go" }),
      call("Bash", { command: "go test ./..." }, "ok"),
      call("mcp__linear__get_issue", { id: "MUL-1" }),
      text("Tests pass."),
    ]);
    expect(blocks.map((b) => b.kind)).toEqual(["agent_text", "files", "commands", "other", "agent_text"]);
    expect(blocks[1]).toMatchObject({ kind: "files", paths: ["a.go", "a_test.go"] });
    expect(blocks[2]).toMatchObject({ kind: "commands", runs: [{ command: "go test ./...", ok: true }] });
    expect(blocks[3]).toMatchObject({ kind: "other", steps: [{ verb: "read" }, { verb: "used" }] });
  });

  it("marks a failed command and surfaces errors as their own block", () => {
    const blocks = buildConversation([
      call("Bash", { command: "pnpm test" }, "1 failed", true),
      error("Tool crashed"),
    ]);
    expect(blocks[0]).toMatchObject({ kind: "commands", runs: [{ command: "pnpm test", ok: false }] });
    expect(blocks[1]).toMatchObject({ kind: "error", text: "Tool crashed" });
  });

  it("reports unknown outcome as null and skips thinking", () => {
    const thinking: TraceStep = { kind: "thinking", seq: 99, item: { seq: 99, type: "thinking", content: "hmm" } as never };
    const blocks = buildConversation([thinking, call("Bash", { command: "make up" })]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: "commands", runs: [{ command: "make up", ok: null }] });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm --filter @multica/views exec vitest run agents/components/agent-window-conversation.test.ts
```

Expected: cannot find module `./agent-window-conversation`.

- [ ] **Step 3: Implement**

`packages/views/agents/components/agent-window-conversation.ts`:

```ts
import type { TraceCallStep, TraceStep } from "../../common/task-transcript/build-steps";
import { describeStep, plainSummary, type StepDescription } from "./active-board";

export type ConversationBlock =
  | { kind: "agent_text"; seq: number; text: string; at?: string }
  | { kind: "files"; seq: number; paths: string[] }
  | { kind: "commands"; seq: number; runs: { command: string; ok: boolean | null; seq: number }[] }
  | { kind: "other"; seq: number; steps: StepDescription[] }
  | { kind: "error"; seq: number; text: string };

function commandOutcome(step: TraceCallStep): boolean | null {
  const result = step.result as { is_error?: boolean } | undefined;
  if (!result) return null;
  return result.is_error === true ? false : true;
}

/**
 * Fold a transcript into the shape a conversation reads in: agent prose as
 * bubbles, and the tool work between two bubbles as at most three blocks in
 * a fixed order (files, commands, everything else). Thinking is dropped.
 */
export function buildConversation(steps: readonly TraceStep[]): ConversationBlock[] {
  const blocks: ConversationBlock[] = [];
  let pending: TraceCallStep[] = [];

  const flush = () => {
    if (pending.length === 0) return;
    const firstSeq = pending[0].seq;
    const paths = new Set<string>();
    const runs: { command: string; ok: boolean | null; seq: number }[] = [];
    const other: StepDescription[] = [];
    for (const step of pending) {
      const d = describeStep(step);
      if (d.verb === "edited" && d.object) paths.add(d.object);
      else if (d.verb === "ran") runs.push({ command: d.object, ok: commandOutcome(step), seq: step.seq });
      else other.push(d);
    }
    if (paths.size > 0) blocks.push({ kind: "files", seq: firstSeq, paths: [...paths] });
    if (runs.length > 0) blocks.push({ kind: "commands", seq: firstSeq, runs });
    if (other.length > 0) blocks.push({ kind: "other", seq: firstSeq, steps: other });
    pending = [];
  };

  for (const step of steps) {
    if (step.kind === "thinking") continue;
    if (step.kind === "call") {
      pending.push(step);
      continue;
    }
    flush();
    const text = plainSummary(step.item.content ?? "");
    if (step.kind === "error") blocks.push({ kind: "error", seq: step.seq, text });
    else blocks.push({ kind: "agent_text", seq: step.seq, text, at: step.startedAt });
  }
  flush();
  return blocks;
}
```

- [ ] **Step 4: Run the tests**

```bash
pnpm --filter @multica/views exec vitest run agents/components/agent-window-conversation.test.ts && pnpm typecheck
```

Expected: PASS. If the result item's error flag has a different name on `TimelineItem`, read `build-timeline.ts` and use that field in `commandOutcome`.

- [ ] **Step 5: Commit**

```bash
git add packages/views/agents/components/agent-window-conversation.ts packages/views/agents/components/agent-window-conversation.test.ts
git commit -m "feat(agents): fold a task transcript into conversation blocks"
```

---

### Task 8: Locale strings

**Files:**
- Modify: `packages/views/locales/en/agents.json`, `ja/agents.json`, `ko/agents.json`, `zh-Hans/agents.json` (the `active_board` object in each)

**Interfaces:**
- Produces the keys used by Tasks 9 to 11: `active_board.waiting_for_you`, `active_board.stale_for`, `active_board.open_issue`, `active_board.stop`, `active_board.reply`, `active_board.click_to_open`, `active_board.completed_ago`, `active_board.step.{edited,read,ran,searched,used,said,errored}`, `active_board.window.{title,trigger_label,files_changed,other_steps,composer_placeholder,composer_running_hint,send}`.

- [ ] **Step 1: Add the English keys**

Inside `active_board` in `packages/views/locales/en/agents.json`, add:

```json
"waiting_for_you": "Waiting for you",
"stale_for": "No activity for {{duration}}",
"completed_ago": "finished {{ago}}",
"open_issue": "Open issue",
"stop": "Stop",
"reply": "Reply",
"click_to_open": "Click to open",
"step": {
  "edited": "Edited {{object}}",
  "read": "Read {{object}}",
  "ran": "Ran {{object}}",
  "searched": "Searched for {{object}}",
  "used": "Used {{object}}",
  "said": "{{object}}",
  "errored": "Error: {{object}}"
},
"window": {
  "title": "{{agent}} on {{issue}}",
  "trigger_label": "{{actor}} · assigned the issue",
  "files_changed_one": "{{count}} file changed",
  "files_changed_other": "{{count}} files changed",
  "other_steps_one": "{{count}} other step",
  "other_steps_other": "{{count}} other steps",
  "composer_placeholder": "Comment on {{issue}} as a reply to {{agent}}…",
  "composer_running_hint": "The agent picks this up after its current run.",
  "send": "Send"
}
```

- [ ] **Step 2: Add the other locales**

Read `apps/docs/content/docs/developers/conventions.mdx` for the Chinese product voice, then add the same keys to `zh-Hans`, `ja`, and `ko`:

zh-Hans:

```json
"waiting_for_you": "等你回复",
"stale_for": "已 {{duration}} 无活动",
"completed_ago": "{{ago}}完成",
"open_issue": "打开 Issue",
"stop": "停止",
"reply": "回复",
"click_to_open": "点击打开",
"step": {
  "edited": "编辑了 {{object}}",
  "read": "读取了 {{object}}",
  "ran": "运行了 {{object}}",
  "searched": "搜索了 {{object}}",
  "used": "使用了 {{object}}",
  "said": "{{object}}",
  "errored": "错误：{{object}}"
},
"window": {
  "title": "{{agent}} · {{issue}}",
  "trigger_label": "{{actor}} · 分配了该 Issue",
  "files_changed_one": "更改了 {{count}} 个文件",
  "files_changed_other": "更改了 {{count}} 个文件",
  "other_steps_one": "另外 {{count}} 个步骤",
  "other_steps_other": "另外 {{count}} 个步骤",
  "composer_placeholder": "在 {{issue}} 中回复 {{agent}}…",
  "composer_running_hint": "Agent 会在本次运行结束后处理这条评论。",
  "send": "发送"
}
```

ja:

```json
"waiting_for_you": "あなたの返信待ち",
"stale_for": "{{duration}}間アクティビティなし",
"completed_ago": "{{ago}}に完了",
"open_issue": "Issue を開く",
"stop": "停止",
"reply": "返信",
"click_to_open": "クリックして開く",
"step": {
  "edited": "{{object}} を編集",
  "read": "{{object}} を読み取り",
  "ran": "{{object}} を実行",
  "searched": "{{object}} を検索",
  "used": "{{object}} を使用",
  "said": "{{object}}",
  "errored": "エラー: {{object}}"
},
"window": {
  "title": "{{agent}} · {{issue}}",
  "trigger_label": "{{actor}} · Issue を割り当て",
  "files_changed_one": "{{count}} ファイルを変更",
  "files_changed_other": "{{count}} ファイルを変更",
  "other_steps_one": "その他 {{count}} ステップ",
  "other_steps_other": "その他 {{count}} ステップ",
  "composer_placeholder": "{{issue}} で {{agent}} に返信…",
  "composer_running_hint": "エージェントは現在の実行が終わった後にこのコメントを処理します。",
  "send": "送信"
}
```

ko:

```json
"waiting_for_you": "회신 대기 중",
"stale_for": "{{duration}} 동안 활동 없음",
"completed_ago": "{{ago}} 완료",
"open_issue": "이슈 열기",
"stop": "중지",
"reply": "답장",
"click_to_open": "클릭하여 열기",
"step": {
  "edited": "{{object}} 편집",
  "read": "{{object}} 읽기",
  "ran": "{{object}} 실행",
  "searched": "{{object}} 검색",
  "used": "{{object}} 사용",
  "said": "{{object}}",
  "errored": "오류: {{object}}"
},
"window": {
  "title": "{{agent}} · {{issue}}",
  "trigger_label": "{{actor}} · 이슈 할당",
  "files_changed_one": "파일 {{count}}개 변경",
  "files_changed_other": "파일 {{count}}개 변경",
  "other_steps_one": "기타 {{count}}단계",
  "other_steps_other": "기타 {{count}}단계",
  "composer_placeholder": "{{issue}}에서 {{agent}}에게 답장…",
  "composer_running_hint": "에이전트는 현재 실행이 끝난 뒤 이 댓글을 처리합니다.",
  "send": "보내기"
}
```

- [ ] **Step 3: Run the parity test**

```bash
pnpm --filter @multica/views exec vitest run locales/parity.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/views/locales/en/agents.json packages/views/locales/ja/agents.json packages/views/locales/ko/agents.json packages/views/locales/zh-Hans/agents.json
git commit -m "feat(agents): add active board grid and agent window strings"
```

---

### Task 9: The grid card

**Files:**
- Rewrite: `packages/views/agents/components/active-task-card.tsx`
- Modify: `packages/views/agents/components/active-board-page.test.tsx` (the card is tested through the page in Task 11; this task only needs typecheck)

**Interfaces:**
- Consumes: `taskSummary`, `plainSummary`, `describeStep`, `isStale`, `type BoardCard` from `./active-board`; `useTimeAgo`, `useT` from `../../i18n`; `ActorAvatar`; `TranscriptButton`; `agentListOptions`; `issueDetailOptions`; `useWorkspacePaths`.
- Produces:

```ts
export interface ActiveTaskCardProps {
  wsId: string;
  card: BoardCard;
  /** Latest non-thinking step for the "right now" line; null when none. */
  lastStep: TraceStep | null;
  onOpen: (taskId: string) => void;
  onStop?: (taskId: string) => void;
}
export function ActiveTaskCard(props: ActiveTaskCardProps): JSX.Element
```

The card no longer subscribes to messages itself. The page owns the transcript queries (Task 11) so it can sort and detect waiting; it passes the last step down. This is the one structural change from today's card.

- [ ] **Step 1: Rewrite the card**

Replace the contents of `packages/views/agents/components/active-task-card.tsx`:

```tsx
"use client";

import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import { Button } from "@multica/ui/components/ui/button";
import { cn } from "@multica/ui/lib/utils";
import { agentListOptions } from "@multica/core/workspace/queries";
import { issueDetailOptions } from "@multica/core/issues";
import { useWorkspacePaths } from "@multica/core/paths";
import type { AgentTask } from "@multica/core/types";
import { ActorAvatar } from "../../common/actor-avatar";
import type { TraceStep } from "../../common/task-transcript/build-steps";
import { TranscriptButton } from "../../common/task-transcript/transcript-button";
import { AppLink } from "../../navigation";
import { useT, useTimeAgo } from "../../i18n";
import { describeStep, isStale, plainSummary, taskSummary, type BoardCard } from "./active-board";

export interface ActiveTaskCardProps {
  wsId: string;
  card: BoardCard;
  /** Latest non-thinking transcript step; null when the run has none yet. */
  lastStep: TraceStep | null;
  onOpen: (taskId: string) => void;
  onStop?: (taskId: string) => void;
}

type ActiveStatus = "running" | "waiting_local_directory" | "dispatched" | "queued";

/**
 * One agent on the Active grid: who, on which issue, the generated headline,
 * and one line for what it is doing right now. The whole card opens the agent
 * window; the footer actions do not.
 */
export function ActiveTaskCard({ wsId, card, lastStep, onOpen, onStop }: ActiveTaskCardProps) {
  const { t } = useT("agents");
  const timeAgo = useTimeAgo();
  const p = useWorkspacePaths();
  const { task, waiting, lastActivityAt } = card;
  const { data: agents = [] } = useQuery(agentListOptions(wsId));
  const agent = agents.find((a) => a.id === task.agent_id);
  const { data: issue } = useQuery({ ...issueDetailOptions(wsId, task.issue_id), enabled: !!task.issue_id });
  const isRunning = task.status === "running";

  const summary = taskSummary(task);
  const headline =
    summary.source === "kind" ? t(($) => $.active_board.kind[summary.kind]) : plainSummary(summary.text);

  const startedAt = task.started_at ?? task.dispatched_at ?? task.created_at;
  const stale = isRunning && isStale(lastActivityAt ?? startedAt);
  const description = lastStep ? describeStep(lastStep) : null;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(task.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(task.id);
        }
      }}
      className={cn(
        "flex min-w-0 cursor-pointer flex-col gap-3 rounded-lg border bg-card p-4 text-left transition-colors hover:bg-accent/40",
        waiting && "border-warning/40",
      )}
    >
      <div className="flex items-center gap-2.5">
        <ActorAvatar actorType="agent" actorId={task.agent_id} size="sm" profileLink={false} />
        {agent ? (
          <span className="truncate text-body font-semibold">{agent.name}</span>
        ) : (
          <Skeleton className="h-4 w-24" />
        )}
        {task.issue_id &&
          (issue ? (
            <AppLink
              href={p.issueDetail(task.issue_id)}
              onClick={(e: React.MouseEvent) => e.stopPropagation()}
              className="truncate font-mono text-label text-muted-foreground hover:underline"
              title={issue.title}
            >
              {issue.identifier}
            </AppLink>
          ) : (
            <Skeleton className="h-4 w-16" />
          ))}
        <StatusPill task={task} waiting={waiting} stale={stale} startedAt={startedAt} />
      </div>

      <p className="line-clamp-3 text-body text-foreground">{headline}</p>

      {(isRunning || waiting) && (
        <div
          className={cn(
            "flex min-w-0 items-baseline gap-2 text-label",
            stale ? "text-warning" : description?.tone === "error" ? "text-destructive" : "text-muted-foreground",
          )}
        >
          <span
            className={cn(
              "size-1.5 shrink-0 self-center rounded-full",
              stale || waiting ? "bg-warning" : "animate-pulse bg-success",
            )}
          />
          <span className="min-w-0 flex-1 truncate">
            {stale && lastActivityAt
              ? t(($) => $.active_board.stale_for, { duration: timeAgo(lastActivityAt) })
              : description
                ? t(($) => $.active_board.step[description.verb], { object: description.object })
                : t(($) => $.active_board.waiting_for_activity)}
          </span>
          {lastActivityAt && (
            <span className="shrink-0 font-mono text-caption text-muted-foreground">{timeAgo(lastActivityAt)}</span>
          )}
        </div>
      )}

      <div className="flex items-center gap-2 pt-1" onClick={(e) => e.stopPropagation()}>
        <span className="text-caption text-muted-foreground">{t(($) => $.active_board.click_to_open)}</span>
        <div className="ml-auto flex items-center gap-1.5">
          {task.issue_id && (
            <Button variant="secondary" size="sm" render={<AppLink href={p.issueDetail(task.issue_id)} />}>
              {t(($) => $.active_board.open_issue)}
            </Button>
          )}
          {agent && (
            <TranscriptButton
              task={task}
              agentName={agent.name}
              isLive={isRunning}
              title={t(($) => $.active_board.view_transcript)}
            />
          )}
          {waiting ? (
            <Button variant="secondary" size="sm" onClick={() => onOpen(task.id)}>
              {t(($) => $.active_board.reply)}
            </Button>
          ) : (
            onStop &&
            isRunning && (
              <Button variant="ghost" size="sm" className="text-destructive" onClick={() => onStop(task.id)}>
                {t(($) => $.active_board.stop)}
              </Button>
            )
          )}
        </div>
      </div>
    </div>
  );
}

function StatusPill({
  task,
  waiting,
  stale,
  startedAt,
}: {
  task: AgentTask;
  waiting: boolean;
  stale: boolean;
  startedAt: string;
}) {
  const { t } = useT("agents");
  const timeAgo = useTimeAgo();
  const tone = waiting || stale ? "bg-warning/15 text-warning" : task.status === "running" ? "bg-success/15 text-success" : "bg-muted text-muted-foreground";
  const label = waiting
    ? t(($) => $.active_board.waiting_for_you)
    : task.status === "completed"
      ? t(($) => $.active_board.completed_ago, { ago: timeAgo(task.completed_at ?? startedAt) })
      : `${t(($) => $.active_board.status[task.status as ActiveStatus])} · ${timeAgo(startedAt)}`;
  return (
    <span className={cn("ml-auto shrink-0 rounded-full px-2.5 py-0.5 text-caption font-medium", tone)}>{label}</span>
  );
}
```

Check `packages/ui/components/ui/button.tsx` for how a Button renders as a link in this repo (`render` prop on Base UI, or `asChild`), and match it. Check whether `bg-warning`, `text-success` utilities exist in `packages/ui/styles`; they are used by the current card's `StatusDot`, so `bg-warning` and `bg-success` do. If `text-success` or `bg-success/15` is missing, add the semantic token class the same way the existing ones are defined rather than a hardcoded colour.

- [ ] **Step 2: Typecheck**

```bash
pnpm typecheck
```

Expected: errors only in `active-board-page.tsx` (it still passes the old props). Task 11 fixes that. If there are errors inside the card itself, fix them now.

- [ ] **Step 3: Commit**

```bash
git add packages/views/agents/components/active-task-card.tsx
git commit -m "feat(agents): redesign the active board card for the grid"
```

---

### Task 10: The agent window

**Files:**
- Create: `packages/views/agents/components/agent-window.tsx`
- Create: `packages/views/agents/components/agent-window.test.tsx`

**Interfaces:**
- Consumes: `buildConversation`, `ConversationBlock` (Task 7); `describeStep`, `taskSummary`, `plainSummary` (Tasks 5 and 6); `useCreateComment(issueId)` from `@multica/core/issues` (`mutate({ content })`); `Dialog`, `DialogContent`, `DialogTitle` from `@multica/ui/components/ui/dialog`; `TranscriptButton`; `ActorAvatar`; `agentListOptions`; `issueDetailOptions`; `taskMessagesOptions`; `buildTimeline`, `buildSteps`.
- Produces:

```ts
export interface AgentWindowProps {
  wsId: string;
  task: AgentTask | null;   // null closes the window
  onClose: () => void;
}
export function AgentWindow(props: AgentWindowProps): JSX.Element
```

- [ ] **Step 1: Write the failing component test**

`packages/views/agents/components/agent-window.test.tsx`:

```tsx
// @vitest-environment jsdom

// Block folding rules live in agent-window-conversation.test.ts. This suite
// keeps the wiring: bubbles and blocks render, the composer is disabled while
// running and posts a comment otherwise.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { I18nProvider } from "@multica/core/i18n/react";
import enCommon from "../../locales/en/common.json";
import enAgents from "../../locales/en/agents.json";
import type { AgentTask } from "@multica/core/types";

const TEST_RESOURCES = { en: { common: enCommon, agents: enAgents } };

const mutate = vi.fn();
vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("@multica/core/api", () => ({ api: { getBaseUrl: () => "http://127.0.0.1:8080" } }));
vi.mock("@multica/core/issues", () => ({
  issueDetailOptions: (wsId: string, id: string) => ({ queryKey: ["issues", wsId, "detail", id] }),
  useCreateComment: () => ({ mutate, isPending: false }),
}));
vi.mock("../../common/actor-avatar", () => ({ ActorAvatar: () => <span /> }));
vi.mock("../../common/task-transcript/transcript-button", () => ({ TranscriptButton: () => <button>transcript</button> }));

const mockMessages = vi.hoisted(() => ({ current: [] as unknown[] }));
vi.mock("@tanstack/react-query", () => ({
  queryOptions: (o: unknown) => o,
  useQuery: (opts: { queryKey: readonly unknown[] }) => {
    const [root, , marker] = opts.queryKey;
    if (root === "workspaces" && marker === "agents") return { data: [{ id: "a1", name: "Codex" }] };
    if (root === "issues" && marker === "detail") return { data: { id: "i1", identifier: "MUL-1", title: "Add flag" } };
    if (root === "task-messages") return { data: mockMessages.current };
    return { data: undefined };
  },
}));

import { AgentWindow } from "./agent-window";

function task(over: Partial<AgentTask>): AgentTask {
  return {
    id: "t1",
    agent_id: "a1",
    runtime_id: "r1",
    issue_id: "i1",
    status: "running",
    priority: 0,
    dispatched_at: null,
    started_at: "2026-09-03T10:00:00Z",
    completed_at: null,
    result: null,
    error: null,
    created_at: "2026-09-03T09:59:00Z",
    trigger_summary: "Please add the flag",
    ...over,
  } as AgentTask;
}

function renderWindow(t: AgentTask | null, onClose = vi.fn()) {
  return render(
    <I18nProvider resources={TEST_RESOURCES} lng="en">
      <AgentWindow wsId="ws-1" task={t} onClose={onClose} />
    </I18nProvider>,
  );
}

describe("AgentWindow", () => {
  beforeEach(() => {
    mutate.mockReset();
    mockMessages.current = [
      { seq: 1, type: "text", content: "Reading the list command." },
      { seq: 2, type: "tool_use", tool: "Edit", input: { file_path: "a.go" } },
      { seq: 3, type: "tool_use", tool: "Bash", input: { command: "go test ./..." } },
      { seq: 4, type: "tool_result", output: "ok" },
    ];
  });
  afterEach(cleanup);

  it("renders the trigger, agent text, and folded blocks", () => {
    renderWindow(task({}));
    expect(screen.getByText("Please add the flag")).toBeTruthy();
    expect(screen.getByText("Reading the list command.")).toBeTruthy();
    expect(screen.getByText("1 file changed")).toBeTruthy();
    expect(screen.getByText("go test ./...")).toBeTruthy();
  });

  it("disables the composer while the task runs", () => {
    renderWindow(task({ status: "running" }));
    expect(screen.getByRole("textbox")).toHaveProperty("disabled", true);
    expect(screen.getByText("The agent picks this up after its current run.")).toBeTruthy();
  });

  it("posts a comment when the task is finished", () => {
    renderWindow(task({ status: "completed", completed_at: "2026-09-03T10:30:00Z" }));
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "Every run, please." } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(mutate).toHaveBeenCalledWith({ content: "Every run, please." }, expect.anything());
  });

  it("renders nothing when task is null", () => {
    renderWindow(null);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
```

Check how `I18nProvider` is constructed in `active-board-page.test.tsx` (its props) and match it exactly.

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @multica/views exec vitest run agents/components/agent-window.test.tsx
```

Expected: cannot find module `./agent-window`.

- [ ] **Step 3: Implement the window**

`packages/views/agents/components/agent-window.tsx`:

```tsx
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogTitle } from "@multica/ui/components/ui/dialog";
import { Button } from "@multica/ui/components/ui/button";
import { Textarea } from "@multica/ui/components/ui/textarea";
import { cn } from "@multica/ui/lib/utils";
import { agentListOptions } from "@multica/core/workspace/queries";
import { issueDetailOptions, useCreateComment } from "@multica/core/issues";
import { taskMessagesOptions } from "@multica/core/chat/queries";
import type { AgentTask } from "@multica/core/types";
import { ActorAvatar } from "../../common/actor-avatar";
import { buildTimeline } from "../../common/task-transcript/build-timeline";
import { buildSteps } from "../../common/task-transcript/build-steps";
import { TranscriptButton } from "../../common/task-transcript/transcript-button";
import { useT, useTimeAgo } from "../../i18n";
import { describeStep, plainSummary, taskSummary } from "./active-board";
import { buildConversation, type ConversationBlock } from "./agent-window-conversation";

export interface AgentWindowProps {
  wsId: string;
  /** The task to show; null closes the window. */
  task: AgentTask | null;
  onClose: () => void;
}

/**
 * A task's transcript read as a conversation with the agent, over the grid.
 * The composer posts an issue comment, which is how a person reaches an agent
 * in Multica; while the run is live it is disabled, since a comment cannot
 * join a run in progress.
 */
export function AgentWindow({ wsId, task, onClose }: AgentWindowProps) {
  return (
    <Dialog open={task !== null} onOpenChange={(open) => !open && onClose()}>
      {task && <AgentWindowBody wsId={wsId} task={task} />}
    </Dialog>
  );
}

function AgentWindowBody({ wsId, task }: { wsId: string; task: AgentTask }) {
  const { t } = useT("agents");
  const timeAgo = useTimeAgo();
  const isRunning = task.status === "running";
  const { data: agents = [] } = useQuery(agentListOptions(wsId));
  const agent = agents.find((a) => a.id === task.agent_id);
  const { data: issue } = useQuery({ ...issueDetailOptions(wsId, task.issue_id), enabled: !!task.issue_id });
  const { data: messages = [] } = useQuery(taskMessagesOptions(task.id));

  const steps = useMemo(() => buildSteps(buildTimeline(messages)), [messages]);
  const blocks = useMemo(() => buildConversation(steps), [steps]);
  const current = useMemo(() => {
    const last = steps.filter((s) => s.kind !== "thinking").at(-1);
    return last ? describeStep(last) : null;
  }, [steps]);

  const summary = taskSummary(task);
  const trigger =
    summary.source === "kind" ? t(($) => $.active_board.kind[summary.kind]) : plainSummary(summary.text);

  const scrollerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    // Follow the live end while it is within reach; a reader scrolled up stays put.
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 120) el.scrollTop = el.scrollHeight;
  }, [blocks.length, current?.object]);

  const [draft, setDraft] = useState("");
  const createComment = useCreateComment(task.issue_id);
  const canSend = !isRunning && !!task.issue_id && draft.trim().length > 0 && !createComment.isPending;
  const send = () => {
    if (!canSend) return;
    createComment.mutate({ content: draft.trim() }, { onSuccess: () => setDraft("") });
  };

  const agentName = agent?.name ?? "";
  const issueLabel = issue?.identifier ?? "";

  return (
    <DialogContent
      className="!max-w-[920px] !w-[calc(100vw-4rem)] !max-h-[calc(100vh-4rem)] !h-[760px] flex flex-col !p-0 !gap-0 overflow-hidden"
      showCloseButton
    >
      <DialogTitle className="sr-only">
        {t(($) => $.active_board.window.title, { agent: agentName, issue: issueLabel })}
      </DialogTitle>

      <div className="flex items-center gap-3 border-b px-5 py-4">
        <ActorAvatar actorType="agent" actorId={task.agent_id} size="md" profileLink={false} />
        <div className="flex min-w-0 flex-col">
          <span className="text-body-lg font-semibold">{agentName}</span>
          <span className="truncate text-label text-muted-foreground">
            {issue ? `${issue.identifier} · ${issue.title}` : t(($) => $.active_board.no_issue)}
          </span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {agent && (
            <TranscriptButton task={task} agentName={agent.name} isLive={isRunning} title={t(($) => $.active_board.view_transcript)} />
          )}
        </div>
      </div>

      <div ref={scrollerRef} className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-5 py-5">
        <div className="flex max-w-[70%] flex-col items-end gap-1 self-end">
          <span className="text-micro text-muted-foreground">
            {t(($) => $.active_board.window.trigger_label, { actor: "", })} {timeAgo(task.created_at)}
          </span>
          <div className="rounded-2xl rounded-br-sm bg-accent px-3.5 py-2.5 text-body">{trigger}</div>
        </div>

        {blocks.map((block) => (
          <Block key={`${block.kind}-${block.seq}`} block={block} />
        ))}

        {isRunning && current && (
          <div className="flex items-center gap-2 px-3.5 py-1.5 text-label text-muted-foreground">
            <span className="size-1.5 rounded-full bg-muted-foreground" />
            <span className="size-1.5 rounded-full bg-muted-foreground/60" />
            <span className="size-1.5 rounded-full bg-muted-foreground/30" />
            <span className="truncate">{t(($) => $.active_board.step[current.verb], { object: current.object })}</span>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-2 border-t px-5 py-4">
        <Textarea
          aria-label={t(($) => $.active_board.window.composer_placeholder, { issue: issueLabel, agent: agentName })}
          placeholder={t(($) => $.active_board.window.composer_placeholder, { issue: issueLabel, agent: agentName })}
          value={draft}
          disabled={isRunning || !task.issue_id}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") send();
          }}
          rows={2}
        />
        <div className="flex items-center gap-3">
          {isRunning && (
            <span className="text-caption text-muted-foreground">{t(($) => $.active_board.window.composer_running_hint)}</span>
          )}
          <Button size="sm" className="ml-auto" disabled={!canSend} onClick={send}>
            {t(($) => $.active_board.window.send)}
          </Button>
        </div>
      </div>
    </DialogContent>
  );
}

function Block({ block }: { block: ConversationBlock }) {
  const { t } = useT("agents");
  const [open, setOpen] = useState(false);
  switch (block.kind) {
    case "agent_text":
      return (
        <div className="max-w-[75%] self-start rounded-2xl rounded-bl-sm bg-muted px-3.5 py-2.5 text-body">{block.text}</div>
      );
    case "error":
      return (
        <div className="max-w-[75%] self-start rounded-2xl rounded-bl-sm border border-destructive/40 px-3.5 py-2.5 text-body text-destructive">
          {block.text}
        </div>
      );
    case "files":
      return (
        <div className="w-[520px] max-w-full self-start overflow-hidden rounded-lg border bg-card">
          <div className="border-b px-3.5 py-2.5 text-label font-medium">
            {t(($) => $.active_board.window.files_changed, { count: block.paths.length })}
          </div>
          <ul className="flex flex-col gap-1 px-3.5 py-2.5 font-mono text-caption text-muted-foreground">
            {block.paths.map((p) => (
              <li key={p} className="truncate">{p}</li>
            ))}
          </ul>
        </div>
      );
    case "commands":
      return (
        <div className="flex w-[520px] max-w-full flex-col self-start gap-1.5">
          {block.runs.map((run) => (
            <div key={run.seq} className="flex items-center gap-2.5 rounded-lg border bg-card px-3.5 py-2.5">
              <span
                className={cn(
                  "size-2 shrink-0 rounded-full",
                  run.ok === true ? "bg-success" : run.ok === false ? "bg-destructive" : "bg-muted-foreground",
                )}
              />
              <span className="truncate font-mono text-caption">{run.command}</span>
            </div>
          ))}
        </div>
      );
    case "other":
      return (
        <div className="self-start">
          <button
            type="button"
            className="text-caption text-muted-foreground hover:underline"
            onClick={() => setOpen((v) => !v)}
          >
            {t(($) => $.active_board.window.other_steps, { count: block.steps.length })}
          </button>
          {open && (
            <ul className="mt-1 flex flex-col gap-0.5 pl-2 text-caption text-muted-foreground">
              {block.steps.map((s, i) => (
                <li key={i} className="truncate">{t(($) => $.active_board.step[s.verb], { object: s.object })}</li>
              ))}
            </ul>
          )}
        </div>
      );
    default:
      return null;
  }
}
```

Replace `{t(($) => $.active_board.window.trigger_label, { actor: "", })}` with the real actor: look up the task's trigger comment author if `task.trigger_comment_id` is set and `issueDetail` exposes comments; otherwise pass the issue creator name when available and an empty string when not. Do not fabricate a name. Check that `Textarea` exists at `packages/ui/components/ui/textarea.tsx`; if not, run `pnpm ui:add textarea` from the repo root. Check `ActorAvatar` accepts `size="md"`; otherwise use the size the component offers.

- [ ] **Step 4: Run the test**

```bash
pnpm --filter @multica/views exec vitest run agents/components/agent-window.test.tsx && pnpm typecheck
```

Expected: PASS. If `taskMessagesOptions` for a finished task requires a different `enabled`, read `packages/core/chat/queries.ts:198` and pass the terminal-task variant it documents.

- [ ] **Step 5: Commit**

```bash
git add packages/views/agents/components/agent-window.tsx packages/views/agents/components/agent-window.test.tsx
git commit -m "feat(agents): add the agent window overlay for the active board"
```

---

### Task 11: Grid page, sorting, waiting detection, and ?task= wiring

**Files:**
- Rewrite: `packages/views/agents/components/active-board-page.tsx`
- Modify: `packages/views/agents/components/active-board-page.test.tsx`

**Interfaces:**
- Consumes: `selectBoardTasks`, `sortBoardCards`, `isWaitingForInput`, `activeCounts`, `type BoardCard` (Task 6); `ActiveTaskCard` (Task 9); `AgentWindow` (Task 10); `useNavigation` from `../../navigation` (`pathname`, `searchParams`, `replace`); `useQueries` from `@tanstack/react-query`; `taskMessagesOptions`.
- Produces: the page. The `?task=` param is the only client state and lives in the URL.

- [ ] **Step 1: Update the page test**

Replace the body of `active-board-page.test.tsx` below the imports and mocks. Keep the existing mocks; add a navigation mock and a `useQueries` mock:

```tsx
const navState = vi.hoisted(() => ({ search: new URLSearchParams(), replace: vi.fn() }));
vi.mock("../../navigation", () => ({
  AppLink: ({ href, children, ...rest }: { href: string; children: React.ReactNode; [k: string]: unknown }) => (
    <a href={href} {...rest}>{children}</a>
  ),
  useNavigation: () => ({
    pathname: "/acme/active",
    searchParams: navState.search,
    replace: navState.replace,
    push: vi.fn(),
    back: vi.fn(),
    hash: "",
  }),
}));
vi.mock("./agent-window", () => ({
  AgentWindow: ({ task }: { task: { id: string } | null }) => (task ? <div role="dialog">window:{task.id}</div> : null),
}));
```

Extend the `@tanstack/react-query` mock with `useQueries`, next to `useQuery`:

```ts
  useQueries: ({ queries }: { queries: { queryKey: readonly unknown[]; enabled?: boolean }[] }) =>
    queries.map((q) => ({ data: q.enabled === false ? [] : mockMessages.current, isLoading: false })),
```

Then the tests:

```tsx
function renderPage() {
  return render(
    <I18nProvider resources={TEST_RESOURCES} lng="en">
      <ActiveBoardPage />
    </I18nProvider>,
  );
}

const running = {
  id: "t-run", agent_id: "a1", runtime_id: "r", issue_id: "i1", status: "running", priority: 0,
  dispatched_at: null, started_at: "2026-09-03T10:00:00Z", completed_at: null, result: null, error: null,
  created_at: "2026-09-03T09:59:00Z", pstack_summary: "Adds a --property flag to issue list.",
};
const finished = {
  ...running, id: "t-done", agent_id: "a2", issue_id: "i2", status: "completed",
  completed_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(), pstack_summary: null,
  handoff_note: "Decide the membership rule",
};

describe("ActiveBoardPage", () => {
  beforeEach(() => {
    mockAgents.current = [{ id: "a1", name: "Codex" }, { id: "a2", name: "Claude" }];
    mockIssues.current = { i1: { id: "i1", identifier: "MUL-1", title: "Flag" }, i2: { id: "i2", identifier: "MUL-2", title: "Auth" } };
    mockMessages.current = [{ seq: 1, type: "text", content: "Every run, or only at creation?" }];
    mockSnapshot.current = [running, finished];
    navState.search = new URLSearchParams();
    navState.replace.mockReset();
  });
  afterEach(cleanup);

  it("renders one card per task with the generated headline and a waiting card first", () => {
    renderPage();
    const cards = screen.getAllByRole("button", { name: /Codex|Claude/ });
    expect(cards[0].textContent).toContain("Claude");
    expect(screen.getByText("Waiting for you")).toBeTruthy();
    expect(screen.getByText("Adds a --property flag to issue list.")).toBeTruthy();
  });

  it("opens the window through the task search param", () => {
    renderPage();
    fireEvent.click(screen.getByText("Adds a --property flag to issue list."));
    expect(navState.replace).toHaveBeenCalledWith("/acme/active?task=t-run");
  });

  it("shows the window when the param is present and clears an unknown one", () => {
    navState.search = new URLSearchParams("task=t-run");
    renderPage();
    expect(screen.getByRole("dialog").textContent).toBe("window:t-run");
    cleanup();
    navState.search = new URLSearchParams("task=missing");
    renderPage();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(navState.replace).toHaveBeenCalledWith("/acme/active");
  });

  it("shows the empty state with no tasks", () => {
    mockSnapshot.current = [];
    renderPage();
    expect(screen.getByText("No agents are working right now.")).toBeTruthy();
  });
});
```

Add `fireEvent` and `afterEach` to the testing imports. Remove the old tests that assert on issue-group headings.

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @multica/views exec vitest run agents/components/active-board-page.test.tsx
```

Expected: failures on the old grouped layout and missing window wiring.

- [ ] **Step 3: Rewrite the page**

Replace `packages/views/agents/components/active-board-page.tsx`:

```tsx
"use client";

import { useCallback, useEffect, useMemo } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Activity } from "lucide-react";
import { cn } from "@multica/ui/lib/utils";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import { LIST_GRID_BOTTOM_CLEARANCE } from "@multica/ui/components/ui/list-grid";
import { useWorkspaceId } from "@multica/core/hooks";
import { agentTaskSnapshotOptions } from "@multica/core/agents";
import { taskMessagesOptions } from "@multica/core/chat/queries";
import type { AgentTask } from "@multica/core/types";
import { CollectionPageHeader } from "../../layout/collection-page";
import { PAGE_GUTTER } from "../../layout/page-header";
import { useNavigation } from "../../navigation";
import { buildTimeline } from "../../common/task-transcript/build-timeline";
import { buildSteps, type TraceStep } from "../../common/task-transcript/build-steps";
import { useT } from "../../i18n";
import {
  activeCounts,
  isWaitingForInput,
  selectBoardTasks,
  sortBoardCards,
  type BoardCard,
} from "./active-board";
import { ActiveTaskCard } from "./active-task-card";
import { AgentWindow } from "./agent-window";

const TASK_PARAM = "task";
const GRID_CLASS = "grid grid-cols-1 gap-4 md:grid-cols-2";

/**
 * Every agent working, or recently blocked on a person, as one grid of cards.
 * Clicking a card opens the agent window; the open task lives in `?task=` so
 * it survives a reload and can be linked.
 */
export function ActiveBoardPage() {
  const { t } = useT("agents");
  const wsId = useWorkspaceId();
  const nav = useNavigation();
  const { data: snapshot = [], isLoading } = useQuery(agentTaskSnapshotOptions(wsId));
  const candidates = useMemo(() => selectBoardTasks(snapshot), [snapshot]);

  // Holding a running task's messages cache is what lets its task:message
  // stream flow (MUL-6396). Recently finished tasks are fetched once so the
  // board can tell whether their last words were a question.
  const messageQueries = useQueries({
    queries: candidates.map((task) => ({
      ...taskMessagesOptions(task.id),
      enabled: taskMessagesOptions(task.id).enabled !== false,
    })),
  });

  const stepsByTask = useMemo(() => {
    const out = new Map<string, TraceStep[]>();
    candidates.forEach((task, i) => {
      const messages = (messageQueries[i]?.data ?? []) as Parameters<typeof buildTimeline>[0];
      out.set(task.id, buildSteps(buildTimeline(messages)).filter((s) => s.kind !== "thinking"));
    });
    return out;
  }, [candidates, messageQueries]);

  const cards = useMemo(() => {
    const now = Date.now();
    const unsorted: BoardCard[] = candidates.map((task) => {
      const steps = stepsByTask.get(task.id) ?? [];
      const last = steps.at(-1);
      return {
        task,
        waiting: isWaitingForInput(task, steps, now),
        lastActivityAt: last?.startedAt ?? (last?.kind === "call" ? last.endedAt ?? null : null),
      };
    });
    return sortBoardCards(unsorted);
  }, [candidates, stepsByTask]);

  const openTaskId = nav.searchParams.get(TASK_PARAM);
  const openTask: AgentTask | null = useMemo(
    () => cards.find((c) => c.task.id === openTaskId)?.task ?? null,
    [cards, openTaskId],
  );

  const setTaskParam = useCallback(
    (taskId: string | null) => {
      const params = new URLSearchParams(nav.searchParams);
      if (taskId) params.set(TASK_PARAM, taskId);
      else params.delete(TASK_PARAM);
      const search = params.toString();
      nav.replace(`${nav.pathname}${search ? `?${search}` : ""}`);
    },
    [nav],
  );

  // A stale or unknown ?task= is cleared rather than shown as an empty window.
  useEffect(() => {
    if (!isLoading && openTaskId && !openTask) setTaskParam(null);
  }, [isLoading, openTaskId, openTask, setTaskParam]);

  const active = cards.filter((c) => !c.waiting).map((c) => c.task);
  const counts = activeCounts(active);
  const waitingCount = cards.length - active.length;
  const description =
    cards.length === 0
      ? undefined
      : [
          t(($) => $.active_board.running_count, { count: counts.running }),
          counts.waiting > 0 ? t(($) => $.active_board.waiting_count, { count: counts.waiting }) : null,
          waitingCount > 0 ? `${waitingCount} ${t(($) => $.active_board.waiting_for_you).toLowerCase()}` : null,
        ]
          .filter(Boolean)
          .join(" · ");

  return (
    <div className="flex h-full flex-col">
      <CollectionPageHeader
        icon={Activity}
        title={t(($) => $.active_board.title)}
        count={cards.length}
        description={description}
      />
      <div className={cn("min-h-0 flex-1 overflow-y-auto pt-4", PAGE_GUTTER)}>
        {isLoading ? (
          <div className={GRID_CLASS}>
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-40 w-full rounded-lg" />
            ))}
          </div>
        ) : cards.length === 0 ? (
          <p className="pt-16 text-center text-caption text-muted-foreground">{t(($) => $.active_board.empty)}</p>
        ) : (
          <div className={GRID_CLASS} style={{ paddingBottom: LIST_GRID_BOTTOM_CLEARANCE }}>
            {cards.map((card) => (
              <ActiveTaskCard
                key={card.task.id}
                wsId={wsId}
                card={card}
                lastStep={stepsByTask.get(card.task.id)?.at(-1) ?? null}
                onOpen={(id) => setTaskParam(id)}
              />
            ))}
          </div>
        )}
      </div>
      <AgentWindow wsId={wsId} task={openTask} onClose={() => setTaskParam(null)} />
    </div>
  );
}
```

Notes for the implementer:

- `onStop` is not passed. The existing cancel-task mutation, if one exists in `packages/core/agents` or `packages/core/issues`, can be wired later; leave the Stop button hidden in v1 unless a mutation with a confirmation pattern already exists. Record this in the implementation notes.
- `taskMessagesOptions(task.id).enabled` may not exist as a field; read `packages/core/chat/queries.ts:198`. The intent is: running tasks stay subscribed live, finished tasks fetch once. If the options object already handles terminal tasks with `staleTime: Infinity`, pass it unchanged.
- The "waiting for you" count reuses the pill string lowercased rather than adding a fifth plural key. If the lowercasing reads badly in a locale, add `waiting_for_you_count_one/other` keys and use them.

- [ ] **Step 4: Run the page tests and the whole views suite**

```bash
pnpm --filter @multica/views exec vitest run agents/components && pnpm typecheck && pnpm lint
```

Expected: PASS, clean.

- [ ] **Step 5: Run it in the real app**

```bash
make up
```

Open `/{workspace}/active` in the web app with at least one agent running. Check: the grid renders two columns at desktop width, a running card shows the headline (or trigger text until the summary lands), the right-now line updates as the agent works, clicking a card opens the window, the URL gains `?task=`, Escape closes it and clears the param, and reloading with `?task=` present reopens it. Then run `make down`.

- [ ] **Step 6: Commit**

```bash
git add packages/views/agents/components/active-board-page.tsx packages/views/agents/components/active-board-page.test.tsx
git commit -m "feat(agents): lay the active board out as a grid with an agent window"
```

---

### Task 12: Remove what the rewrite orphaned, full verification

**Files:**
- Modify: `packages/views/agents/components/active-board.ts` (remove `groupActiveTasks`, `ActiveTaskGroup`, `selectActiveTasks` if no longer imported anywhere)
- Modify: `packages/views/agents/components/active-board.test.ts` (drop their tests)
- Modify: `packages/views/locales/*/agents.json` (drop `active_board.no_issue` only if unused after Task 10; it is still used in the window header, so keep it)

- [ ] **Step 1: Find orphans**

```bash
rg -n "groupActiveTasks|ActiveTaskGroup|selectActiveTasks|active_ago|started_ago" packages/views packages/core apps --glob '!**/*.test.*'
```

For every symbol or key with no non-test reference, delete it and its tests. `active_ago` / `started_ago` are locale keys; if no component uses them, remove them from all four locale files.

- [ ] **Step 2: Full verification**

```bash
pnpm typecheck && pnpm lint && pnpm test && (cd server && go vet ./... && go test ./internal/service ./internal/handler ./cmd/server -count=1)
```

Expected: all green. Report any failure verbatim rather than working around it.

- [ ] **Step 3: Commit**

```bash
git add -A packages/views/agents/components packages/views/locales
git commit -m "refactor(agents): drop the grouped active board helpers"
```

- [ ] **Step 4: Finish the implementation notes**

Make sure `docs/superpowers/specs/2026-09-03-active-agents-view-implementation-notes.md` records at least: the missing zod schema on the snapshot endpoint, the Stop button decision, the trigger actor label decision, and any field name adjustments made in Tasks 3, 6, 7, or 10. Commit it:

```bash
git add docs/superpowers/specs/2026-09-03-active-agents-view-implementation-notes.md
git commit -m "docs(agents): implementation notes for the active agents view"
```
