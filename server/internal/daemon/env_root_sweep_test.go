package daemon

import (
	"os"
	"path/filepath"
	"slices"
	"testing"
)

// fakeProcEntry adds <procRoot>/<pid>/cwd as a symlink to cwd, the shape the
// sweep reads from a Linux /proc.
func fakeProcEntry(t *testing.T, procRoot, pid, cwd string) {
	t.Helper()
	dir := filepath.Join(procRoot, pid)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(cwd, filepath.Join(dir, "cwd")); err != nil {
		t.Fatal(err)
	}
}

func TestProcessesUnderDirSelectsOnlyProcessesInsideTheEnvRoot(t *testing.T) {
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	envRoot := filepath.Join(base, "ws", "pai-478-abc")
	workdir := filepath.Join(envRoot, "workdir", "monorepo")
	// Shares envRoot as a string prefix but is a different task's root.
	sibling := filepath.Join(base, "ws", "pai-478-abcdef")
	for _, dir := range []string{workdir, sibling} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}

	procRoot := t.TempDir()
	fakeProcEntry(t, procRoot, "101", workdir)
	fakeProcEntry(t, procRoot, "102", envRoot)
	fakeProcEntry(t, procRoot, "103", sibling)
	fakeProcEntry(t, procRoot, "104", "/")
	fakeProcEntry(t, procRoot, "105", workdir+" (deleted)")
	fakeProcEntry(t, procRoot, "999", workdir) // the daemon itself
	if err := os.MkdirAll(filepath.Join(procRoot, "self"), 0o755); err != nil {
		t.Fatal(err)
	}
	// A pid whose cwd cannot be read (exited, or owned by another user).
	if err := os.MkdirAll(filepath.Join(procRoot, "106"), 0o755); err != nil {
		t.Fatal(err)
	}

	got := processesUnderDir(procRoot, envRoot, 999)
	slices.Sort(got)
	if want := []int{101, 102, 105}; !slices.Equal(got, want) {
		t.Fatalf("processesUnderDir = %v, want %v", got, want)
	}
}
