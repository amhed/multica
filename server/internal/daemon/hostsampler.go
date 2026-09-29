package daemon

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/multica-ai/multica/server/pkg/protocol"
)

// minSampleInterval guards the rate window. Several heartbeat connections can
// sample within the same instant, and a near-zero window turns one tick of
// counter noise into a huge rate, so a sample this close to the previous one
// reuses it.
const minSampleInterval = time.Second

// hostSampler extends collectHostHealth with saturation signals. Load average
// lags by up to 15 minutes and also counts processes waiting on disk, so it
// cannot tell "busy" from "stuck swapping"; CPU busy % and swap in/out rates
// are computed from cumulative /proc counters between consecutive samples,
// and the daemon's cgroup memory shows how close its agents are to the limit
// that throttles them.
type hostSampler struct {
	procRoot   string // normally "/proc"
	cgroupRoot string // normally "/sys/fs/cgroup"
	pageSize   int

	mu     sync.Mutex
	prev   hostCounters
	prevAt time.Time
	last   *protocol.DaemonHost
}

func newHostSampler() *hostSampler {
	return &hostSampler{procRoot: "/proc", cgroupRoot: "/sys/fs/cgroup", pageSize: os.Getpagesize()}
}

// hostCounters are the cumulative counters rates are derived from. The ok
// flags record whether the source file was readable, so a missing file never
// produces a rate against zero.
type hostCounters struct {
	cpuOK             bool
	cpuTotal, cpuIdle uint64
	swapOK            bool
	pswpin, pswpout   uint64
}

func (s *hostSampler) sample(now time.Time) (*protocol.DaemonHost, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.last != nil && now.Sub(s.prevAt) < minSampleInterval {
		return s.last, true
	}

	host, ok := collectHostHealth(s.procRoot)
	if !ok {
		return nil, false
	}

	cur := hostCounters{}
	stat, _ := readKeyedFields(s.procRoot + "/stat")
	if cpu, found := stat["cpu"]; found && len(cpu) >= 8 {
		// user nice system idle iowait irq softirq steal. guest/guest_nice
		// are already included in user/nice, so they are not summed again.
		for i := 0; i < 8; i++ {
			cur.cpuTotal += cpu[i]
		}
		// A CPU waiting on disk is not doing work: iowait counts as idle.
		cur.cpuIdle = cpu[3] + cpu[4]
		cur.cpuOK = true
	}
	if blocked, found := stat["procs_blocked"]; found && len(blocked) > 0 {
		n := int(blocked[0])
		host.ProcsBlocked = &n
	}
	vm, _ := readKeyedFields(s.procRoot + "/vmstat")
	if in, okIn := vm["pswpin"]; okIn && len(in) > 0 {
		if out, okOut := vm["pswpout"]; okOut && len(out) > 0 {
			cur.pswpin, cur.pswpout, cur.swapOK = in[0], out[0], true
		}
	}

	if s.last != nil {
		dt := now.Sub(s.prevAt).Seconds()
		if cur.cpuOK && s.prev.cpuOK && cur.cpuTotal > s.prev.cpuTotal {
			total := float64(cur.cpuTotal - s.prev.cpuTotal)
			idle := float64(cur.cpuIdle - s.prev.cpuIdle)
			busy := 100 * (1 - idle/total)
			host.CPUBusyPct = &busy
		}
		if cur.swapOK && s.prev.swapOK && cur.pswpin >= s.prev.pswpin && cur.pswpout >= s.prev.pswpout {
			kbPerPage := float64(s.pageSize) / 1024
			in := float64(cur.pswpin-s.prev.pswpin) * kbPerPage / dt
			out := float64(cur.pswpout-s.prev.pswpout) * kbPerPage / dt
			host.SwapInKBps, host.SwapOutKBps = &in, &out
		}
	}

	host.CgroupMemCurrentKB, host.CgroupMemLimitKB = s.cgroupMemory()

	s.prev, s.prevAt, s.last = cur, now, host
	return host, true
}

// cgroupMemory reads memory.current and the tightest of memory.high and
// memory.max for the daemon's own cgroup v2 group, in KiB. It returns zeros
// when the group is not visible (cgroup v1, non-Linux).
func (s *hostSampler) cgroupMemory() (currentKB, limitKB uint64) {
	raw, err := os.ReadFile(s.procRoot + "/self/cgroup")
	if err != nil {
		return 0, 0
	}
	var rel string
	for _, line := range strings.Split(string(raw), "\n") {
		if p, found := strings.CutPrefix(line, "0::"); found {
			rel = strings.TrimSpace(p)
			break
		}
	}
	if rel == "" {
		return 0, 0
	}
	dir := filepath.Join(s.cgroupRoot, rel)
	current, ok := readCgroupBytes(filepath.Join(dir, "memory.current"))
	if !ok {
		return 0, 0
	}
	var limit uint64
	for _, name := range []string{"memory.high", "memory.max"} {
		if v, ok := readCgroupBytes(filepath.Join(dir, name)); ok && (limit == 0 || v < limit) {
			limit = v
		}
	}
	return current / 1024, limit / 1024
}

// readCgroupBytes parses a single-value cgroup file. "max" (unlimited) reads
// as not-ok so it never becomes a limit.
func readCgroupBytes(path string) (uint64, bool) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return 0, false
	}
	v, err := strconv.ParseUint(strings.TrimSpace(string(raw)), 10, 64)
	if err != nil {
		return 0, false
	}
	return v, true
}

// readKeyedFields parses "key v1 v2 ..." lines, the shape of /proc/stat and
// /proc/vmstat. Non-numeric values end a line's field list.
func readKeyedFields(path string) (map[string][]uint64, bool) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, false
	}
	out := make(map[string][]uint64)
	for _, line := range strings.Split(string(raw), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		vals := make([]uint64, 0, len(fields)-1)
		for _, f := range fields[1:] {
			v, err := strconv.ParseUint(f, 10, 64)
			if err != nil {
				break
			}
			vals = append(vals, v)
		}
		out[fields[0]] = vals
	}
	return out, true
}
