package service

import (
	"context"
	"regexp"
	"strings"
	"time"
)

// TaskSummaryLLM is the slice of the server-internal LLM layer the active-board
// headline needs. *llm.Client satisfies it; tests pass a fake.
type TaskSummaryLLM interface {
	Enabled() bool
	GenerateText(ctx context.Context, model, systemPrompt, userPrompt string) (string, error)
}

const (
	taskSummaryMaxRunes         = 300
	taskSummaryDescriptionRunes = 1500
	taskSummaryTimeout          = 20 * time.Second
)

// taskSummarySystemPrompt is stable across calls so upstream prompt caching
// applies. It asks for a headline a teammate could read at a glance.
const taskSummarySystemPrompt = `You write one-line status headlines for a task board.
Given an issue and the instruction that started an AI agent on it, write what the agent is set to do and why.
Rules:
- One or two sentences, present tense, plain text.
- Under 300 characters.
- No markdown, no quotes, no preamble such as "Summary:".
- Name the concrete change, not the process. Say "Adds a --property flag to issue list" rather than "Works on the issue".
- If the input is unclear, describe the issue title only.`

type taskSummaryInput struct {
	Identifier     string
	Title          string
	Description    string
	TriggerSummary string
	HandoffNote    string
}

// buildTaskSummaryPrompt renders the user prompt. Sections with no content are
// left out entirely rather than sent as empty labels. ok is false when there is
// nothing at all to summarize.
func buildTaskSummaryPrompt(in taskSummaryInput) (string, bool) {
	title := strings.TrimSpace(in.Title)
	desc := truncateRunes(strings.TrimSpace(in.Description), taskSummaryDescriptionRunes)
	trigger := strings.TrimSpace(in.TriggerSummary)
	note := strings.TrimSpace(in.HandoffNote)
	if title == "" && desc == "" && trigger == "" && note == "" {
		return "", false
	}

	var b strings.Builder
	if title != "" {
		b.WriteString("Issue: ")
		if id := strings.TrimSpace(in.Identifier); id != "" {
			b.WriteString(id)
			b.WriteString(" ")
		}
		b.WriteString(title)
		b.WriteString("\n")
	}
	section := func(label, body string) {
		if body == "" {
			return
		}
		b.WriteString("\n")
		b.WriteString(label)
		b.WriteString(":\n")
		b.WriteString(body)
		b.WriteString("\n")
	}
	section("Description", desc)
	section("Trigger", trigger)
	section("Handoff note", note)
	return b.String(), true
}

var (
	summaryWhitespace = regexp.MustCompile(`\s+`)
	summaryBold       = regexp.MustCompile(`\*\*([^*]+)\*\*`)
	summaryCode       = regexp.MustCompile("`([^`]*)`")
	summaryHashPrefix = regexp.MustCompile(`(^|\s)#+\s*`)
	summaryPreamble   = regexp.MustCompile(`(?i)^(summary|headline)\s*:\s*`)
)

// sanitizeTaskSummary turns raw model output into the stored headline: markdown
// stripped, whitespace collapsed, preamble removed, capped at taskSummaryMaxRunes.
func sanitizeTaskSummary(raw string) string {
	s := summaryHashPrefix.ReplaceAllString(raw, "$1")
	s = summaryBold.ReplaceAllString(s, "$1")
	s = summaryCode.ReplaceAllString(s, "$1")
	s = summaryWhitespace.ReplaceAllString(s, " ")
	s = strings.TrimSpace(s)
	s = summaryPreamble.ReplaceAllString(s, "")
	s = strings.Trim(s, `"'`)
	return truncateRunes(strings.TrimSpace(s), taskSummaryMaxRunes)
}

func truncateRunes(s string, max int) string {
	r := []rune(s)
	if len(r) <= max {
		return s
	}
	return string(r[:max])
}
