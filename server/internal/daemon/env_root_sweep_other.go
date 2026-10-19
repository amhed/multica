//go:build !linux

package daemon

import "log/slog"

// sweepEnvRootProcesses is a no-op where there is no Linux-style /proc to read
// working directories from. Windows tasks already run in a Job Object that
// takes every descendant down with the agent.
func sweepEnvRootProcesses(_ *slog.Logger, _ string) {}
