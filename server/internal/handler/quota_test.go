package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/multica-ai/multica/server/internal/testutil"
)

func TestGetQuotaRelaysSnapshotFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "quota.json")
	body := `{"schema":"openusage.limits.v1","providers":{"claude":{"displayName":"Claude","resources":{}}}}`
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("MULTICA_QUOTA_FILE", path)

	h := &Handler{}
	var out struct {
		Schema    string                     `json:"schema"`
		Providers map[string]json.RawMessage `json:"providers"`
	}
	testutil.Call(t, h.GetQuota, httptest.NewRequest(http.MethodGet, "/api/quota", nil)).
		Want(http.StatusOK).JSON(&out)
	if out.Schema != "openusage.limits.v1" {
		t.Fatalf("schema: got %q", out.Schema)
	}
	if _, ok := out.Providers["claude"]; !ok {
		t.Fatalf("providers: claude missing from %v", out.Providers)
	}
}

func TestGetQuotaMissingFileIs404(t *testing.T) {
	t.Setenv("MULTICA_QUOTA_FILE", filepath.Join(t.TempDir(), "absent.json"))
	h := &Handler{}
	testutil.Call(t, h.GetQuota, httptest.NewRequest(http.MethodGet, "/api/quota", nil)).
		Want(http.StatusNotFound)
}

func TestGetQuotaInvalidJSONIs500(t *testing.T) {
	path := filepath.Join(t.TempDir(), "quota.json")
	if err := os.WriteFile(path, []byte("{nope"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("MULTICA_QUOTA_FILE", path)
	h := &Handler{}
	testutil.Call(t, h.GetQuota, httptest.NewRequest(http.MethodGet, "/api/quota", nil)).
		Want(http.StatusInternalServerError)
}
