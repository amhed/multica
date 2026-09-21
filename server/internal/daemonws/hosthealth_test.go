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
