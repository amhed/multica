// @vitest-environment jsdom

// Selection/sort/summary rules are covered in active-board.test.ts; this suite
// keeps the wiring: one card per board task, waiting-first order, the ?task=
// param opening/closing the agent window, and the empty state.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { I18nProvider } from "@multica/core/i18n/react";
import enCommon from "../../locales/en/common.json";
import enAgents from "../../locales/en/agents.json";

const TEST_RESOURCES = { en: { common: enCommon, agents: enAgents } };

vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("@multica/core/paths", () => ({
  useWorkspacePaths: () => ({
    issueDetail: (id: string) => `/acme/issues/${id}`,
  }),
}));
const cancelTaskById = vi.hoisted(() => vi.fn());
vi.mock("@multica/core/api", () => ({
  api: { getBaseUrl: () => "http://127.0.0.1:8080", cancelTaskById },
}));
const navState = vi.hoisted(() => ({
  search: new URLSearchParams(),
  replace: vi.fn(),
}));
vi.mock("../../navigation", () => ({
  AppLink: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
    [k: string]: unknown;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
  useNavigation: () => ({
    pathname: "/acme/active",
    searchParams: navState.search,
    replace: navState.replace,
    push: vi.fn(),
    back: vi.fn(),
    hash: "",
  }),
}));
vi.mock("./agent-window", () => ({
  AgentWindow: ({ task }: { task: { id: string } | null }) =>
    task ? <div role="dialog">window:{task.id}</div> : null,
}));
vi.mock("../../common/actor-avatar", () => ({ ActorAvatar: () => <span /> }));
vi.mock("../../common/task-transcript/transcript-button", () => ({
  TranscriptButton: () => <button>transcript</button>,
}));

const mockAgents = vi.hoisted(() => ({ current: [] as unknown[] }));
const mockSnapshot = vi.hoisted(() => ({ current: [] as unknown[] }));
const mockIssues = vi.hoisted(() => ({
  current: {} as Record<string, unknown>,
}));
const mockMessages = vi.hoisted(() => ({ current: [] as unknown[] }));

vi.mock("@tanstack/react-query", () => ({
  queryOptions: (o: unknown) => o,
  useQuery: (opts: { queryKey: readonly unknown[]; enabled?: boolean }) => {
    const [root, , marker, id] = opts.queryKey;
    if (root === "workspaces" && marker === "agents")
      return { data: mockAgents.current, isLoading: false };
    if (root === "workspaces" && marker === "agent-task-snapshot")
      return { data: mockSnapshot.current, isLoading: false };
    if (root === "issues" && marker === "detail") {
      return {
        data: opts.enabled ? mockIssues.current[id as string] : undefined,
        isLoading: false,
      };
    }
    if (root === "task-messages")
      return {
        data: opts.enabled ? mockMessages.current : [],
        isLoading: false,
      };
    return { data: undefined, isLoading: false };
  },
  useQueries: ({
    queries,
    combine,
  }: {
    queries: { queryKey: readonly unknown[]; enabled?: boolean }[];
    combine?: (results: { data: unknown[]; isLoading: boolean }[]) => unknown;
  }) => {
    const results = queries.map((q) => ({
      data: q.enabled === false ? [] : mockMessages.current,
      isLoading: false,
    }));
    return combine ? combine(results) : results;
  },
  useMutation: (opts: { mutationFn: (v: unknown) => unknown }) => ({
    mutate: (v: unknown) => opts.mutationFn(v),
  }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

import { ActiveBoardPage } from "./active-board-page";

function renderPage() {
  return render(
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      <ActiveBoardPage />
    </I18nProvider>,
  );
}

const running = {
  id: "11111111-1111-4111-8111-111111111111",
  agent_id: "a1",
  runtime_id: "r",
  issue_id: "i1",
  status: "running",
  priority: 0,
  dispatched_at: null,
  started_at: "2026-09-03T10:00:00Z",
  completed_at: null,
  result: null,
  error: null,
  created_at: "2026-09-03T09:59:00Z",
  pstack_summary: "Adds a --property flag to issue list.",
};
const finished = {
  ...running,
  id: "22222222-2222-4222-8222-222222222222",
  agent_id: "a2",
  issue_id: "i2",
  status: "completed",
  completed_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
  pstack_summary: null,
  trigger_summary: "Decide the membership rule",
};

describe("ActiveBoardPage", () => {
  beforeEach(() => {
    mockAgents.current = [
      { id: "a1", name: "Codex" },
      { id: "a2", name: "Claude" },
    ];
    mockIssues.current = {
      i1: { id: "i1", identifier: "MUL-1", title: "Flag" },
      i2: { id: "i2", identifier: "MUL-2", title: "Auth" },
    };
    mockMessages.current = [
      { seq: 1, type: "text", content: "Every run, or only at creation?" },
    ];
    mockSnapshot.current = [running, finished];
    navState.search = new URLSearchParams();
    navState.replace.mockReset();
    cancelTaskById.mockReset();
  });
  afterEach(cleanup);

  it("renders one card per task with the generated headline and a waiting card first", () => {
    renderPage();
    // Each card's headline button carries its own accessible name (the
    // headline text), not the agent name, so the waiting-first order is
    // asserted on which headline comes first rather than on agent name.
    const headlines = screen.getAllByRole("button", {
      name: /Adds a --property flag to issue list\.|Decide the membership rule/,
    });
    expect(headlines[0]).toHaveAccessibleName("Decide the membership rule");
    expect(screen.getByText("Waiting for you")).toBeTruthy();
    expect(
      screen.getByText("Adds a --property flag to issue list."),
    ).toBeTruthy();
  });

  it("opens the window through the task search param", () => {
    renderPage();
    fireEvent.click(screen.getByText("Adds a --property flag to issue list."));
    expect(navState.replace).toHaveBeenCalledWith(
      "/acme/active?task=11111111-1111-4111-8111-111111111111",
    );
  });

  it("shows the window when the param is present and clears an unknown one", () => {
    navState.search = new URLSearchParams(
      "task=11111111-1111-4111-8111-111111111111",
    );
    renderPage();
    expect(screen.getByRole("dialog").textContent).toBe(
      "window:11111111-1111-4111-8111-111111111111",
    );
    cleanup();
    navState.search = new URLSearchParams("task=missing");
    renderPage();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(navState.replace).toHaveBeenCalledWith("/acme/active");
  });

  it("shows the empty state with no tasks", () => {
    mockSnapshot.current = [];
    renderPage();
    expect(screen.getByText("No agents are working right now.")).toBeTruthy();
  });

  it("opens the window for a ?task= completed task before its messages resolve", () => {
    // Regression for MUL-6975: a completed task with no steps yet has no
    // `waiting` card (sortBoardCards drops it), so `openTask` must resolve
    // from the snapshot-derived candidate list, not from `cards`, or the
    // clearing effect removes the param before the window can open.
    const recentNoSteps = {
      ...finished,
      id: "33333333-3333-4333-8333-333333333333",
      pstack_summary: null,
    };
    mockSnapshot.current = [recentNoSteps];
    mockMessages.current = [];
    navState.search = new URLSearchParams(`task=${recentNoSteps.id}`);
    renderPage();
    expect(screen.getByRole("dialog").textContent).toBe(
      `window:${recentNoSteps.id}`,
    );
    expect(navState.replace).not.toHaveBeenCalled();
  });

  it("stops a running task without opening the window", () => {
    renderPage();
    fireEvent.click(screen.getByText("Stop"));
    expect(cancelTaskById).toHaveBeenCalledWith(running.id);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(navState.replace).not.toHaveBeenCalled();
  });
});
