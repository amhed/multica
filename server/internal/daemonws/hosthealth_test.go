package daemonws

import (
	"testing"

	"github.com/multica-ai/multica/server/pkg/protocol"
)

func TestWorkspaceHostHealth(t *testing.T) {
	h := &Hub{byWorkspace: map[string]map[*client]bool{}}

	reporting := &client{identity: ClientIdentity{DaemonID: "daemon-a"}}
	reporting.setHost(&protocol.DaemonHost{NCPU: 8, Load1: 65.7, SwapTotalKB: 100, SwapFreeKB: 0})
	silent := &client{identity: ClientIdentity{DaemonID: "daemon-b"}} // never reported a host

	h.byWorkspace["ws-1"] = map[*client]bool{reporting: true, silent: true}

	got := h.WorkspaceHostHealth("ws-1")
	if len(got) != 1 {
		t.Fatalf("expected 1 reporting host, got %d", len(got))
	}
	if got[0].DaemonID != "daemon-a" || got[0].Host.Load1 != 65.7 {
		t.Fatalf("unexpected entry: %+v", got[0])
	}

	if n := len(h.WorkspaceHostHealth("unknown-ws")); n != 0 {
		t.Fatalf("unknown workspace should be empty, got %d", n)
	}
}

func TestWorkspaceHostHealth_DedupesByDaemon(t *testing.T) {
	h := &Hub{byWorkspace: map[string]map[*client]bool{}}
	c1 := &client{identity: ClientIdentity{DaemonID: "same"}}
	c1.setHost(&protocol.DaemonHost{NCPU: 4})
	c2 := &client{identity: ClientIdentity{DaemonID: "same"}}
	c2.setHost(&protocol.DaemonHost{NCPU: 4})
	h.byWorkspace["ws"] = map[*client]bool{c1: true, c2: true}

	if n := len(h.WorkspaceHostHealth("ws")); n != 1 {
		t.Fatalf("expected dedupe to 1 entry, got %d", n)
	}
}

// PAT-authenticated daemons carry no auth-scoped DaemonID; host health and
// reap routing fall back to the daemon id derived from their runtime rows.
func TestHostHealthAndReapRouting_PATDaemon(t *testing.T) {
	h := &Hub{byWorkspace: map[string]map[*client]bool{}}
	c := &client{
		identity: ClientIdentity{RuntimeDaemonID: "pat-daemon", RuntimeIDs: []string{"rt-1"}},
		runtimes: map[string]struct{}{"rt-1": {}},
	}
	c.setHost(&protocol.DaemonHost{NCPU: 8})
	h.byWorkspace["ws"] = map[*client]bool{c: true}

	got := h.WorkspaceHostHealth("ws")
	if len(got) != 1 || got[0].DaemonID != "pat-daemon" {
		t.Fatalf("host health = %+v, want one entry for pat-daemon", got)
	}
	if rid, ok := h.RuntimeForDaemon("ws", "pat-daemon"); !ok || rid != "rt-1" {
		t.Fatalf("RuntimeForDaemon = (%q, %v), want (rt-1, true)", rid, ok)
	}
	if _, ok := h.RuntimeForDaemon("ws", ""); ok {
		t.Fatal("RuntimeForDaemon matched an empty daemon id")
	}
}

// A daemon serving several workspaces reports every running task; a
// workspace's host health must only carry its own tasks.
func TestWorkspaceHostHealth_FiltersTasksToWorkspace(t *testing.T) {
	h := &Hub{byWorkspace: map[string]map[*client]bool{}}
	c := &client{identity: ClientIdentity{DaemonID: "shared"}}
	c.setHost(&protocol.DaemonHost{
		NCPU: 4,
		Tasks: []protocol.DaemonHostTask{
			{TaskID: "t1", WorkspaceID: "ws-1", IssueIdentifier: "PAI-322"},
			{TaskID: "t2", WorkspaceID: "ws-2", IssueIdentifier: "CAR-9"},
			{TaskID: "t3", WorkspaceID: "ws-1", IssueIdentifier: "PAI-297"},
		},
		Stale: &protocol.DaemonHostProcs{Procs: 2},
	})
	h.byWorkspace["ws-1"] = map[*client]bool{c: true}
	h.byWorkspace["ws-2"] = map[*client]bool{c: true}

	got := h.WorkspaceHostHealth("ws-1")
	if len(got) != 1 {
		t.Fatalf("expected 1 host, got %d", len(got))
	}
	tasks := got[0].Host.Tasks
	if len(tasks) != 2 || tasks[0].TaskID != "t1" || tasks[1].TaskID != "t3" {
		t.Fatalf("ws-1 tasks = %+v, want t1 and t3", tasks)
	}
	if got[0].Host.Stale == nil || got[0].Host.Stale.Procs != 2 {
		t.Fatalf("host-wide stale group should pass through: %+v", got[0].Host.Stale)
	}

	if other := h.WorkspaceHostHealth("ws-2")[0].Host.Tasks; len(other) != 1 || other[0].TaskID != "t2" {
		t.Fatalf("ws-2 tasks = %+v, want t2", other)
	}
	// Filtering must not mutate the stored snapshot another workspace reads.
	if stored := c.getHost().Tasks; len(stored) != 3 {
		t.Fatalf("stored snapshot was mutated: %+v", stored)
	}
}
