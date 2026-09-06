package handler

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/multica-ai/multica/server/internal/testutil"
)

func TestGetDeployRelaysSnapshotFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "deploy.json")
	body := `{"schema":"multica.deploy.v1","run":{"status":"completed","conclusion":"success","url":"https://github.com/o/r/actions/runs/1"}}`
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("MULTICA_DEPLOY_FILE", path)

	h := &Handler{}
	var out struct {
		Schema string `json:"schema"`
		Run    struct {
			Conclusion string `json:"conclusion"`
		} `json:"run"`
	}
	testutil.Call(t, h.GetDeploy, httptest.NewRequest(http.MethodGet, "/api/deploy", nil)).
		Want(http.StatusOK).JSON(&out)
	if out.Schema != "multica.deploy.v1" {
		t.Fatalf("schema: got %q", out.Schema)
	}
	if out.Run.Conclusion != "success" {
		t.Fatalf("run.conclusion: got %q", out.Run.Conclusion)
	}
}

func TestGetDeployMissingFileIs404(t *testing.T) {
	t.Setenv("MULTICA_DEPLOY_FILE", filepath.Join(t.TempDir(), "absent.json"))
	h := &Handler{}
	testutil.Call(t, h.GetDeploy, httptest.NewRequest(http.MethodGet, "/api/deploy", nil)).
		Want(http.StatusNotFound)
}

func TestGetDeployInvalidJSONIs500(t *testing.T) {
	path := filepath.Join(t.TempDir(), "deploy.json")
	if err := os.WriteFile(path, []byte("{nope"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("MULTICA_DEPLOY_FILE", path)
	h := &Handler{}
	testutil.Call(t, h.GetDeploy, httptest.NewRequest(http.MethodGet, "/api/deploy", nil)).
		Want(http.StatusInternalServerError)
}
