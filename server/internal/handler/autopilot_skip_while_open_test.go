package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestUpdateAutopilot_PstackSkipWhileOpen(t *testing.T) {
	agentID := createWebhookTestAgent(t, "SkipWhileOpen Agent")
	apID := createWebhookTestAutopilot(t, agentID, "active", "create_issue")

	patch := func(body map[string]any) AutopilotResponse {
		t.Helper()
		w := httptest.NewRecorder()
		req := newRequest("PATCH", "/api/autopilots/"+apID+"?workspace_id="+testWorkspaceID, body)
		req = withURLParam(req, "id", apID)
		testHandler.UpdateAutopilot(w, req)
		if w.Code != http.StatusOK {
			t.Fatalf("UpdateAutopilot: expected 200, got %d: %s", w.Code, w.Body.String())
		}
		var resp AutopilotResponse
		if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
			t.Fatalf("decode response: %v", err)
		}
		return resp
	}

	if got := patch(map[string]any{"title": "Untouched flag"}); got.PstackSkipWhileOpen {
		t.Fatalf("new autopilot pstack_skip_while_open = true, want false by default")
	}
	if got := patch(map[string]any{"pstack_skip_while_open": true}); !got.PstackSkipWhileOpen {
		t.Fatalf("pstack_skip_while_open = false after enabling it")
	}
	if got := patch(map[string]any{"title": "Flag survives omission"}); !got.PstackSkipWhileOpen {
		t.Fatalf("omitting pstack_skip_while_open reset it to false")
	}
	if got := patch(map[string]any{"pstack_skip_while_open": false}); got.PstackSkipWhileOpen {
		t.Fatalf("pstack_skip_while_open = true after disabling it")
	}
}
