package daemon

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// reaperCommand builds the argv for the host reaper. Always JSON output;
// --apply only for the apply mode; never --include-runtime (leaked tooling
// only, per the UX-trigger design — the daemon must never let an admin kill
// a running agent runtime through this path).
func reaperCommand(scriptPath, mode string) []string {
	argv := []string{scriptPath, "--json"}
	if mode == "apply" {
		argv = append(argv, "--apply")
	}
	return argv
}

// reaperScriptPath resolves the multica-reap.sh script to run. Resolution
// order mirrors ResolveWorkspacesRoot's MULTICA_* env-override idiom:
// explicit env override, then a scripts/ directory alongside the daemon
// binary, then PATH.
func reaperScriptPath() (string, error) {
	if p := strings.TrimSpace(os.Getenv("MULTICA_REAP_SCRIPT_PATH")); p != "" {
		return p, nil
	}
	if exe, err := os.Executable(); err == nil {
		candidate := filepath.Join(filepath.Dir(exe), "scripts", "multica-reap.sh")
		if _, statErr := os.Stat(candidate); statErr == nil {
			return candidate, nil
		}
	}
	if p, err := exec.LookPath("multica-reap.sh"); err == nil {
		return p, nil
	}
	return "", fmt.Errorf("reaper script not found (set MULTICA_REAP_SCRIPT_PATH)")
}

// handleHostReap runs the host reaper for a queued host-health request and
// reports the outcome back to the server. It never passes --include-runtime
// (see reaperCommand) — this path is tooling-only, by design.
func (d *Daemon) handleHostReap(ctx context.Context, rt Runtime, requestID, mode string) {
	d.logger.Info("host reap requested", "runtime_id", rt.ID, "request_id", requestID, "mode", mode)

	scriptPath, err := reaperScriptPath()
	if err != nil {
		d.reportHostReapResult(ctx, rt, requestID, map[string]any{
			"status": "failed",
			"error":  err.Error(),
		})
		return
	}

	argv := reaperCommand(scriptPath, mode)
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		d.reportHostReapResult(ctx, rt, requestID, map[string]any{
			"status": "failed",
			"error":  fmt.Sprintf("%s: %s", err, strings.TrimSpace(stderr.String())),
		})
		return
	}

	result := json.RawMessage(stdout.Bytes())
	if !json.Valid(result) {
		d.reportHostReapResult(ctx, rt, requestID, map[string]any{
			"status": "failed",
			"error":  "reaper produced invalid JSON",
		})
		return
	}

	d.reportHostReapResult(ctx, rt, requestID, map[string]any{
		"status": "completed",
		"result": result,
	})
}

// reportHostReapResult reports a host-reap outcome back to the server,
// retrying on transient failures like reportModelListResult.
func (d *Daemon) reportHostReapResult(ctx context.Context, rt Runtime, requestID string, payload map[string]any) {
	d.reportRuntimeResultWithRetry(ctx, "host_reap", rt.ID, requestID, func(ctx context.Context) error {
		return d.client.ReportHostReapResult(ctx, rt.ID, requestID, payload)
	})
}
