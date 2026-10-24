package main

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// An autopilot with pstack_skip_while_open must not open a second issue while one it
// created is still unresolved, however long ago that issue was created and
// whatever it has been renamed to (the 60s same-title guard covers neither).
func TestDispatchAutopilotSkipWhileOpen(t *testing.T) {
	ctx := context.Background()
	queries := db.New(testPool)
	bus := events.New()
	taskSvc := service.NewTaskService(queries, testPool, nil, bus)
	autopilotSvc := service.NewAutopilotService(queries, testPool, bus, taskSvc)

	var agentID string
	if err := testPool.QueryRow(ctx,
		`SELECT id::text FROM agent WHERE workspace_id = $1 ORDER BY created_at ASC LIMIT 1`,
		testWorkspaceID,
	).Scan(&agentID); err != nil {
		t.Fatalf("load fixture agent: %v", err)
	}

	newAutopilot := func(t *testing.T, skipWhileOpen bool) db.Autopilot {
		t.Helper()
		ap, err := queries.CreateAutopilot(ctx, db.CreateAutopilotParams{
			WorkspaceID:         parseUUID(testWorkspaceID),
			Title:               "Skip while open " + time.Now().UTC().Format("20060102150405.000000000"),
			Description:         pgtype.Text{String: "Skip while open test", Valid: true},
			AssigneeType:        "agent",
			AssigneeID:          parseUUID(agentID),
			Status:              "active",
			ExecutionMode:       "create_issue",
			PstackSkipWhileOpen: skipWhileOpen,
			CreatedByType:       "member",
			CreatedByID:         parseUUID(testUserID),
		})
		if err != nil {
			t.Fatalf("CreateAutopilot: %v", err)
		}
		t.Cleanup(func() {
			bg := context.Background()
			_, _ = testPool.Exec(bg, `DELETE FROM issue WHERE origin_type = 'autopilot' AND origin_id = $1`, ap.ID)
			_, _ = testPool.Exec(bg, `DELETE FROM autopilot WHERE id = $1`, ap.ID)
		})
		return ap
	}

	// Moves the issue out of the 60s same-title window and renames it, the way
	// a squad leader does, so only pstack_skip_while_open can still match it.
	ageIssue := func(t *testing.T, issueID pgtype.UUID, status string) {
		t.Helper()
		if _, err := testPool.Exec(ctx,
			`UPDATE issue SET title = 'Renamed by leader', status = $2, created_at = now() - interval '1 hour' WHERE id = $1`,
			issueID, status,
		); err != nil {
			t.Fatalf("age issue: %v", err)
		}
	}

	dispatch := func(t *testing.T, ap db.Autopilot, trigger pgtype.UUID) *db.AutopilotRun {
		t.Helper()
		run, err := autopilotSvc.DispatchAutopilot(ctx, ap, trigger, "manual", nil)
		if err != nil {
			t.Fatalf("DispatchAutopilot: %v", err)
		}
		if run == nil {
			t.Fatalf("DispatchAutopilot returned nil run")
		}
		return run
	}

	t.Run("skips while an issue is unresolved, resumes once it is done", func(t *testing.T) {
		ap := newAutopilot(t, true)
		trigger := seedAutopilotScheduleTrigger(t, queries, ap)

		first := dispatch(t, ap, trigger)
		if first.Status != "issue_created" || !first.IssueID.Valid {
			t.Fatalf("first dispatch = %+v, want issue_created", first)
		}

		for _, status := range []string{"blocked", "in_review"} {
			ageIssue(t, first.IssueID, status)
			skipped := dispatch(t, ap, trigger)
			if skipped.Status != "skipped" || skipped.IssueID.Valid {
				t.Fatalf("dispatch with %s issue = %+v, want skipped with no issue", status, skipped)
			}
			want := "open autopilot issue: " + util.UUIDToString(first.IssueID)
			if skipped.FailureReason.String != want {
				t.Fatalf("skip reason = %q, want %q", skipped.FailureReason.String, want)
			}
		}

		ageIssue(t, first.IssueID, "done")
		resumed := dispatch(t, ap, trigger)
		if resumed.Status != "issue_created" || resumed.IssueID == first.IssueID {
			t.Fatalf("dispatch after done = %+v, want a new issue", resumed)
		}
	})

	t.Run("off by default: an old unresolved issue does not block", func(t *testing.T) {
		ap := newAutopilot(t, false)
		trigger := seedAutopilotScheduleTrigger(t, queries, ap)

		first := dispatch(t, ap, trigger)
		ageIssue(t, first.IssueID, "blocked")
		second := dispatch(t, ap, trigger)
		if second.Status != "issue_created" {
			t.Fatalf("second dispatch = %+v, want issue_created", second)
		}
	})
}
