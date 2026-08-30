// @vitest-environment jsdom

// Selection/sort/summary rules are covered in active-board.test.ts; this suite
// keeps the wiring: one card per active task, the issue link, the summary text
// and the empty state.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { I18nProvider } from "@multica/core/i18n/react";
import enCommon from "../../locales/en/common.json";
import enAgents from "../../locales/en/agents.json";

const TEST_RESOURCES = { en: { common: enCommon, agents: enAgents } };

vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("@multica/core/paths", () => ({
  useWorkspacePaths: () => ({ issueDetail: (id: string) => `/acme/issues/${id}` }),
}));
vi.mock("@multica/core/api", () => ({
  api: { getBaseUrl: () => "http://127.0.0.1:8080" },
}));
vi.mock("../../navigation", () => ({
  AppLink: ({ href, children, ...rest }: { href: string; children: React.ReactNode; [k: string]: unknown }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));
vi.mock("../../common/actor-avatar", () => ({ ActorAvatar: () => <span /> }));
vi.mock("../../common/task-transcript/transcript-button", () => ({
  TranscriptButton: () => <button>transcript</button>,
}));

const mockAgents = vi.hoisted(() => ({ current: [] as unknown[] }));
const mockSnapshot = vi.hoisted(() => ({ current: [] as unknown[] }));
const mockIssues = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
const mockMessages = vi.hoisted(() => ({ current: [] as unknown[] }));

vi.mock("@tanstack/react-query", () => ({
  queryOptions: (o: unknown) => o,
  useQuery: (opts: { queryKey: readonly unknown[]; enabled?: boolean }) => {
    const [root, , marker, id] = opts.queryKey;
    if (root === "workspaces" && marker === "agents") return { data: mockAgents.current, isLoading: false };
    if (root === "workspaces" && marker === "agent-task-snapshot") return { data: mockSnapshot.current, isLoading: false };
    if (root === "issues" && marker === "detail") {
      return { data: opts.enabled ? mockIssues.current[id as string] : undefined, isLoading: false };
    }
    if (root === "task-messages") return { data: opts.enabled ? mockMessages.current : [], isLoading: false };
    return { data: undefined, isLoading: false };
  },
}));

import { ActiveBoardPage } from "./active-board-page";

function task(over: Record<string, unknown>) {
  return {
    id: "task-1",
    agent_id: "agent-1",
    runtime_id: "rt-1",
    issue_id: "",
    workspace_id: "ws-1",
    status: "running",
    priority: 0,
    dispatched_at: null,
    started_at: "2026-08-29T10:00:00Z",
    completed_at: null,
    result: null,
    error: null,
    created_at: "2026-08-29T10:00:00Z",
    ...over,
  };
}

function renderPage() {
  return render(
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      <ActiveBoardPage />
    </I18nProvider>,
  );
}

describe("ActiveBoardPage", () => {
  beforeEach(() => {
    cleanup();
    mockAgents.current = [
      { id: "agent-1", name: "Squirtle", avatar_url: null },
      { id: "agent-2", name: "Bulbasaur", avatar_url: null },
    ];
    mockSnapshot.current = [];
    mockIssues.current = {};
    mockMessages.current = [];
  });

  it("shows the empty state when no task is active", () => {
    mockSnapshot.current = [task({ status: "completed" })];
    renderPage();
    expect(screen.getByText("No agents are working right now.")).toBeInTheDocument();
  });

  it("renders a card per active task with agent, issue, summary and activity peek", () => {
    mockSnapshot.current = [
      task({ id: "11111111-1111-4111-8111-111111111111", issue_id: "issue-1", handoff_note: "Ship the squad palette" }),
      task({ id: "t2", agent_id: "agent-2", status: "queued", kind: "direct" }),
      task({ id: "t3", status: "completed" }),
    ];
    mockIssues.current = { "issue-1": { id: "issue-1", identifier: "MUL-42", title: "Palette" } };
    mockMessages.current = [
      { seq: 1, type: "tool_use", tool: "Edit", input: { file_path: "packages/views/search/search-command.tsx" } },
    ];
    renderPage();

    expect(screen.getByText("Squirtle")).toBeInTheDocument();
    expect(screen.getByText("Bulbasaur")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /MUL-42/ })).toHaveAttribute("href", "/acme/issues/issue-1");
    expect(screen.getByText("Ship the squad palette")).toBeInTheDocument();
    expect(screen.getByText("Direct assignment")).toBeInTheDocument();
    expect(screen.getByText("No linked issue")).toBeInTheDocument();
    expect(screen.getByText("Running")).toBeInTheDocument();
    expect(screen.getByText("Queued")).toBeInTheDocument();
    expect(screen.getByText(/Edit .*search-command\.tsx/)).toBeInTheDocument();
    // Only the two active tasks become cards.
    expect(screen.getAllByRole("button", { name: "transcript" })).toHaveLength(2);
  });
});
