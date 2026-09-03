package service

import (
	"strings"
	"testing"
)

func TestBuildTaskSummaryPromptIncludesEveryPresentPiece(t *testing.T) {
	prompt, ok := buildTaskSummaryPrompt(taskSummaryInput{
		Identifier:     "MUL-6771",
		Title:          "Filter issue list by custom property",
		Description:    "Add a --property flag.",
		TriggerSummary: "Please match how --label works.",
		HandoffNote:    "Keep it to the CLI package.",
	})
	if !ok {
		t.Fatal("expected a prompt")
	}
	for _, want := range []string{
		"Issue: MUL-6771 Filter issue list by custom property",
		"Description:\nAdd a --property flag.",
		"Trigger:\nPlease match how --label works.",
		"Handoff note:\nKeep it to the CLI package.",
	} {
		if !strings.Contains(prompt, want) {
			t.Errorf("prompt missing %q:\n%s", want, prompt)
		}
	}
}

func TestBuildTaskSummaryPromptOmitsEmptyLabels(t *testing.T) {
	prompt, ok := buildTaskSummaryPrompt(taskSummaryInput{Identifier: "MUL-1", Title: "Only a title"})
	if !ok {
		t.Fatal("a title alone is enough to summarize")
	}
	for _, label := range []string{"Description:", "Trigger:", "Handoff note:"} {
		if strings.Contains(prompt, label) {
			t.Errorf("empty section %q must be omitted:\n%s", label, prompt)
		}
	}
}

func TestBuildTaskSummaryPromptRefusesEmptyInput(t *testing.T) {
	if _, ok := buildTaskSummaryPrompt(taskSummaryInput{}); ok {
		t.Fatal("nothing to summarize must return ok=false")
	}
}

func TestBuildTaskSummaryPromptTruncatesDescription(t *testing.T) {
	long := strings.Repeat("é", 2000)
	prompt, _ := buildTaskSummaryPrompt(taskSummaryInput{Title: "t", Description: long})
	if strings.Count(prompt, "é") != taskSummaryDescriptionRunes {
		t.Fatalf("description must be cut at %d runes, got %d", taskSummaryDescriptionRunes, strings.Count(prompt, "é"))
	}
}

func TestSanitizeTaskSummary(t *testing.T) {
	cases := map[string]string{
		"  Adding   a flag.\n\nThen tests.  ": "Adding a flag. Then tests.",
		"**Bold** and `code` and # heading":   "Bold and code and heading",
		"Summary: Adding a flag.":             "Adding a flag.",
		"\n\t ":                               "",
	}
	for in, want := range cases {
		if got := sanitizeTaskSummary(in); got != want {
			t.Errorf("sanitizeTaskSummary(%q) = %q, want %q", in, got, want)
		}
	}
	long := strings.Repeat("a", 400)
	if got := sanitizeTaskSummary(long); len([]rune(got)) != taskSummaryMaxRunes {
		t.Fatalf("must cap at %d runes, got %d", taskSummaryMaxRunes, len([]rune(got)))
	}
}
