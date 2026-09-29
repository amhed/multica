package daemon

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// writeFakeProc adds /proc/<pid> with the files the process walk reads.
// ticks is utime+stime (split evenly), startTicks is the start time in clock
// ticks since boot, and rssPages is the resident page count.
func writeFakeProc(t *testing.T, procRoot string, pid int, cwd string, argv []string, ticks, startTicks, rssPages uint64) {
	t.Helper()
	dir := filepath.Join(procRoot, strconv.Itoa(pid))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	// Fields after the ")" of comm: state(3) ... utime(14) stime(15) ...
	// starttime(22). The comm contains a space and a ")" to prove the parser
	// splits on the last one.
	after := make([]string, 20)
	for i := range after {
		after[i] = "0"
	}
	after[0] = "S"
	after[11] = strconv.FormatUint(ticks/2, 10)
	after[12] = strconv.FormatUint(ticks-ticks/2, 10)
	after[19] = strconv.FormatUint(startTicks, 10)
	writeProc(t, dir, "stat", strconv.Itoa(pid)+" (we ird) "+strings.Join(after, " ")+" 0 0\n")
	writeProc(t, dir, "statm", "1000 "+strconv.FormatUint(rssPages, 10)+" 50 1 0 100 0\n")
	writeProc(t, dir, "cmdline", strings.Join(argv, "\x00")+"\x00")
	if err := os.Symlink(cwd, filepath.Join(dir, "cwd")); err != nil {
		t.Fatal(err)
	}
}

// procFixture is a host with two running tasks, a stale orphan, a young
// orphan, and an unrelated process, sampled at uptime 20000s.
func procFixture(t *testing.T) (*hostSampler, []hostTask) {
	t.Helper()
	proc := t.TempDir()
	root := "/home/node/workspaces"
	writeSamplerProc(t, proc, "1000 0 0 1000 0 0 0 0", 0, 0, 0)
	writeProc(t, proc, "uptime", "20000.00 60000.00\n")

	a := root + "/ws-a/pai-322-aaaa"
	b := root + "/ws-b/pai-297-bbbb"
	// Task A: the agent CLI plus a large tsgo started 4h31m before the sample.
	writeFakeProc(t, proc, 101, a+"/workdir", []string{"/usr/local/bin/claude.exe", "-p", "--resume", "0f3c9e1a-session"}, 0, 1_900_000, 25600)
	writeFakeProc(t, proc, 102, a+"/workdir/monorepo", []string{"/w/node_modules/.bin/tsgo", "--build"}, 0, 374_000, 1_600_000)
	// Task B: one process.
	writeFakeProc(t, proc, 201, b+"/workdir", []string{"node", "../../scripts/vitest.mjs", "run", "--project=server"}, 0, 1_990_000, 51200)
	// Orphan in a finished task's dir, 2h old: stale.
	writeFakeProc(t, proc, 301, root+"/ws-a/pai-100-dead/workdir", []string{"eslint", "."}, 0, 1_280_000, 12800)
	// Orphan 10 minutes old: too young to call stale.
	writeFakeProc(t, proc, 302, root+"/ws-a/pai-101-dead/workdir", []string{"vitest"}, 0, 1_940_000, 12800)
	// Outside the workspaces root: never attributed.
	writeFakeProc(t, proc, 401, "/", []string{"/usr/bin/alloy", "run"}, 0, 100, 99999)

	s := &hostSampler{procRoot: proc, cgroupRoot: t.TempDir(), pageSize: 4096, workspacesRoot: root}
	tasks := []hostTask{
		{TaskID: "task-a", WorkspaceID: "ws-a", IssueID: "issue-a", IssueIdentifier: "PAI-322", AgentName: "Claude Senior Dev", RootDir: a},
		{TaskID: "task-b", WorkspaceID: "ws-b", IssueID: "issue-b", IssueIdentifier: "PAI-297", AgentName: "Codex Senior Dev", RootDir: b},
	}
	return s, tasks
}

func TestHostSampler_AttributesProcessesToTasks(t *testing.T) {
	s, tasks := procFixture(t)
	h, ok := s.sample(time.Unix(1000, 0), tasks)
	if !ok {
		t.Fatal("expected ok=true")
	}
	if len(h.Tasks) != 2 {
		t.Fatalf("expected 2 task groups, got %+v", h.Tasks)
	}
	// Sorted by memory, largest first.
	a := h.Tasks[0]
	if a.TaskID != "task-a" || a.IssueIdentifier != "PAI-322" || a.WorkspaceID != "ws-a" || a.AgentName != "Claude Senior Dev" {
		t.Fatalf("task A identity: %+v", a)
	}
	if a.Procs != 2 || a.RSSKB != (25600+1_600_000)*4 {
		t.Fatalf("task A footprint: procs=%d rss_kb=%d", a.Procs, a.RSSKB)
	}
	if a.TopCmd != "tsgo --build" {
		t.Fatalf("task A top cmd: %q", a.TopCmd)
	}
	if a.TopCmdAgeS != 16260 {
		t.Fatalf("task A top cmd age: got %d, want 16260 (4h31m)", a.TopCmdAgeS)
	}
	if b := h.Tasks[1]; b.TaskID != "task-b" || b.Procs != 1 || b.TopCmd != "node vitest.mjs run --project" {
		t.Fatalf("task B: %+v", b)
	}
	if h.Stale == nil || h.Stale.Procs != 1 || h.Stale.RSSKB != 12800*4 || h.Stale.TopCmd != "eslint" || h.Stale.TopCmdAgeS != 7200 {
		t.Fatalf("stale group: %+v", h.Stale)
	}
}

func TestHostSampler_TaskWithoutProcessesStillListed(t *testing.T) {
	s, tasks := procFixture(t)
	tasks = append(tasks, hostTask{TaskID: "task-c", WorkspaceID: "ws-a", RootDir: "/home/node/workspaces/ws-a/pai-5-cccc"})
	h, _ := s.sample(time.Unix(1000, 0), tasks)
	if len(h.Tasks) != 3 || h.Tasks[2].TaskID != "task-c" || h.Tasks[2].Procs != 0 {
		t.Fatalf("a registered task with no processes should still be listed last: %+v", h.Tasks)
	}
}

// A directory that merely shares a prefix with a task root is not inside it.
func TestHostSampler_TaskRootMatchIsPathAware(t *testing.T) {
	s, tasks := procFixture(t)
	writeFakeProc(t, s.procRoot, 501, "/home/node/workspaces/ws-a/pai-322-aaaa-other/workdir", []string{"sleep"}, 0, 1_990_000, 10)
	h, _ := s.sample(time.Unix(1000, 0), tasks)
	if h.Tasks[0].Procs != 2 {
		t.Fatalf("prefix-sibling dir was attributed to task A: %+v", h.Tasks[0])
	}
}

func TestHostSampler_TaskCPUShareOverInterval(t *testing.T) {
	s, tasks := procFixture(t)
	first, _ := s.sample(time.Unix(1000, 0), tasks)
	if first.Tasks[0].CPUPct != 0 {
		t.Fatalf("first sample has no interval, cpu_pct must be 0: %v", first.Tasks[0].CPUPct)
	}

	// The machine accrues 400 ticks; task A's tsgo accrues 100 of them.
	writeSamplerProc(t, s.procRoot, "1300 0 0 1100 0 0 0 0", 0, 0, 0)
	stat := filepath.Join(s.procRoot, "102", "stat")
	raw, _ := os.ReadFile(stat)
	fields := strings.Fields(string(raw))
	// fields[14], fields[15] are utime, stime in the full line ("102",
	// "(we", "ird)" come first).
	fields[14], fields[15] = "50", "50"
	writeProc(t, filepath.Join(s.procRoot, "102"), "stat", strings.Join(fields, " ")+"\n")

	h, _ := s.sample(time.Unix(1015, 0), tasks)
	if h.Tasks[0].CPUPct != 25 {
		t.Fatalf("task A cpu share: got %v, want 25", h.Tasks[0].CPUPct)
	}
}

func TestSanitizeCmdline(t *testing.T) {
	cases := []struct {
		argv []string
		want string
	}{
		{[]string{"/w/node_modules/@typescript/native-preview-linux-arm64/lib/tsgo", "--noEmit"}, "tsgo --noEmit"},
		{[]string{"node", "../../scripts/tsgo.mjs", "--build"}, "node tsgo.mjs --build"},
		{[]string{"/home/node/.cache/pnpm-native", "--filter", "@moni/common", "--filter", "@moni/common-react", "build"}, "pnpm-native --filter build"},
		{[]string{"/usr/local/bin/claude.exe", "-p", "--output-format", "stream-json", "--resume", "0f3c9e1a-5b2d-4c1e-9a7f-2d7c1b9e0a11"}, "claude.exe -p --output-format stream-json --resume"},
		{[]string{"curl", "-H", "Authorization: Bearer sk-live-abc", "--token=ghp_secret", "https://x"}, "curl -H --token"},
		{[]string{"python3", "-c", "print(1)"}, "python3 -c"},
		{[]string{"mysql", "-pS3cret", "-h", "db"}, "mysql -h db"},
		{nil, ""},
	}
	for _, tc := range cases {
		if got := sanitizeCmdline(tc.argv); got != tc.want {
			t.Errorf("sanitizeCmdline(%q) = %q, want %q", tc.argv, got, tc.want)
		}
	}
}
