package daemon

import (
	"reflect"
	"testing"
)

func TestReaperCommandDryRun(t *testing.T) {
	got := reaperCommand("/opt/multica/scripts/multica-reap.sh", "dryrun")
	want := []string{"/opt/multica/scripts/multica-reap.sh", "--json"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("dryrun argv = %v, want %v", got, want)
	}
}

func TestReaperCommandApply(t *testing.T) {
	got := reaperCommand("/opt/multica/scripts/multica-reap.sh", "apply")
	want := []string{"/opt/multica/scripts/multica-reap.sh", "--json", "--apply"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("apply argv = %v, want %v", got, want)
	}
}

func TestReaperCommandNeverIncludesRuntime(t *testing.T) {
	for _, mode := range []string{"dryrun", "apply"} {
		for _, arg := range reaperCommand("s", mode) {
			if arg == "--include-runtime" {
				t.Fatalf("mode %q must never pass --include-runtime", mode)
			}
		}
	}
}
