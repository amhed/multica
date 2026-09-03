// @vitest-environment node
import { describe, it, expect } from "vitest";
import type { AgentTask } from "@multica/core/types";
import type { TraceStep } from "../../common/task-transcript/build-steps";
import {
  activeCounts,
  describeStep,
  isStale,
  isWaitingForInput,
  plainSummary,
  RECENT_TERMINAL_MS,
  selectBoardTasks,
  sortBoardCards,
  taskSummary,
} from "./active-board";

function task(over: Partial<AgentTask>): AgentTask {
  return {
    id: "t",
    agent_id: "a",
    runtime_id: "r",
    issue_id: "",
    workspace_id: "ws",
    status: "running",
    priority: 0,
    dispatched_at: null,
    started_at: null,
    completed_at: null,
    result: null,
    error: null,
    created_at: "2026-08-29T10:00:00Z",
    ...over,
  } as AgentTask;
}

describe("taskSummary", () => {
  it("prefers the handoff note, then the trigger summary", () => {
    expect(taskSummary(task({ handoff_note: "Fix it", trigger_summary: "cmt" }))).toEqual({
      source: "handoff_note",
      text: "Fix it",
    });
    expect(taskSummary(task({ handoff_note: "  ", trigger_summary: "cmt" }))).toEqual({
      source: "trigger_summary",
      text: "cmt",
    });
  });

  it("falls back to the task kind when no text is available", () => {
    expect(taskSummary(task({ kind: "direct" }))).toEqual({ source: "kind", kind: "direct" });
    expect(taskSummary(task({}))).toEqual({ source: "kind", kind: "unknown" });
  });
});

describe("plainSummary", () => {
  it("renders mention, link and code markdown as prose", () => {
    expect(
      plainSummary(
        "[@Grok Senior Dev](mention://agent/1a75) — PR [#24](https://github.com/x/y/pull/24) carries `LAP-33`\n\nand  more",
      ),
    ).toBe("@Grok Senior Dev — PR #24 carries LAP-33 and more");
  });
});

describe("taskSummary with pstack_summary", () => {
  it("prefers the generated headline over the handoff note and trigger", () => {
    expect(
      taskSummary(task({ pstack_summary: "Adds a flag.", handoff_note: "note", trigger_summary: "trigger" })),
    ).toEqual({ source: "pstack_summary", text: "Adds a flag." });
  });

  it("ignores a blank or missing headline", () => {
    expect(taskSummary(task({ pstack_summary: "   ", handoff_note: "note" }))).toEqual({
      source: "handoff_note",
      text: "note",
    });
    expect(taskSummary(task({ pstack_summary: null, trigger_summary: "trigger" }))).toEqual({
      source: "trigger_summary",
      text: "trigger",
    });
  });
});

describe("activeCounts / isStale", () => {
  it("splits running from everything else", () => {
    expect(
      activeCounts([task({ status: "running" }), task({ status: "queued" }), task({ status: "dispatched" })]),
    ).toEqual({ running: 1, waiting: 2 });
  });

  it("flags activity older than the threshold", () => {
    const now = Date.parse("2026-08-29T10:20:00Z");
    expect(isStale("2026-08-29T10:15:00Z", now)).toBe(false);
    expect(isStale("2026-08-29T10:05:00Z", now)).toBe(true);
  });
});

function callStep(tool: string, input: Record<string, unknown>, seq = 1): TraceStep {
  return {
    kind: "call",
    seq,
    tool,
    call: { seq, type: "tool_use", tool, input } as never,
    startedAt: "2026-09-03T10:00:00Z",
  };
}

function textStep(content: string, seq = 2): TraceStep {
  return { kind: "text", seq, item: { seq, type: "text", content } as never, startedAt: "2026-09-03T10:00:00Z" };
}

describe("describeStep", () => {
  it("maps file tools to edited/read with the path as object", () => {
    expect(describeStep(callStep("Edit", { file_path: "server/internal/cli/issue_list.go" }))).toEqual({
      verb: "edited",
      object: "server/internal/cli/issue_list.go",
      tone: "normal",
    });
    expect(describeStep(callStep("Write", { file_path: "a.ts" })).verb).toBe("edited");
    expect(describeStep(callStep("Read", { file_path: "a.ts" })).verb).toBe("read");
  });

  it("treats any call with a command string as ran", () => {
    expect(describeStep(callStep("Bash", { command: "go test ./internal/cli" }))).toEqual({
      verb: "ran",
      object: "go test ./internal/cli",
      tone: "normal",
    });
    expect(describeStep(callStep("shell", { command: "pnpm test" })).verb).toBe("ran");
  });

  it("maps search tools to searched", () => {
    expect(describeStep(callStep("Grep", { pattern: "pstack" })).verb).toBe("searched");
    expect(describeStep(callStep("WebSearch", { query: "sqlc narg" })).object).toBe("sqlc narg");
  });

  it("falls back to used with the tool name for unknown tools", () => {
    expect(describeStep(callStep("mcp__linear__get_issue", { id: "MUL-1" }))).toEqual({
      verb: "used",
      object: "mcp__linear__get_issue MUL-1",
      tone: "normal",
    });
  });

  it("renders text as said and errors with the error tone", () => {
    expect(describeStep(textStep("Fixing the sort **now**"))).toEqual({
      verb: "said",
      object: "Fixing the sort now",
      tone: "normal",
    });
    const err: TraceStep = { kind: "error", seq: 3, item: { seq: 3, type: "error", content: "boom" } as never };
    expect(describeStep(err)).toEqual({ verb: "errored", object: "boom", tone: "error" });
  });
});

describe("isWaitingForInput", () => {
  const now = Date.parse("2026-09-03T12:00:00Z");
  const done = task({ status: "completed", completed_at: "2026-09-03T11:30:00Z" });

  it("is true for a recently completed task whose last text asks a question", () => {
    expect(
      isWaitingForInput(done, [callStep("Edit", {}), textStep("Re-check on every run, or only at creation?")], now),
    ).toBe(true);
  });

  it("is false when the last text is not a question", () => {
    expect(isWaitingForInput(done, [textStep("Done, PR is open.")], now)).toBe(false);
  });

  it("is false past the one hour cut-off", () => {
    const old = task({ status: "completed", completed_at: new Date(now - RECENT_TERMINAL_MS - 1000).toISOString() });
    expect(isWaitingForInput(old, [textStep("Which one?")], now)).toBe(false);
  });

  it("is false for running or failed tasks and when there is no text", () => {
    expect(isWaitingForInput(task({ status: "running" }), [textStep("Which one?")], now)).toBe(false);
    expect(isWaitingForInput(task({ status: "failed", completed_at: "2026-09-03T11:59:00Z" }), [textStep("Which one?")], now)).toBe(
      false,
    );
    expect(isWaitingForInput(done, [callStep("Edit", {})], now)).toBe(false);
  });
});

describe("selectBoardTasks and sortBoardCards", () => {
  const now = Date.parse("2026-09-03T12:00:00Z");

  it("keeps active tasks and recently completed ones, drops old terminal tasks", () => {
    const snapshot = [
      task({ id: "run", status: "running" }),
      task({ id: "recent", status: "completed", completed_at: "2026-09-03T11:50:00Z" }),
      task({ id: "old", status: "completed", completed_at: "2026-09-03T09:00:00Z" }),
      task({ id: "cancelled", status: "cancelled", completed_at: "2026-09-03T11:59:00Z" }),
    ];
    expect(selectBoardTasks(snapshot, now).map((t) => t.id)).toEqual(["run", "recent"]);
  });

  it("orders waiting, then running by activity, then queued; drops non-waiting terminal tasks", () => {
    const cards = [
      { task: task({ id: "q", status: "queued", created_at: "2026-09-03T11:00:00Z" }), waiting: false, lastActivityAt: null },
      { task: task({ id: "r-old", status: "running" }), waiting: false, lastActivityAt: "2026-09-03T11:10:00Z" },
      { task: task({ id: "done", status: "completed", completed_at: "2026-09-03T11:55:00Z" }), waiting: false, lastActivityAt: null },
      { task: task({ id: "w", status: "completed", completed_at: "2026-09-03T11:50:00Z" }), waiting: true, lastActivityAt: null },
      { task: task({ id: "r-new", status: "running" }), waiting: false, lastActivityAt: "2026-09-03T11:59:00Z" },
    ];
    expect(sortBoardCards(cards).map((c) => c.task.id)).toEqual(["w", "r-new", "r-old", "q"]);
  });
});
