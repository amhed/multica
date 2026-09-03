// @vitest-environment jsdom

// Block folding rules live in agent-window-conversation.test.ts. This suite
// keeps the wiring: bubbles and blocks render, the composer is disabled while
// running and posts a comment otherwise.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { I18nProvider } from "@multica/core/i18n/react";
import enCommon from "../../locales/en/common.json";
import enAgents from "../../locales/en/agents.json";
import type { AgentTask } from "@multica/core/types";

const TEST_RESOURCES = { en: { common: enCommon, agents: enAgents } };

const mutate = vi.fn();
vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("@multica/core/api", () => ({ api: { getBaseUrl: () => "http://127.0.0.1:8080" } }));
vi.mock("@multica/core/issues", () => ({
  issueDetailOptions: (wsId: string, id: string) => ({ queryKey: ["issues", wsId, "detail", id] }),
  useCreateComment: () => ({ mutate, isPending: false }),
}));
vi.mock("../../common/actor-avatar", () => ({ ActorAvatar: () => <span /> }));
vi.mock("../../common/task-transcript/transcript-button", () => ({ TranscriptButton: () => <button>transcript</button> }));

const mockMessages = vi.hoisted(() => ({ current: [] as unknown[] }));
vi.mock("@tanstack/react-query", () => ({
  queryOptions: (o: unknown) => o,
  useQuery: (opts: { queryKey: readonly unknown[] }) => {
    const [root, , marker] = opts.queryKey;
    if (root === "workspaces" && marker === "agents") return { data: [{ id: "a1", name: "Codex" }] };
    if (root === "issues" && marker === "detail") return { data: { id: "i1", identifier: "MUL-1", title: "Add flag" } };
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
    trigger_summary: "Please add the flag",
    ...over,
  } as AgentTask;
}

function renderWindow(t: AgentTask | null, onClose = vi.fn()) {
  return render(
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      <AgentWindow wsId="ws-1" task={t} onClose={onClose} />
    </I18nProvider>,
  );
}

describe("AgentWindow", () => {
  beforeEach(() => {
    mutate.mockReset();
    mockMessages.current = [
      { seq: 1, type: "text", content: "Reading the list command." },
      { seq: 2, type: "tool_use", tool: "Edit", input: { file_path: "a.go" } },
      { seq: 3, type: "tool_use", tool: "Bash", input: { command: "go test ./..." } },
      { seq: 4, type: "tool_result", output: "ok" },
    ];
  });
  afterEach(cleanup);

  it("renders the trigger, agent text, and folded blocks", () => {
    renderWindow(task({}));
    expect(screen.getByText("Please add the flag")).toBeTruthy();
    expect(screen.getByText("Reading the list command.")).toBeTruthy();
    expect(screen.getByText("1 file changed")).toBeTruthy();
    expect(screen.getByText("go test ./...")).toBeTruthy();
  });

  it("disables the composer while the task runs", () => {
    renderWindow(task({ status: "running" }));
    expect(screen.getByRole("textbox")).toHaveProperty("disabled", true);
    expect(screen.getByText("The agent picks this up after its current run.")).toBeTruthy();
  });

  it("posts a comment when the task is finished", () => {
    renderWindow(task({ status: "completed", completed_at: "2026-09-03T10:30:00Z" }));
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "Every run, please." } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(mutate).toHaveBeenCalledWith({ content: "Every run, please." }, expect.anything());
  });

  it("renders nothing when task is null", () => {
    renderWindow(null);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("clips a long command so it doesn't overflow the card", () => {
    const longCommand = `go test ./... -run TestSomethingVeryLongName${"x".repeat(180)}`;
    mockMessages.current = [
      { seq: 1, type: "tool_use", tool: "Bash", input: { command: longCommand } },
      { seq: 2, type: "tool_result", output: "ok" },
    ];
    const { baseElement } = renderWindow(task({}));
    const span = baseElement.querySelector(".font-mono.text-caption");
    expect(span).toBeTruthy();
    expect(span?.className).toContain("truncate");
    expect(span?.className).toContain("min-w-0");
  });

  it("resets the composer draft when the window shows a different task", () => {
    const taskA = task({ id: "t1", status: "completed", completed_at: "2026-09-03T10:30:00Z" });
    const taskB = task({ id: "t2", status: "completed", completed_at: "2026-09-03T11:00:00Z" });
    const { rerender } = renderWindow(taskA);
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "Draft for task A" } });
    expect(screen.getByRole("textbox")).toHaveProperty("value", "Draft for task A");

    rerender(
      <I18nProvider locale="en" resources={TEST_RESOURCES}>
        <AgentWindow wsId="ws-1" task={taskB} onClose={vi.fn()} />
      </I18nProvider>,
    );
    expect(screen.getByRole("textbox")).toHaveProperty("value", "");
  });
});
