// @vitest-environment node
import { describe, it, expect } from "vitest";
import type { AgentTask } from "@multica/core/types";
import { activeCounts, groupActiveTasks, isStale, plainSummary, selectActiveTasks, taskSummary } from "./active-board";

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

describe("selectActiveTasks", () => {
  it("drops terminal tasks and orders running before waiting before queued", () => {
    const out = selectActiveTasks([
      task({ id: "done", status: "completed" }),
      task({ id: "queued", status: "queued" }),
      task({ id: "waiting", status: "waiting_local_directory" }),
      task({ id: "failed", status: "failed" }),
      task({ id: "running", status: "running" }),
    ]);
    expect(out.map((t) => t.id)).toEqual(["running", "waiting", "queued"]);
  });

  it("puts the most recently started task first within a status", () => {
    const out = selectActiveTasks([
      task({ id: "old", started_at: "2026-08-29T09:00:00Z" }),
      task({ id: "new", started_at: "2026-08-29T11:00:00Z" }),
    ]);
    expect(out.map((t) => t.id)).toEqual(["new", "old"]);
  });
});

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

describe("groupActiveTasks", () => {
  it("folds same-issue tasks into one group at the first task's position", () => {
    const out = groupActiveTasks([
      task({ id: "a", issue_id: "i1", status: "running" }),
      task({ id: "b", issue_id: "i2", status: "running" }),
      task({ id: "c", issue_id: "i1", status: "queued" }),
      task({ id: "d", issue_id: "" }),
    ]);
    expect(out.map((g) => [g.key, g.tasks.map((t) => t.id)])).toEqual([
      ["i1", ["a", "c"]],
      ["i2", ["b"]],
      ["d", ["d"]],
    ]);
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
