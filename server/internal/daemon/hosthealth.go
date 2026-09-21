package daemon

import (
	"os"
	"runtime"
	"strconv"
	"strings"

	"github.com/multica-ai/multica/server/pkg/protocol"
)

// collectHostHealth reads machine-wide load, memory and swap from procRoot
// (normally "/proc") and returns a snapshot. It returns ok=false when the
// files are absent (non-Linux host) or unparseable, so callers omit the block
// rather than reporting zeros.
func collectHostHealth(procRoot string) (*protocol.DaemonHost, bool) {
	load, ok := parseLoadavg(procRoot + "/loadavg")
	if !ok {
		return nil, false
	}
	mem, ok := parseMeminfo(procRoot + "/meminfo")
	if !ok {
		return nil, false
	}
	return &protocol.DaemonHost{
		NCPU:           runtime.NumCPU(),
		Load1:          load[0],
		Load5:          load[1],
		Load15:         load[2],
		MemTotalKB:     mem["MemTotal"],
		MemAvailableKB: mem["MemAvailable"],
		SwapTotalKB:    mem["SwapTotal"],
		SwapFreeKB:     mem["SwapFree"],
	}, true
}

func parseLoadavg(path string) ([3]float64, bool) {
	var out [3]float64
	raw, err := os.ReadFile(path)
	if err != nil {
		return out, false
	}
	fields := strings.Fields(string(raw))
	if len(fields) < 3 {
		return out, false
	}
	for i := 0; i < 3; i++ {
		v, err := strconv.ParseFloat(fields[i], 64)
		if err != nil {
			return out, false
		}
		out[i] = v
	}
	return out, true
}

// parseMeminfo returns the kB values for the keys the health snapshot needs.
// /proc/meminfo lines look like "MemTotal:       16384000 kB".
func parseMeminfo(path string) (map[string]uint64, bool) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, false
	}
	out := make(map[string]uint64, 4)
	for _, line := range strings.Split(string(raw), "\n") {
		key, rest, found := strings.Cut(line, ":")
		if !found {
			continue
		}
		fields := strings.Fields(rest)
		if len(fields) == 0 {
			continue
		}
		v, err := strconv.ParseUint(fields[0], 10, 64)
		if err != nil {
			continue
		}
		out[key] = v
	}
	if len(out) == 0 {
		return nil, false
	}
	return out, true
}
