package daemon

import (
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

// writeSamplerProc lays out the /proc files the sampler reads. cpu is the
// aggregate "cpu" line's user..steal columns; guest columns are appended as
// zeros so the parser has to ignore them.
func writeSamplerProc(t *testing.T, dir string, cpu string, blocked int, pswpin, pswpout uint64) {
	t.Helper()
	writeProc(t, dir, "loadavg", "1.00 2.00 3.00 1/100 1234\n")
	writeProc(t, dir, "meminfo", "MemTotal: 8000000 kB\nMemAvailable: 4000000 kB\nSwapTotal: 1000000 kB\nSwapFree: 500000 kB\n")
	writeProc(t, dir, "stat", "cpu  "+cpu+" 0 0\ncpu0 1 2 3 4 5 6 7 8 0 0\nintr 1 2 3\nprocs_running 3\nprocs_blocked "+strconv.Itoa(blocked)+"\n")
	writeProc(t, dir, "vmstat", "nr_free_pages 1\npswpin "+strconv.FormatUint(pswpin, 10)+"\npswpout "+strconv.FormatUint(pswpout, 10)+"\npgmajfault 9\n")
}

func TestHostSampler_FirstSampleHasNoRates(t *testing.T) {
	dir := t.TempDir()
	writeSamplerProc(t, dir, "100 0 100 800 0 0 0 0", 2, 10, 20)
	s := &hostSampler{procRoot: dir, cgroupRoot: t.TempDir(), pageSize: 4096}

	h, ok := s.sample(time.Unix(1000, 0))
	if !ok {
		t.Fatal("expected ok=true")
	}
	if h.CPUBusyPct != nil || h.SwapInKBps != nil || h.SwapOutKBps != nil {
		t.Fatalf("first sample must carry no rates: %+v", h)
	}
	if h.ProcsBlocked == nil || *h.ProcsBlocked != 2 {
		t.Fatalf("procs_blocked is instantaneous and must be set on the first sample: %+v", h.ProcsBlocked)
	}
	if h.Load1 != 1.00 || h.MemTotalKB != 8000000 {
		t.Fatalf("base fields not populated: %+v", h)
	}
}

func TestHostSampler_ComputesRatesFromDeltas(t *testing.T) {
	dir := t.TempDir()
	// user nice system idle iowait irq softirq steal
	writeSamplerProc(t, dir, "100 0 100 800 0 0 0 0", 0, 1000, 2000)
	s := &hostSampler{procRoot: dir, cgroupRoot: t.TempDir(), pageSize: 4096}
	s.sample(time.Unix(1000, 0))

	// +300 busy (user 200, system 100), +100 idle split across idle and
	// iowait: 300 of 400 ticks busy = 75%. iowait counts as idle because a
	// CPU waiting on disk is not doing work.
	// +2560 pages swapped in over 10s at 4 KiB/page = 1024 KiB/s.
	writeSamplerProc(t, dir, "300 0 200 850 50 0 0 0", 1, 1000+2560, 2000+256)
	h, ok := s.sample(time.Unix(1010, 0))
	if !ok {
		t.Fatal("expected ok=true")
	}
	if h.CPUBusyPct == nil || *h.CPUBusyPct != 75 {
		t.Fatalf("cpu_busy_pct: got %v, want 75", deref(h.CPUBusyPct))
	}
	if h.SwapInKBps == nil || *h.SwapInKBps != 1024 {
		t.Fatalf("swap_in_kbps: got %v, want 1024", deref(h.SwapInKBps))
	}
	if h.SwapOutKBps == nil || *h.SwapOutKBps != 102.4 {
		t.Fatalf("swap_out_kbps: got %v, want 102.4", deref(h.SwapOutKBps))
	}
	if *h.ProcsBlocked != 1 {
		t.Fatalf("procs_blocked: got %d, want 1", *h.ProcsBlocked)
	}
}

// Several heartbeat connections can sample within the same instant; a
// near-zero window would turn one tick of noise into a huge rate, so a sample
// taken within a second of the previous one reuses it.
func TestHostSampler_ReusesSampleWithinOneSecond(t *testing.T) {
	dir := t.TempDir()
	writeSamplerProc(t, dir, "100 0 100 800 0 0 0 0", 0, 0, 0)
	s := &hostSampler{procRoot: dir, cgroupRoot: t.TempDir(), pageSize: 4096}
	s.sample(time.Unix(1000, 0))
	writeSamplerProc(t, dir, "200 0 100 800 0 0 0 0", 0, 0, 0)
	first, _ := s.sample(time.Unix(1010, 0))

	writeSamplerProc(t, dir, "900 0 100 800 0 0 0 0", 0, 0, 0)
	again, _ := s.sample(time.Unix(1010, 500_000_000))
	if again != first {
		t.Fatalf("expected the cached sample within 1s, got a new one: %+v", again)
	}
}

func TestHostSampler_MissingProcFiles(t *testing.T) {
	s := &hostSampler{procRoot: t.TempDir(), cgroupRoot: t.TempDir(), pageSize: 4096}
	if _, ok := s.sample(time.Unix(1000, 0)); ok {
		t.Fatal("expected ok=false when /proc files are absent")
	}
}

// A missing /proc/stat or /proc/vmstat (a restricted container) drops only the
// signals that need it; load/mem/swap still report.
func TestHostSampler_MissingRateFilesKeepsBaseFields(t *testing.T) {
	dir := t.TempDir()
	writeProc(t, dir, "loadavg", "1.00 2.00 3.00 1/100 1234\n")
	writeProc(t, dir, "meminfo", "MemTotal: 8000000 kB\nMemAvailable: 4000000 kB\n")
	s := &hostSampler{procRoot: dir, cgroupRoot: t.TempDir(), pageSize: 4096}
	s.sample(time.Unix(1000, 0))
	h, ok := s.sample(time.Unix(1010, 0))
	if !ok {
		t.Fatal("expected ok=true")
	}
	if h.CPUBusyPct != nil || h.SwapInKBps != nil || h.ProcsBlocked != nil {
		t.Fatalf("signals without a source file must stay nil: %+v", h)
	}
}

func writeCgroup(t *testing.T, procRoot, cgroupRoot, path string, files map[string]string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(procRoot, "self"), 0o755); err != nil {
		t.Fatal(err)
	}
	writeProc(t, filepath.Join(procRoot, "self"), "cgroup", "0::"+path+"\n")
	dir := filepath.Join(cgroupRoot, path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	for name, body := range files {
		writeProc(t, dir, name, body)
	}
}

func TestHostSampler_CgroupMemoryUsesTightestLimit(t *testing.T) {
	cases := []struct {
		name      string
		high, max string
		wantLimit uint64
	}{
		{"high below max", "16106127360\n", "17179869184\n", 15728640},
		{"only max", "max\n", "19327352832\n", 18874368},
		{"unlimited", "max\n", "max\n", 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dir, cg := t.TempDir(), t.TempDir()
			writeSamplerProc(t, dir, "100 0 100 800 0 0 0 0", 0, 0, 0)
			writeCgroup(t, dir, cg, "/user.slice/multica-daemon.service", map[string]string{
				"memory.current": "4238786560\n",
				"memory.high":    tc.high,
				"memory.max":     tc.max,
			})
			s := &hostSampler{procRoot: dir, cgroupRoot: cg, pageSize: 4096}
			h, _ := s.sample(time.Unix(1000, 0))
			if h.CgroupMemCurrentKB != 4139440 {
				t.Fatalf("cgroup_mem_current_kb: got %d, want 4139440", h.CgroupMemCurrentKB)
			}
			if h.CgroupMemLimitKB != tc.wantLimit {
				t.Fatalf("cgroup_mem_limit_kb: got %d, want %d", h.CgroupMemLimitKB, tc.wantLimit)
			}
		})
	}
}

func TestHostSampler_NoCgroupV2LeavesMemoryUnset(t *testing.T) {
	dir := t.TempDir()
	writeSamplerProc(t, dir, "100 0 100 800 0 0 0 0", 0, 0, 0)
	s := &hostSampler{procRoot: dir, cgroupRoot: t.TempDir(), pageSize: 4096}
	h, _ := s.sample(time.Unix(1000, 0))
	if h.CgroupMemCurrentKB != 0 || h.CgroupMemLimitKB != 0 {
		t.Fatalf("expected no cgroup memory without /proc/self/cgroup: %+v", h)
	}
}

func deref(p *float64) any {
	if p == nil {
		return nil
	}
	return *p
}
