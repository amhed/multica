package daemon

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// processesUnderDir returns the pids listed in procRoot whose working
// directory is dir or a path inside it, excluding self. It reads each pid's
// cwd symlink, so dir must be a resolved path. Pids whose cwd cannot be read
// (exited, or owned by another user) are skipped.
func processesUnderDir(procRoot, dir string, self int) []int {
	entries, err := os.ReadDir(procRoot)
	if err != nil {
		return nil
	}
	var pids []int
	for _, entry := range entries {
		pid, err := strconv.Atoi(entry.Name())
		if err != nil || pid == self {
			continue
		}
		cwd, err := os.Readlink(filepath.Join(procRoot, entry.Name(), "cwd"))
		if err != nil {
			continue
		}
		// The kernel appends this marker when the directory has been removed.
		cwd = strings.TrimSuffix(cwd, " (deleted)")
		if cwd == dir || strings.HasPrefix(cwd, dir+string(filepath.Separator)) {
			pids = append(pids, pid)
		}
	}
	return pids
}
