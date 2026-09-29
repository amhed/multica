package daemon

import (
	"encoding/json"
	"reflect"
	"testing"
)

func decodeMcpServers(t *testing.T, raw json.RawMessage) map[string]map[string]any {
	t.Helper()
	var doc struct {
		McpServers map[string]map[string]any `json:"mcpServers"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("decode expanded config: %v\n%s", err, raw)
	}
	return doc.McpServers
}

func TestExpandAgentMcpConfigFillsHTTPAndStdioFields(t *testing.T) {
	raw := json.RawMessage(`{"mcpServers":{
		"linear":{"type":"http","url":"https://mcp.linear.app/${LINEAR_PATH}","headers":{"Authorization":"Bearer ${LINEAR_API_KEY}"}},
		"notion":{"command":"${NPX_BIN}","args":["-y","--token=${NOTION_API_KEY}"],"env":{"OPENAPI_MCP_HEADERS":"{\"Authorization\":\"Bearer ${NOTION_API_KEY}\"}"}}
	}}`)
	env := map[string]string{
		"LINEAR_PATH":    "mcp",
		"LINEAR_API_KEY": "lin-secret",
		"NPX_BIN":        "npx",
		"NOTION_API_KEY": "ntn-secret",
	}

	out, missing := expandAgentMcpConfigForProvider("codex", raw, env)

	if len(missing) != 0 {
		t.Fatalf("missing = %v, want none", missing)
	}
	servers := decodeMcpServers(t, out)
	if got := servers["linear"]["url"]; got != "https://mcp.linear.app/mcp" {
		t.Errorf("linear url = %v", got)
	}
	if got := servers["linear"]["headers"].(map[string]any)["Authorization"]; got != "Bearer lin-secret" {
		t.Errorf("linear Authorization = %v", got)
	}
	if got := servers["notion"]["command"]; got != "npx" {
		t.Errorf("notion command = %v", got)
	}
	if got := servers["notion"]["args"]; !reflect.DeepEqual(got, []any{"-y", "--token=ntn-secret"}) {
		t.Errorf("notion args = %v", got)
	}
	if got := servers["notion"]["env"].(map[string]any)["OPENAPI_MCP_HEADERS"]; got != `{"Authorization":"Bearer ntn-secret"}` {
		t.Errorf("notion OPENAPI_MCP_HEADERS = %v", got)
	}
}

func TestExpandAgentMcpConfigDefaultsAndMissing(t *testing.T) {
	raw := json.RawMessage(`{"mcpServers":{"s":{"url":"${HOST:-https://fallback.example}/mcp","headers":{
		"A":"${SET:-unused}","B":"${EMPTY:-used}","C":"${NOPE}","D":"${NOPE} ${ALSO_NOPE} ${NOPE}","E":"x${EMPTY}y"}}}}`)
	env := map[string]string{"SET": "value", "EMPTY": ""}

	out, missing := expandAgentMcpConfigForProvider("grok", raw, env)

	if want := []string{"ALSO_NOPE", "NOPE"}; !reflect.DeepEqual(missing, want) {
		t.Fatalf("missing = %v, want %v", missing, want)
	}
	s := decodeMcpServers(t, out)["s"]
	if got := s["url"]; got != "https://fallback.example/mcp" {
		t.Errorf("url = %v", got)
	}
	headers := s["headers"].(map[string]any)
	for key, want := range map[string]string{"A": "value", "B": "used", "C": "${NOPE}", "D": "${NOPE} ${ALSO_NOPE} ${NOPE}", "E": "xy"} {
		if got := headers[key]; got != want {
			t.Errorf("header %s = %v, want %q", key, got, want)
		}
	}
}

func TestExpandAgentMcpConfigOnlyTouchesExpandableFields(t *testing.T) {
	raw := json.RawMessage(`{"mcpServers":{"s":{"type":"${KEY}","url":"$KEY","headers":{"${KEY}":"x"},"tools":["${KEY}"]}},"other":"${KEY}"}`)

	out, missing := expandAgentMcpConfigForProvider("codex", raw, map[string]string{"KEY": "secret"})

	if len(missing) != 0 {
		t.Fatalf("missing = %v, want none", missing)
	}
	var doc map[string]any
	if err := json.Unmarshal(out, &doc); err != nil {
		t.Fatal(err)
	}
	if doc["other"] != "${KEY}" {
		t.Errorf("top-level field expanded: %v", doc["other"])
	}
	s := doc["mcpServers"].(map[string]any)["s"].(map[string]any)
	if s["type"] != "${KEY}" || s["url"] != "$KEY" {
		t.Errorf("type/bare $VAR expanded: type=%v url=%v", s["type"], s["url"])
	}
	if _, ok := s["headers"].(map[string]any)["${KEY}"]; !ok {
		t.Errorf("header name expanded: %v", s["headers"])
	}
	if !reflect.DeepEqual(s["tools"], []any{"${KEY}"}) {
		t.Errorf("tools expanded: %v", s["tools"])
	}
}

func TestExpandAgentMcpConfigSkipsClaude(t *testing.T) {
	raw := json.RawMessage(`{"mcpServers":{"s":{"url":"https://x","headers":{"Authorization":"Bearer ${KEY}"}}}}`)

	out, missing := expandAgentMcpConfigForProvider("claude", raw, map[string]string{"KEY": "secret"})

	if string(out) != string(raw) || missing != nil {
		t.Fatalf("claude config changed: %s (missing %v)", out, missing)
	}
}

func TestExpandAgentMcpConfigIgnoresBlockedEnvKeys(t *testing.T) {
	raw := json.RawMessage(`{"mcpServers":{"s":{"url":"https://x","headers":{"A":"${MULTICA_TOKEN}","B":"${HOME}"}}}}`)

	out, missing := expandAgentMcpConfigForProvider("codex", raw, map[string]string{"MULTICA_TOKEN": "t", "HOME": "/h"})

	if want := []string{"HOME", "MULTICA_TOKEN"}; !reflect.DeepEqual(missing, want) {
		t.Fatalf("missing = %v, want %v", missing, want)
	}
	headers := decodeMcpServers(t, out)["s"]["headers"].(map[string]any)
	if headers["A"] != "${MULTICA_TOKEN}" || headers["B"] != "${HOME}" {
		t.Errorf("blocked keys expanded: %v", headers)
	}
}

func TestExpandAgentMcpConfigPassesThroughUntouchedInput(t *testing.T) {
	for _, raw := range []json.RawMessage{
		nil,
		json.RawMessage(`null`),
		json.RawMessage(`{"mcpServers":{"s":{"url":"https://x",   "headers":{"A":"literal"}}}}`),
		json.RawMessage(`{"mcp":{"s":{"url":"${KEY}"}}}`),
		json.RawMessage(`not json ${KEY}`),
	} {
		out, missing := expandAgentMcpConfigForProvider("codex", raw, map[string]string{"KEY": "secret"})
		if string(out) != string(raw) || missing != nil {
			t.Errorf("input %q changed to %q (missing %v)", raw, out, missing)
		}
	}
}
