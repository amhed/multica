package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"sync"
	"testing"

	"github.com/multica-ai/multica/server/internal/daemonws"
	"github.com/multica-ai/multica/server/internal/testutil"
)

// fakeHostReapHub stubs the daemon-hub surface InitiateHostReap needs:
// host-health membership (to reject a daemon that is not visible on this
// workspace's card) and runtime routing (to reject an offline daemon).
type fakeHostReapHub struct {
	mu      sync.Mutex
	hosts   map[string][]daemonws.HostHealthEntry
	runtime string
	online  bool
	calls   []struct{ runtimeID, kind string }
}

func (f *fakeHostReapHub) WorkspaceHostHealth(workspaceID string) []daemonws.HostHealthEntry {
	return f.hosts[workspaceID]
}

func (f *fakeHostReapHub) RuntimeForDaemon(workspaceID, daemonID string) (string, bool) {
	return f.runtime, f.online
}

func (f *fakeHostReapHub) NotifyPendingWork(runtimeID, kind string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, struct{ runtimeID, kind string }{runtimeID, kind})
}

func (f *fakeHostReapHub) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.calls)
}

func hostReapTestHandler(t *testing.T, hub *fakeHostReapHub) *Handler {
	t.Helper()
	h := *testHandler
	h.DaemonHostReap = hub
	h.DaemonPendingWork = hub
	h.HostReapStore = NewInMemoryHostReapStore()
	return &h
}

func TestInitiateHostReapRequiresAdmin(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	daemonID := "11111111-1111-1111-1111-111111111111"
	memberUserID := dbfx.User(t, "Reap Non-Admin", "reap-non-admin@multica.ai")
	dbfx.Member(t, testWorkspaceID, memberUserID, "member")

	hub := &fakeHostReapHub{
		hosts: map[string][]daemonws.HostHealthEntry{
			testWorkspaceID: {{DaemonID: daemonID}},
		},
		runtime: "rt1",
		online:  true,
	}
	h := hostReapTestHandler(t, hub)

	req := withURLParam(newRequestAs(memberUserID, http.MethodPost, "/api/host-health/"+daemonID+"/reap",
		map[string]string{"mode": "dryrun"}), "daemonId", daemonID)

	testutil.Call(t, h.InitiateHostReap, req).Want(http.StatusForbidden)
}

func TestInitiateHostReapRejectsForeignDaemon(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	daemonID := "22222222-2222-2222-2222-222222222222"

	hub := &fakeHostReapHub{
		// No host-health entries for this workspace: the daemon is not
		// currently visible on this workspace's card.
		hosts:   map[string][]daemonws.HostHealthEntry{},
		runtime: "rt1",
		online:  true,
	}
	h := hostReapTestHandler(t, hub)

	req := withURLParam(newRequest(http.MethodPost, "/api/host-health/"+daemonID+"/reap",
		map[string]string{"mode": "dryrun"}), "daemonId", daemonID)

	testutil.Call(t, h.InitiateHostReap, req).Want(http.StatusNotFound)
}

func TestInitiateHostReapEnqueues(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	daemonID := "33333333-3333-3333-3333-333333333333"

	hub := &fakeHostReapHub{
		hosts: map[string][]daemonws.HostHealthEntry{
			testWorkspaceID: {{DaemonID: daemonID}},
		},
		runtime: "rt1",
		online:  true,
	}
	h := hostReapTestHandler(t, hub)

	req := withURLParam(newRequest(http.MethodPost, "/api/host-health/"+daemonID+"/reap",
		map[string]string{"mode": "apply"}), "daemonId", daemonID)

	var out struct {
		RequestID string `json:"request_id"`
	}
	testutil.Call(t, h.InitiateHostReap, req).Want(http.StatusOK).JSON(&out)

	if out.RequestID == "" {
		t.Fatal("expected a non-empty request_id")
	}

	stored, err := h.HostReapStore.Get(context.Background(), out.RequestID)
	if err != nil || stored == nil {
		t.Fatalf("expected a stored pending request: %v", err)
	}
	if stored.DaemonID != daemonID || stored.WorkspaceID != testWorkspaceID || stored.RuntimeID != "rt1" {
		t.Fatalf("unexpected stored request: %+v", stored)
	}
	if stored.Mode != HostReapApply {
		t.Fatalf("expected mode apply, got %q", stored.Mode)
	}
	if stored.RequestedBy != testUserID {
		t.Fatalf("expected requested_by %q, got %q", testUserID, stored.RequestedBy)
	}

	if hub.count() != 1 {
		t.Fatalf("expected exactly 1 pending-work hint, got %d", hub.count())
	}
	if hub.calls[0].runtimeID != "rt1" || hub.calls[0].kind != "host_reap" {
		t.Fatalf("unexpected pending-work hint: %+v", hub.calls[0])
	}
}

func TestGetHostReapRequest(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	daemonID := "55555555-5555-5555-5555-555555555555"

	hub := &fakeHostReapHub{
		hosts: map[string][]daemonws.HostHealthEntry{
			testWorkspaceID: {{DaemonID: daemonID}},
		},
		runtime: "rt1",
		online:  true,
	}
	h := hostReapTestHandler(t, hub)

	stored, err := h.HostReapStore.Create(context.Background(), daemonID, testWorkspaceID, "rt1", HostReapDryRun, testUserID)
	if err != nil {
		t.Fatalf("failed to seed pending request: %v", err)
	}

	req := withURLParams(newRequest(http.MethodGet, "/api/host-health/"+daemonID+"/reap/"+stored.ID, nil),
		"daemonId", daemonID, "requestId", stored.ID)

	var out HostReapRequest
	testutil.Call(t, h.GetHostReapRequest, req).Want(http.StatusOK).JSON(&out)
	if out.Status != HostReapPending {
		t.Fatalf("expected status pending, got %q", out.Status)
	}

	if err := h.HostReapStore.Complete(context.Background(), stored.ID, json.RawMessage(`{"killed":2}`)); err != nil {
		t.Fatalf("failed to complete request: %v", err)
	}

	req = withURLParams(newRequest(http.MethodGet, "/api/host-health/"+daemonID+"/reap/"+stored.ID, nil),
		"daemonId", daemonID, "requestId", stored.ID)

	var out2 HostReapRequest
	testutil.Call(t, h.GetHostReapRequest, req).Want(http.StatusOK).JSON(&out2)
	if out2.Status != HostReapCompleted {
		t.Fatalf("expected status completed, got %q", out2.Status)
	}
	if string(out2.Result) != `{"killed":2}` {
		t.Fatalf("unexpected result: %s", out2.Result)
	}
}

func TestGetHostReapRequestNotFoundForWrongDaemon(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	daemonID := "66666666-6666-6666-6666-666666666666"
	otherDaemonID := "77777777-7777-7777-7777-777777777777"

	hub := &fakeHostReapHub{
		hosts: map[string][]daemonws.HostHealthEntry{
			testWorkspaceID: {{DaemonID: daemonID}, {DaemonID: otherDaemonID}},
		},
		runtime: "rt1",
		online:  true,
	}
	h := hostReapTestHandler(t, hub)

	stored, err := h.HostReapStore.Create(context.Background(), daemonID, testWorkspaceID, "rt1", HostReapDryRun, testUserID)
	if err != nil {
		t.Fatalf("failed to seed pending request: %v", err)
	}

	req := withURLParams(newRequest(http.MethodGet, "/api/host-health/"+otherDaemonID+"/reap/"+stored.ID, nil),
		"daemonId", otherDaemonID, "requestId", stored.ID)

	testutil.Call(t, h.GetHostReapRequest, req).Want(http.StatusNotFound)
}

func TestGetHostReapRequestRequiresAdmin(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	daemonID := "88888888-8888-8888-8888-888888888888"
	memberUserID := dbfx.User(t, "Reap Get Non-Admin", "reap-get-non-admin@multica.ai")
	dbfx.Member(t, testWorkspaceID, memberUserID, "member")

	hub := &fakeHostReapHub{
		hosts: map[string][]daemonws.HostHealthEntry{
			testWorkspaceID: {{DaemonID: daemonID}},
		},
		runtime: "rt1",
		online:  true,
	}
	h := hostReapTestHandler(t, hub)

	stored, err := h.HostReapStore.Create(context.Background(), daemonID, testWorkspaceID, "rt1", HostReapDryRun, testUserID)
	if err != nil {
		t.Fatalf("failed to seed pending request: %v", err)
	}

	req := withURLParams(newRequestAs(memberUserID, http.MethodGet, "/api/host-health/"+daemonID+"/reap/"+stored.ID, nil),
		"daemonId", daemonID, "requestId", stored.ID)

	testutil.Call(t, h.GetHostReapRequest, req).Want(http.StatusForbidden)
}

// TestHeartbeatClaimsHostReap pins the heartbeat claim wiring: a pending
// host-reap request for the heartbeating runtime is popped and surfaced on
// the ack, and the row transitions to running.
func TestHeartbeatClaimsHostReap(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	runtimeID := createRuntimeLocalSkillTestRuntime(t, testUserID)
	daemonID := "heartbeat-claims-host-reap-daemon"

	h := *testHandler
	h.HostReapStore = NewInMemoryHostReapStore()

	stored, err := h.HostReapStore.Create(context.Background(), daemonID, testWorkspaceID, runtimeID, HostReapApply, testUserID)
	if err != nil {
		t.Fatalf("failed to seed pending request: %v", err)
	}

	req := newDaemonTokenRequest(http.MethodPost, "/api/daemon/heartbeat", map[string]any{
		"runtime_id": runtimeID,
	}, testWorkspaceID, daemonID)

	var out struct {
		PendingReap *struct {
			ID   string `json:"id"`
			Mode string `json:"mode"`
		} `json:"pending_reap"`
	}
	testutil.Call(t, h.DaemonHeartbeat, req).Want(http.StatusOK).JSON(&out)

	if out.PendingReap == nil {
		t.Fatal("expected pending_reap on ack, got nil")
	}
	if out.PendingReap.ID != stored.ID {
		t.Fatalf("pending_reap.id = %q, want %q", out.PendingReap.ID, stored.ID)
	}
	if out.PendingReap.Mode != string(HostReapApply) {
		t.Fatalf("pending_reap.mode = %q, want %q", out.PendingReap.Mode, HostReapApply)
	}

	row, err := h.HostReapStore.Get(context.Background(), stored.ID)
	if err != nil || row == nil {
		t.Fatalf("expected stored row: %v", err)
	}
	if row.Status != HostReapRunning {
		t.Fatalf("expected status running after claim, got %q", row.Status)
	}
}

func TestReportHostReapResultCompletes(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	runtimeID := createRuntimeLocalSkillTestRuntime(t, testUserID)
	daemonID := "report-host-reap-completes-daemon"

	h := *testHandler
	h.HostReapStore = NewInMemoryHostReapStore()

	stored, err := h.HostReapStore.Create(context.Background(), daemonID, testWorkspaceID, runtimeID, HostReapDryRun, testUserID)
	if err != nil {
		t.Fatalf("failed to seed pending request: %v", err)
	}
	if _, err := h.HostReapStore.PopPending(context.Background(), runtimeID); err != nil {
		t.Fatalf("failed to claim pending request: %v", err)
	}

	req := withURLParams(newDaemonTokenRequest(http.MethodPost,
		"/api/daemon/runtimes/"+runtimeID+"/reap/"+stored.ID+"/result",
		map[string]any{"status": "completed", "result": map[string]int{"killed": 3}},
		testWorkspaceID, daemonID),
		"runtimeId", runtimeID, "requestId", stored.ID)

	testutil.Call(t, h.ReportHostReapResult, req).Want(http.StatusOK)

	row, err := h.HostReapStore.Get(context.Background(), stored.ID)
	if err != nil || row == nil {
		t.Fatalf("expected stored row: %v", err)
	}
	if row.Status != HostReapCompleted {
		t.Fatalf("expected status completed, got %q", row.Status)
	}
	if string(row.Result) != `{"killed":3}` {
		t.Fatalf("unexpected result: %s", row.Result)
	}
}

func TestReportHostReapResultStaleIgnored(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	runtimeID := createRuntimeLocalSkillTestRuntime(t, testUserID)
	daemonID := "report-host-reap-stale-daemon"

	h := *testHandler
	h.HostReapStore = NewInMemoryHostReapStore()

	stored, err := h.HostReapStore.Create(context.Background(), daemonID, testWorkspaceID, runtimeID, HostReapDryRun, testUserID)
	if err != nil {
		t.Fatalf("failed to seed pending request: %v", err)
	}
	if err := h.HostReapStore.Complete(context.Background(), stored.ID, json.RawMessage(`{"killed":1}`)); err != nil {
		t.Fatalf("failed to complete request: %v", err)
	}

	req := withURLParams(newDaemonTokenRequest(http.MethodPost,
		"/api/daemon/runtimes/"+runtimeID+"/reap/"+stored.ID+"/result",
		map[string]any{"status": "completed", "result": map[string]int{"killed": 99}},
		testWorkspaceID, daemonID),
		"runtimeId", runtimeID, "requestId", stored.ID)

	testutil.Call(t, h.ReportHostReapResult, req).Want(http.StatusOK)

	row, err := h.HostReapStore.Get(context.Background(), stored.ID)
	if err != nil || row == nil {
		t.Fatalf("expected stored row: %v", err)
	}
	if row.Status != HostReapCompleted {
		t.Fatalf("expected status to remain completed, got %q", row.Status)
	}
	if string(row.Result) != `{"killed":1}` {
		t.Fatalf("expected result to remain unchanged, got: %s", row.Result)
	}
}

func TestInitiateHostReapDaemonOffline(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	daemonID := "44444444-4444-4444-4444-444444444444"

	hub := &fakeHostReapHub{
		hosts: map[string][]daemonws.HostHealthEntry{
			testWorkspaceID: {{DaemonID: daemonID}},
		},
		runtime: "",
		online:  false,
	}
	h := hostReapTestHandler(t, hub)

	req := withURLParam(newRequest(http.MethodPost, "/api/host-health/"+daemonID+"/reap",
		map[string]string{"mode": "dryrun"}), "daemonId", daemonID)

	testutil.Call(t, h.InitiateHostReap, req).Want(http.StatusServiceUnavailable)
}
