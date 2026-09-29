package daemon

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/multica-ai/multica/server/pkg/protocol"
)

// userHZ is the clock-tick unit of /proc/<pid>/stat start times. It is a
// fixed kernel ABI constant (USER_HZ) on every architecture the daemon ships
// for, independent of the kernel's internal CONFIG_HZ.
const userHZ = 100

// staleProcAge matches the reaper's default --min-age: an orphan younger than
// this may be a task's process still shutting down.
const staleProcAge = 30 * 60

// hostTask is what the process walk needs to know about a running task.
type hostTask struct {
	TaskID          string
	WorkspaceID     string
	IssueID         string
	IssueIdentifier string
	AgentName       string
	RootDir         string // the task's execution env root; its processes run below it
}

func (d *Daemon) registerHostTask(t hostTask) {
	d.hostTasksMu.Lock()
	defer d.hostTasksMu.Unlock()
	if d.hostTasks == nil {
		d.hostTasks = make(map[string]hostTask)
	}
	d.hostTasks[t.TaskID] = t
}

func (d *Daemon) clearHostTask(taskID string) {
	d.hostTasksMu.Lock()
	delete(d.hostTasks, taskID)
	d.hostTasksMu.Unlock()
}

func (d *Daemon) runningHostTasks() []hostTask {
	d.hostTasksMu.Lock()
	defer d.hostTasksMu.Unlock()
	out := make([]hostTask, 0, len(d.hostTasks))
	for _, t := range d.hostTasks {
		out = append(out, t)
	}
	return out
}

// procKey identifies a process across samples; the start time guards
// against pid reuse between them.
type procKey struct {
	pid   int
	start uint64
}

type procInfo struct {
	key   procKey
	cwd   string
	argv  []string
	ticks uint64 // utime + stime
	rssKB uint64
	ageS  int64
}

// walkProcs reads every process whose working directory is inside the
// workspaces root. Processes that exit mid-walk are skipped.
func (s *hostSampler) walkProcs(uptimeS float64) []procInfo {
	entries, err := os.ReadDir(s.procRoot)
	if err != nil {
		return nil
	}
	var out []procInfo
	for _, e := range entries {
		pid, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		dir := filepath.Join(s.procRoot, e.Name())
		cwd, err := os.Readlink(filepath.Join(dir, "cwd"))
		if err != nil || !pathWithin(cwd, s.workspacesRoot) {
			continue
		}
		ticks, start, ok := readProcStat(filepath.Join(dir, "stat"))
		if !ok {
			continue
		}
		rssPages, ok := readStatmRSS(filepath.Join(dir, "statm"))
		if !ok {
			continue
		}
		rawArgv, _ := os.ReadFile(filepath.Join(dir, "cmdline"))
		out = append(out, procInfo{
			key:   procKey{pid: pid, start: start},
			cwd:   cwd,
			argv:  strings.Split(strings.TrimRight(string(rawArgv), "\x00"), "\x00"),
			ticks: ticks,
			rssKB: rssPages * uint64(s.pageSize) / 1024,
			ageS:  int64(uptimeS - float64(start)/userHZ),
		})
	}
	return out
}

// attributeProcs groups processes by the task whose root they run in, and
// sums orphans older than staleProcAge. CPU share is the process's tick delta
// over the machine's, so it needs the previous sample's per-process ticks.
func attributeProcs(procs []procInfo, tasks []hostTask, prevTicks map[procKey]uint64, cpuDelta uint64) ([]protocol.DaemonHostTask, *protocol.DaemonHostProcs) {
	groups := make([]protocol.DaemonHostTask, len(tasks))
	tops := make([]*procInfo, len(tasks))
	for i, t := range tasks {
		groups[i] = protocol.DaemonHostTask{
			TaskID:          t.TaskID,
			WorkspaceID:     t.WorkspaceID,
			IssueID:         t.IssueID,
			IssueIdentifier: t.IssueIdentifier,
			AgentName:       t.AgentName,
		}
	}
	var stale protocol.DaemonHostProcs
	var staleTop *procInfo

	for i := range procs {
		p := &procs[i]
		cpu := 0.0
		if prev, seen := prevTicks[p.key]; seen && cpuDelta > 0 && p.ticks >= prev {
			cpu = 100 * float64(p.ticks-prev) / float64(cpuDelta)
		}
		owner := -1
		for j, t := range tasks {
			if pathWithin(p.cwd, t.RootDir) {
				owner = j
				break
			}
		}
		switch {
		case owner >= 0:
			addProc(&groups[owner].DaemonHostProcs, &tops[owner], p, cpu)
		case p.ageS >= staleProcAge:
			addProc(&stale, &staleTop, p, cpu)
		}
	}

	for i := range groups {
		setTop(&groups[i].DaemonHostProcs, tops[i])
	}
	// Largest footprint first; a task with no processes found keeps its
	// place at the end so every running task is still listed.
	sort.SliceStable(groups, func(a, b int) bool { return groups[a].RSSKB > groups[b].RSSKB })

	if stale.Procs == 0 {
		return groups, nil
	}
	setTop(&stale, staleTop)
	return groups, &stale
}

func addProc(g *protocol.DaemonHostProcs, top **procInfo, p *procInfo, cpu float64) {
	g.Procs++
	g.RSSKB += p.rssKB
	g.CPUPct += cpu
	if *top == nil || p.rssKB > (*top).rssKB {
		*top = p
	}
}

func setTop(g *protocol.DaemonHostProcs, top *procInfo) {
	if top == nil {
		return
	}
	g.TopCmd = sanitizeCmdline(top.argv)
	g.TopCmdAgeS = top.ageS
}

// pathWithin reports whether path is root or below it, by path segment.
func pathWithin(path, root string) bool {
	if root == "" {
		return false
	}
	root = filepath.Clean(root)
	path = filepath.Clean(path)
	return path == root || strings.HasPrefix(path, root+string(filepath.Separator))
}

// readProcStat returns utime+stime and the start time from /proc/<pid>/stat.
// The comm field can contain spaces and ")", so fields are counted from the
// last ")".
func readProcStat(path string) (ticks, start uint64, ok bool) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return 0, 0, false
	}
	i := strings.LastIndexByte(string(raw), ')')
	if i < 0 {
		return 0, 0, false
	}
	// fields[0] is field 3 (state), so field N is fields[N-3].
	fields := strings.Fields(string(raw[i+1:]))
	if len(fields) < 20 {
		return 0, 0, false
	}
	utime, err1 := strconv.ParseUint(fields[11], 10, 64)
	stime, err2 := strconv.ParseUint(fields[12], 10, 64)
	start, err3 := strconv.ParseUint(fields[19], 10, 64)
	if err1 != nil || err2 != nil || err3 != nil {
		return 0, 0, false
	}
	return utime + stime, start, true
}

func readStatmRSS(path string) (uint64, bool) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return 0, false
	}
	fields := strings.Fields(string(raw))
	if len(fields) < 2 {
		return 0, false
	}
	v, err := strconv.ParseUint(fields[1], 10, 64)
	return v, err == nil
}

func readUptime(path string) (float64, bool) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return 0, false
	}
	fields := strings.Fields(string(raw))
	if len(fields) == 0 {
		return 0, false
	}
	v, err := strconv.ParseFloat(fields[0], 64)
	return v, err == nil
}

var (
	interpreters = map[string]bool{"node": true, "bun": true, "deno": true, "python": true, "python3": true, "ruby": true, "sh": true, "bash": true}
	// Short lowercase words such as "build", "run" or "stream-json" say what a
	// process is doing; anything else (paths, ids, tokens, prompts) is dropped.
	cmdWord = regexp.MustCompile(`^[a-z][a-z0-9:-]{0,19}$`)
	// A single-dash flag is one letter, so a value glued to it ("-pSecret")
	// is dropped with it; a double-dash flag is a plain name.
	cmdFlag = regexp.MustCompile(`^(-[A-Za-z]|--[A-Za-z][A-Za-z0-9-]{0,23})$`)
)

const maxCmdTokens = 4

// sanitizeCmdline reduces argv to what identifies the work without exposing
// argument values: the executable's base name, an interpreter's script base
// name, then up to maxCmdTokens distinct flags (with any "=value" removed)
// and short subcommand words.
func sanitizeCmdline(argv []string) string {
	if len(argv) == 0 || argv[0] == "" {
		return ""
	}
	exe := filepath.Base(argv[0])
	parts := []string{exe}
	rest := argv[1:]
	if interpreters[exe] && len(rest) > 0 && !strings.HasPrefix(rest[0], "-") {
		parts = append(parts, filepath.Base(rest[0]))
		rest = rest[1:]
	}
	seen := make(map[string]bool)
	tokens := 0
	for _, arg := range rest {
		if tokens == maxCmdTokens {
			break
		}
		tok := ""
		switch {
		case strings.HasPrefix(arg, "-"):
			if flag, _, _ := strings.Cut(arg, "="); cmdFlag.MatchString(flag) {
				tok = flag
			}
		case cmdWord.MatchString(arg):
			tok = arg
		}
		if tok == "" || seen[tok] {
			continue
		}
		seen[tok] = true
		parts = append(parts, tok)
		tokens++
	}
	return strings.Join(parts, " ")
}
