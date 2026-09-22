package handler

import (
	"context"
	"encoding/json"
	"testing"
)

func TestHostReapStoreLifecycle(t *testing.T) {
	ctx := context.Background()
	s := NewInMemoryHostReapStore()

	req, err := s.Create(ctx, "daemon-1", "ws-1", "rt-1", HostReapDryRun, "user-1")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if req.Status != HostReapPending {
		t.Fatalf("new request status = %q, want pending", req.Status)
	}

	has, _ := s.HasPending(ctx, "rt-1")
	if !has {
		t.Fatal("HasPending(rt-1) = false, want true")
	}

	popped, _ := s.PopPending(ctx, "rt-1")
	if popped == nil || popped.ID != req.ID {
		t.Fatalf("PopPending returned %v, want request %s", popped, req.ID)
	}
	if again, _ := s.PopPending(ctx, "rt-1"); again != nil {
		t.Fatal("second PopPending should be nil (already claimed)")
	}

	if err := s.Complete(ctx, req.ID, json.RawMessage(`{"count":0}`)); err != nil {
		t.Fatalf("Complete: %v", err)
	}
	got, _ := s.Get(ctx, req.ID)
	if got.Status != HostReapCompleted || string(got.Result) != `{"count":0}` {
		t.Fatalf("after Complete: status=%q result=%s", got.Status, got.Result)
	}
}

func TestHostReapStoreFail(t *testing.T) {
	ctx := context.Background()
	s := NewInMemoryHostReapStore()
	req, _ := s.Create(ctx, "d", "w", "rt", HostReapApply, "u")
	if err := s.Fail(ctx, req.ID, "boom"); err != nil {
		t.Fatalf("Fail: %v", err)
	}
	got, _ := s.Get(ctx, req.ID)
	if got.Status != HostReapFailed || got.Error != "boom" {
		t.Fatalf("after Fail: status=%q err=%q", got.Status, got.Error)
	}
}
