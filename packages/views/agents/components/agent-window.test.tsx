// @vitest-environment jsdom

// The window is a thin wrapper over the shared transcript dialog; this suite
// keeps the wiring: the dialog gets the task's timeline, the live flag follows
// the status, it opens at the end, and closing it reports back.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import type { AgentTask } from "@multica/core/types";

const dialogProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
vi.mock("../../common/task-transcript/agent-transcript-dialog", () => ({
  AgentTranscriptDialog: (props: Record<string, unknown>) => {
    dialogProps.current = props;
    return (
      <div role="dialog">
        <button onClick={() => (props.onOpenChange as (o: boolean) => void)(false)}>close</button>
      </div>
    );
  },
}));

const mockMessages = vi.hoisted(() => ({ current: [] as unknown[] }));
vi.mock("@tanstack/react-query", () => ({
  queryOptions: (o: unknown) => o,
  useQuery: (opts: { queryKey: readonly unknown[] }) => {
    const [root, , marker] = opts.queryKey;
    if (root === "workspaces" && marker === "agents") return { data: [{ id: "a1", name: "Codex" }] };
    if (root === "task-messages") return { data: mockMessages.current };
    return { data: undefined };
  },
}));

import { AgentWindow } from "./agent-window";

function task(over: Partial<AgentTask>): AgentTask {
  return {
    id: "t1",
    agent_id: "a1",
    runtime_id: "r1",
    issue_id: "i1",
    status: "running",
    priority: 0,
    dispatched_at: null,
    started_at: "2026-09-03T10:00:00Z",
    completed_at: null,
    result: null,
    error: null,
    created_at: "2026-09-03T09:59:00Z",
    ...over,
  } as AgentTask;
}

describe("AgentWindow", () => {
  beforeEach(() => {
    dialogProps.current = null;
    mockMessages.current = [
      { seq: 1, type: "text", content: "Reading the list command." },
      { seq: 2, type: "tool_use", tool: "Edit", input: { file_path: "a.go" } },
    ];
  });
  afterEach(cleanup);

  it("shows the transcript dialog with the task's timeline, live while running", () => {
    render(<AgentWindow wsId="ws-1" task={task({})} onClose={vi.fn()} />);
    const props = dialogProps.current!;
    expect(props.open).toBe(true);
    expect(props.agentName).toBe("Codex");
    expect(props.isLive).toBe(true);
    expect(props.startAtEnd).toBe(true);
    expect((props.items as unknown[]).length).toBe(2);
  });

  it("is not live once the task has finished", () => {
    render(
      <AgentWindow
        wsId="ws-1"
        task={task({ status: "completed", completed_at: "2026-09-03T10:30:00Z" })}
        onClose={vi.fn()}
      />,
    );
    expect(dialogProps.current!.isLive).toBe(false);
  });

  it("reports close when the dialog is dismissed", () => {
    const onClose = vi.fn();
    render(<AgentWindow wsId="ws-1" task={task({})} onClose={onClose} />);
    fireEvent.click(screen.getByText("close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("renders nothing when task is null", () => {
    render(<AgentWindow wsId="ws-1" task={null} onClose={vi.fn()} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
