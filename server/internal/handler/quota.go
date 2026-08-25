package handler

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
)

// quotaFilePath returns where the provider quota snapshot lives. An external
// collector (OpenUsage) writes ~/.multica/quota.json on the host; the server
// only relays it. MULTICA_QUOTA_FILE overrides the location for deployments
// whose collector writes elsewhere and for tests.
func quotaFilePath() (string, error) {
	if p := os.Getenv("MULTICA_QUOTA_FILE"); p != "" {
		return p, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".multica", "quota.json"), nil
}

// GetQuota serves the provider quota snapshot verbatim. 404 means no
// collector has written a snapshot on this host, which the UI treats as
// "nothing to show" rather than an error.
func (h *Handler) GetQuota(w http.ResponseWriter, r *http.Request) {
	path, err := quotaFilePath()
	if err != nil {
		writeError(w, http.StatusNotFound, "quota snapshot not available")
		return
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			writeError(w, http.StatusNotFound, "quota snapshot not available")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to read quota snapshot")
		return
	}
	if !json.Valid(data) {
		writeError(w, http.StatusInternalServerError, "quota snapshot is not valid JSON")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}
