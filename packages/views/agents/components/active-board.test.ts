// @vitest-environment node
import { describe, it, expect } from "vitest";
import type { AgentTask } from "@multica/core/types";
import { selectActiveTasks, taskSummary } from "./active-board";

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
