package daemon

import (
	"os"
	"path/filepath"
	"testing"
)

func writeProc(t *testing.T, dir, name, body string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
		t.Fatalf("write %s: %v", name, err)
	}
}

func TestCollectHostHealth_ParsesLoadAndMem(t *testing.T) {
	dir := t.TempDir()
	writeProc(t, dir, "loadavg", "65.73 64.72 60.10 3/1234 98765\n")
	writeProc(t, dir, "meminfo", "MemTotal:       16384000 kB\nMemFree:          100000 kB\nMemAvailable:    9500000 kB\nSwapTotal:       4194304 kB\nSwapFree:            156 kB\nBuffers:           12345 kB\n")

	h, ok := collectHostHealth(dir)
	if !ok {
		t.Fatal("expected ok=true")
	}
	if h.Load1 != 65.73 || h.Load5 != 64.72 || h.Load15 != 60.10 {
		t.Fatalf("load parse: %+v", h)
	}
	if h.MemTotalKB != 16384000 || h.MemAvailableKB != 9500000 {
		t.Fatalf("mem parse: %+v", h)
	}
	if h.SwapTotalKB != 4194304 || h.SwapFreeKB != 156 {
		t.Fatalf("swap parse: %+v", h)
	}
	if h.NCPU < 1 {
		t.Fatalf("ncpu should be >=1, got %d", h.NCPU)
	}
}

func TestCollectHostHealth_MissingFiles(t *testing.T) {
	if _, ok := collectHostHealth(t.TempDir()); ok {
		t.Fatal("expected ok=false when /proc files are absent")
	}
}

func TestCollectHostHealth_MalformedLoadavg(t *testing.T) {
	dir := t.TempDir()
	writeProc(t, dir, "loadavg", "not-a-number\n")
	writeProc(t, dir, "meminfo", "MemTotal: 1 kB\n")
	if _, ok := collectHostHealth(dir); ok {
		t.Fatal("expected ok=false for malformed loadavg")
	}
}
