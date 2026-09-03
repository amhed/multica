package handler

import (
	"testing"

	"github.com/jackc/pgx/v5/pgtype"

	db "github.com/multica-ai/multica/server/pkg/db/generated"
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
