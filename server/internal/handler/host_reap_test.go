package handler

import (
	"context"
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
