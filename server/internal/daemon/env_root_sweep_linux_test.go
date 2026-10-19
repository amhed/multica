//go:build linux

package daemon

import (
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

// A tool the agent launched in its own session (turbo- or pnpm-run eslint and
// tsgo) is outside the agent's process group, so reapProcessTree misses it.
// The env-root sweep must still kill it.
func TestSweepEnvRootProcessesKillsProcessThatLeftTheAgentGroup(t *testing.T) {
	envRoot := t.TempDir()
	workdir := filepath.Join(envRoot, "workdir")
	if err := os.MkdirAll(workdir, 0o755); err != nil {
		t.Fatal(err)
	}
	escaped := exec.Command("sleep", "300")
	escaped.Dir = workdir
	escaped.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := escaped.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = escaped.Process.Kill() })
	exited := make(chan error, 1)
	go func() { exited <- escaped.Wait() }()

	sweepEnvRootProcesses(slog.New(slog.NewTextHandler(io.Discard, nil)), envRoot)

	select {
	case <-exited:
	case <-time.After(5 * time.Second):
		t.Fatal("process running in the env root survived the sweep")
	}
}
