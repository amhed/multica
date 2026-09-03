package service

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
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
		"  Adding   a flag.\n\nThen tests.  ":     "Adding a flag. Then tests.",
		"**Bold** and `code` and # heading":       "Bold and code and heading",
		"Summary: Adding a flag.":                 "Adding a flag.",
		"\n\t ":                                   "",
		"Refactors C# service layer for clarity.": "Refactors C# service layer for clarity.",
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
		INSERT INTO agent_task_queue (agent_id, issue_id, status, priority, trigger_summary, handoff_note, runtime_id)
		VALUES ($1, $2, 'dispatched', 0, 'Please add the flag', 'Stay in the CLI package', (SELECT runtime_id FROM agent WHERE id = $1))
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
		INSERT INTO agent_task_queue (agent_id, issue_id, status, priority, runtime_id)
		VALUES ($1, $2, 'dispatched', 0, (SELECT runtime_id FROM agent WHERE id = $1)) RETURNING id`, agentID, issueID).Scan(&taskID); err != nil {
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
