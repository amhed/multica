package handler

import (
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
	relayHostSnapshot(w, path, err, "quota snapshot")
}
