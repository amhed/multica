package handler

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
)

// deployFilePath returns where the staging deploy snapshot lives. An external
// collector (a cron script wrapping `gh run list`) writes
// ~/.multica/deploy.json on the host; the server only relays it.
// MULTICA_DEPLOY_FILE overrides the location for deployments whose collector
// writes elsewhere and for tests.
func deployFilePath() (string, error) {
	if p := os.Getenv("MULTICA_DEPLOY_FILE"); p != "" {
		return p, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".multica", "deploy.json"), nil
}

// GetDeploy serves the staging deploy snapshot verbatim. 404 means no
// collector has written a snapshot on this host, which the UI treats as
// "nothing to show" rather than an error.
func (h *Handler) GetDeploy(w http.ResponseWriter, r *http.Request) {
	path, err := deployFilePath()
	relayHostSnapshot(w, path, err, "deploy snapshot")
}

// relayHostSnapshot writes a host-side JSON snapshot file to the response.
// Shared by the quota and deploy relays: a missing file is 404 (nothing to
// show), unreadable or non-JSON content is 500.
func relayHostSnapshot(w http.ResponseWriter, path string, pathErr error, name string) {
	if pathErr != nil {
		writeError(w, http.StatusNotFound, name+" not available")
		return
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			writeError(w, http.StatusNotFound, name+" not available")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to read "+name)
		return
	}
	if !json.Valid(data) {
		writeError(w, http.StatusInternalServerError, name+" is not valid JSON")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}
