package handler

import (
	"context"
	"encoding/json"
	"sync"
	"time"
)

// ---------------------------------------------------------------------------
// Host reap request store
// ---------------------------------------------------------------------------
//
// Mirrors the ModelListStore pending-request pattern above: the server
// cannot call the daemon directly, so "run the leaked-process reaper on this
// host" uses the same enqueue-on-POST / claim-on-heartbeat / report-result
// flow. See the ModelListStore doc comment for the multi-node caveat — the
// same applies here.

// HostReapStatus represents the lifecycle of a host reap request.
type HostReapStatus string

const (
	HostReapPending   HostReapStatus = "pending"
	HostReapRunning   HostReapStatus = "running"
	HostReapCompleted HostReapStatus = "completed"
	HostReapFailed    HostReapStatus = "failed"
	HostReapTimeout   HostReapStatus = "timeout"
)

// HostReapMode selects whether the reaper only reports what it would kill
// ("dryrun") or actually kills leaked processes ("apply").
type HostReapMode string

const (
	HostReapDryRun HostReapMode = "dryrun"
	HostReapApply  HostReapMode = "apply"
)

const (
	// hostReapStoreRetention bounds how long any stored request lives in the
	// backing store. The in-memory backend GCs on Create.
	hostReapStoreRetention = 2 * time.Minute
)

// HostReapRequest represents a pending or completed host reap request.
//
// Result is json.RawMessage and, per the wire contract a later GET endpoint
// and TypeScript zod schema depend on, must serialize as JSON null when
// empty — hence no `omitempty` on its tag.
type HostReapRequest struct {
	ID          string          `json:"id"`
	DaemonID    string          `json:"daemon_id"`
	WorkspaceID string          `json:"workspace_id"`
	RuntimeID   string          `json:"runtime_id"`
	Mode        HostReapMode    `json:"mode"`
	Status      HostReapStatus  `json:"status"`
	Result      json.RawMessage `json:"result"`
	Error       string          `json:"error,omitempty"`
	RequestedBy string          `json:"requested_by"`
	CreatedAt   time.Time       `json:"created_at"`
	UpdatedAt   time.Time       `json:"updated_at"`
	// RunStartedAt is set when PopPending claims the request.
	RunStartedAt *time.Time `json:"-"`
}

// HostReapStore is the contract every backend (in-memory single-node,
// Redis multi-node) must satisfy.
type HostReapStore interface {
	Create(ctx context.Context, daemonID, workspaceID, runtimeID string, mode HostReapMode, requestedBy string) (*HostReapRequest, error)
	Get(ctx context.Context, id string) (*HostReapRequest, error)
	// HasPending is a cheap read-only probe used by the heartbeat hot path
	// to gate the side-effecting PopPending. A spurious "true" is fine —
	// PopPending handles "queue empty after probe" by returning nil.
	HasPending(ctx context.Context, runtimeID string) (bool, error)
	PopPending(ctx context.Context, runtimeID string) (*HostReapRequest, error)
	Complete(ctx context.Context, id string, result json.RawMessage) error
	Fail(ctx context.Context, id string, errMsg string) error
}

// InMemoryHostReapStore is the single-node implementation. Adequate for
// self-hosted dev and the test suite, but unsafe in multi-node deploys (see
// InMemoryModelListStore's doc comment).
type InMemoryHostReapStore struct {
	mu       sync.Mutex
	requests map[string]*HostReapRequest
}

func NewInMemoryHostReapStore() *InMemoryHostReapStore {
	return &InMemoryHostReapStore{requests: make(map[string]*HostReapRequest)}
}

func (s *InMemoryHostReapStore) Create(_ context.Context, daemonID, workspaceID, runtimeID string, mode HostReapMode, requestedBy string) (*HostReapRequest, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	// Garbage-collect stale entries so the map can't grow unbounded.
	for id, req := range s.requests {
		if time.Since(req.CreatedAt) > hostReapStoreRetention {
			delete(s.requests, id)
		}
	}

	now := time.Now()
	req := &HostReapRequest{
		ID:          randomID(),
		DaemonID:    daemonID,
		WorkspaceID: workspaceID,
		RuntimeID:   runtimeID,
		Mode:        mode,
		Status:      HostReapPending,
		RequestedBy: requestedBy,
		CreatedAt:   now,
		UpdatedAt:   now,
	}
	s.requests[req.ID] = req
	return req, nil
}

func (s *InMemoryHostReapStore) Get(_ context.Context, id string) (*HostReapRequest, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	req, ok := s.requests[id]
	if !ok {
		return nil, nil
	}
	return req, nil
}

func (s *InMemoryHostReapStore) HasPending(_ context.Context, runtimeID string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	for _, req := range s.requests {
		if req.RuntimeID == runtimeID && req.Status == HostReapPending {
			return true, nil
		}
	}
	return false, nil
}

func (s *InMemoryHostReapStore) PopPending(_ context.Context, runtimeID string) (*HostReapRequest, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	var oldest *HostReapRequest
	for _, req := range s.requests {
		if req.RuntimeID == runtimeID && req.Status == HostReapPending {
			if oldest == nil || req.CreatedAt.Before(oldest.CreatedAt) {
				oldest = req
			}
		}
	}
	if oldest != nil {
		now := time.Now()
		oldest.Status = HostReapRunning
		oldest.RunStartedAt = &now
		oldest.UpdatedAt = now
	}
	return oldest, nil
}

func (s *InMemoryHostReapStore) Complete(_ context.Context, id string, result json.RawMessage) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if req, ok := s.requests[id]; ok {
		req.Status = HostReapCompleted
		req.Result = result
		req.UpdatedAt = time.Now()
	}
	return nil
}

func (s *InMemoryHostReapStore) Fail(_ context.Context, id string, errMsg string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if req, ok := s.requests[id]; ok {
		req.Status = HostReapFailed
		req.Error = errMsg
		req.UpdatedAt = time.Now()
	}
	return nil
}
