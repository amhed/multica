//go:build linux

package daemon

import (
	"log/slog"
	"os"
	"path/filepath"
	"syscall"
)

// sweepEnvRootProcesses SIGKILLs every process still running with its working
// directory inside envRoot once a task has ended.
//
// The agent's process-group kill (reapProcessTree) misses descendants that
// started their own process group or session. turbo- and pnpm-run eslint and
// tsgo did exactly that: after the idle watchdog killed codex they kept running
// for hours under the container init, holding gigabytes of swap. They still
// had the task workdir as their cwd, which identifies them however they left
// the group.
func sweepEnvRootProcesses(logger *slog.Logger, envRoot string) {
	if envRoot == "" {
		return
	}
	root, err := filepath.EvalSymlinks(envRoot)
	if err != nil {
		return
	}
	pids := processesUnderDir("/proc", root, os.Getpid())
	if len(pids) == 0 {
		return
	}
	for _, pid := range pids {
		_ = syscall.Kill(pid, syscall.SIGKILL)
	}
	logger.Warn("killed processes left running in the task env root", "env_root", root, "pids", pids)
}
